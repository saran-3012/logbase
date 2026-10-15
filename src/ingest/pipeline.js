'use strict';

const db = require('../db/database');
const { InsertQuery, UpdateQuery, eq, rawExpr } = require('../db/query');

/**
 * Transport-agnostic ingestion pipeline.
 *
 * Both the HTTP route (src/routes/logs.js) and the UDP listener
 * (src/ingest/listenerManager.js) funnel through storeEvents(), so insertion
 * semantics, normalisation, and collector counters stay identical regardless
 * of how the events arrived.
 */

/**
 * Normalise a single raw event object into DB-ready log fields.
 * Recognised aliases: app/app_name/source, level/severity, message/msg.
 * Everything else is retained under metadata; `raw` keeps the original object.
 */
function normaliseEntry(entry) {
  const appName = String(entry.app || entry.app_name || entry.source || 'unknown').slice(0, 128);
  const level   = String(entry.level || entry.severity || 'info').toLowerCase().slice(0, 32);
  const message = String(entry.message || entry.msg || '').slice(0, 8192);
  const { app, app_name, source, level: _l, severity: _s, message: _m, msg: _msg, ...rest } = entry;
  return { appName, level, message, metadata: JSON.stringify(rest), raw: JSON.stringify(entry) };
}

/**
 * Persist a batch of events and update the collector's counters atomically.
 *
 * @param {object}   target
 * @param {number}   target.userId
 * @param {number}   target.collectorId
 * @param {number}  [target.packets=1]   — datagrams/requests represented by this batch
 * @param {number}  [target.rejected=0]  — events discarded during parsing
 * @param {object[]} events
 * @returns {Promise<{ inserted: number }>}
 */
async function storeEvents({ userId, collectorId, packets = 1, rejected = 0 }, events) {
  if (!Array.isArray(events) || events.length === 0) {
    return { inserted: 0 };
  }

  await db.transaction(async (ctx) => {
    for (const entry of events) {
      const { appName, level, message, metadata, raw } = normaliseEntry(entry);
      await ctx.query(
        new InsertQuery('logs').values({
          user_id:      userId,
          collector_id: collectorId,
          app_name:     appName,
          level,
          message,
          metadata,
          raw,
        })
      );
    }

    if (collectorId != null) {
      await ctx.query(
        new UpdateQuery('collectors')
          .set({
            events_received:  rawExpr(`events_received + ${Number(events.length) | 0}`),
            packets_received: rawExpr(`packets_received + ${Number(packets)      | 0}`),
            rejected_count:   rawExpr(`rejected_count + ${Number(rejected)       | 0}`),
            last_event_at:    rawExpr('unixepoch()'),
          })
          .where(eq('id', collectorId))
      );
    }
  });

  return { inserted: events.length };
}

/**
 * Record a batch that produced no storable events (all rejected), so the
 * dashboard still reflects that traffic reached the collector.
 */
async function recordRejection(collectorId, { packets = 1, rejected = 1 } = {}) {
  if (collectorId == null) return;
  await db.query(
    new UpdateQuery('collectors')
      .set({
        packets_received: rawExpr(`packets_received + ${Number(packets)  | 0}`),
        rejected_count:   rawExpr(`rejected_count + ${Number(rejected)   | 0}`),
      })
      .where(eq('id', collectorId))
  );
}

module.exports = { normaliseEntry, storeEvents, recordRejection };
