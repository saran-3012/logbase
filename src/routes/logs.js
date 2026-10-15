'use strict';
const express       = require('express');
const db            = require('../db/database');
const collectorAuth = require('../middleware/collectorAuth');
const sessionAuth   = require('../middleware/sessionAuth');
const { parsePayload, PayloadError } = require('../ingest/formats');
const { storeEvents, recordRejection } = require('../ingest/pipeline');
const {
  SelectQuery,
  eq, lte, gte, and, rawCond, aliasExpr, col, count,
} = require('../db/query');

const router = express.Router();

// Wrap async route handlers so unhandled rejections reach Express error handler
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

/* ── Helpers ────────────────────────────────────────────────────────────────── */

/**
 * Build a safe FTS5 MATCH query from user input.
 * Each whitespace-separated word is wrapped in double-quotes (disabling FTS5
 * operators) and appended with * for prefix matching.
 * Returns null if the input yields no usable terms.
 */
function buildFtsQuery(input) {
  const words = String(input)
    .trim()
    .split(/\s+/)
    .map(w => w.replace(/"/g, '').trim())  // strip any double-quotes
    .filter(w => w.length > 0);
  if (!words.length) return null;
  return words.map(w => `"${w}"*`).join(' ');
}

/**
 * Convert a value to a Unix timestamp in seconds.
 * Accepts ms epoch numbers (>1e10) or date strings.
 */
function toUnixSec(value) {
  if (!value) return null;
  const n = Number(value);
  if (!isNaN(n) && n > 0) return n > 1e10 ? Math.floor(n / 1000) : Math.floor(n);
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

/**
 * Recover the exact bytes the client sent.
 * server.js installs a raw-body capture for JSON and a text parser for NDJSON,
 * so formats.js remains the single place where payloads are interpreted.
 */
function rawPayload(req) {
  if (req.rawBody && req.rawBody.length) return req.rawBody;
  if (typeof req.body === 'string')      return req.body;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return '';
}

/* ── POST /logs ─────────────────────────────────────────────────────────────── */
router.post('/', collectorAuth, wrap(async (req, res) => {
  const collector = req.collector;

  let parsed;
  try {
    parsed = parsePayload(collector.input_format, rawPayload(req));
  } catch (err) {
    if (err instanceof PayloadError) {
      await recordRejection(collector.id, { packets: 1, rejected: 1 }).catch(() => {});
      return res.status(400).json({
        error:         err.message,
        input_format:  collector.input_format,
        collector:     collector.name,
      });
    }
    throw err;
  }

  const { inserted } = await storeEvents(
    {
      userId:      req.userId,
      collectorId: Number(collector.id),
      packets:     1,
      rejected:    parsed.rejected,
    },
    parsed.events
  );

  res.status(201).json({
    ok:       true,
    inserted,
    rejected: parsed.rejected,
    ...(parsed.errors.length ? { errors: parsed.errors } : {}),
  });
}));

/* ── GET /logs ──────────────────────────────────────────────────────────────── */
router.get('/', sessionAuth, wrap(async (req, res) => {
  const { search, app, level, from, to } = req.query;
  const collectorId = req.query.collector ? parseInt(req.query.collector, 10) : null;
  const page   = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;

  let rows, total;

  const ftsQuery = search ? buildFtsQuery(search) : null;

  if (ftsQuery) {
    // ── Full-text search via FTS5 ──────────────────────────────────────────
    // FTS5 MATCH is an SQLite-specific construct with no query-builder node.
    // We use rawCond() as the documented escape hatch for dialect-specific syntax.
    const { inner, on: joinOn } = require('../db/query');
    const ftsConditions = [rawCond('"logs_fts" MATCH ?', [ftsQuery]), eq('l.user_id', req.user.userId)];
    if (app)   ftsConditions.push(eq('l.app_name', app));
    if (level) ftsConditions.push(eq('l.level',    level.toLowerCase()));
    if (Number.isInteger(collectorId)) ftsConditions.push(eq('l.collector_id', collectorId));
    const fromTs = toUnixSec(from);
    const toTs   = toUnixSec(to);
    if (fromTs !== null) ftsConditions.push(gte('l.timestamp', fromTs));
    if (toTs   !== null) ftsConditions.push(lte('l.timestamp', toTs));

    const ftsWhere = and(...ftsConditions);
    const logsJoin = inner('logs', joinOn('logs_fts.rowid', 'l.id'), 'l');

    try {
      rows = await db.query(
        new SelectQuery('logs_fts')
          .columns([
            col('l.id'), col('l.app_name'), col('l.level'),
            col('l.message'), col('l.metadata'), col('l.raw'), col('l.timestamp'),
            col('l.collector_id'),
          ])
          .join(logsJoin)
          .where(ftsWhere)
          .orderBy('l.timestamp', 'DESC')
          .limit(limit).offset(offset)
      );
      const countRow = await db.query(
        new SelectQuery('logs_fts')
          .columns([aliasExpr(count(), 'count')])
          .join(logsJoin)
          .where(ftsWhere)
          .single()
      );
      total = countRow ? Number(countRow.count) : 0;
    } catch (ftsErr) {
      console.error('[fts] query error:', ftsErr.message);
      rows  = [];
      total = 0;
    }
  } else {
    // ── Regular filtered query ─────────────────────────────────────────────
    const conditions = [eq('user_id', req.user.userId)];
    if (app)   conditions.push(eq('app_name', app));
    if (level) conditions.push(eq('level',    level.toLowerCase()));
    if (Number.isInteger(collectorId)) conditions.push(eq('collector_id', collectorId));
    const fromTs = toUnixSec(from);
    const toTs   = toUnixSec(to);
    if (fromTs !== null) conditions.push(gte('timestamp', fromTs));
    if (toTs   !== null) conditions.push(lte('timestamp', toTs));

    const where = and(...conditions);

    rows = await db.query(
      new SelectQuery('logs')
        .columns(['id', 'app_name', 'level', 'message', 'metadata', 'raw', 'timestamp', 'collector_id'])
        .where(where)
        .orderBy('timestamp', 'DESC')
        .limit(limit).offset(offset)
    );

    const countRow = await db.query(
      new SelectQuery('logs')
        .columns([aliasExpr(count(), 'count')])
        .where(where)
        .single()
    );
    total = countRow ? Number(countRow.count) : 0;
  }

  // Resolve collector names for the returned page in one query.
  const collectorNames = new Map();
  const ids = [...new Set(rows.map(r => r.collector_id).filter(v => v != null).map(Number))];
  if (ids.length) {
    const { inList } = require('../db/query');
    const collectors = await db.query(
      new SelectQuery('collectors')
        .columns(['id', 'name', 'transfer_type'])
        .where(and(eq('user_id', req.user.userId), inList('id', ids)))
    );
    for (const c of collectors) collectorNames.set(Number(c.id), c);
  }

  const logs = rows.map(r => {
    const c = r.collector_id != null ? collectorNames.get(Number(r.collector_id)) : null;
    return {
      id:             r.id,
      app_name:       r.app_name,
      level:          r.level,
      message:        r.message,
      timestamp:      r.timestamp * 1000, // return ms to the client
      collector_id:   r.collector_id != null ? Number(r.collector_id) : null,
      collector_name: c ? c.name : null,
      transfer_type:  c ? c.transfer_type : null,
      metadata:       (() => { try { return JSON.parse(r.metadata); } catch { return {}; } })(),
    };
  });

  res.json({
    logs,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
}));

/* ── GET /logs/apps ─────────────────────────────────────────────────────────── */
router.get('/apps', sessionAuth, wrap(async (req, res) => {
  const apps = await db.query(
    new SelectQuery('logs')
      .columns([col('app_name')])
      .where(eq('user_id', req.user.userId))
      .distinct()
      .orderBy('app_name')
  );
  res.json(apps.map(r => r.app_name));
}));

module.exports = router;
