'use strict';
const express       = require('express');
const db            = require('../db/database');
const collectorAuth = require('../middleware/collectorAuth');
const sessionAuth   = require('../middleware/sessionAuth');
const { parsePayload, PayloadError } = require('../ingest/formats');
const { storeEvents, recordRejection } = require('../ingest/pipeline');
const {
  SelectQuery,
  eq, lte, gte, and, inList, rawCond, rawExpr, aliasExpr, col, count,
  inner, on,
} = require('../db/query');

const router = express.Router();

// Wrap async route handlers so unhandled rejections reach Express error handler
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

/** Levels the dashboard renders as filter pills, in display order. */
const KNOWN_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'];

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
 * Accept `level=error` or `level=error,warn` (the dashboard's level pills are
 * multi-select). Unknown values are dropped rather than returning no rows.
 */
function parseLevels(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Build the shared FROM/WHERE for a log query.
 *
 * Full-text search runs against the `logs_fts` virtual table joined back to
 * `logs` (aliased `l`), so every column reference needs an `l.` prefix in that
 * mode — `prefix` carries it for callers.
 *
 * @param {object}  req
 * @param {boolean} [opts.applyLevel=true] omit the level filter so the level
 *                  pills can show counts that are not narrowed by themselves.
 */
function buildQueryContext(req, { applyLevel = true } = {}) {
  const { search, app, from, to } = req.query;
  const collectorId = req.query.collector ? parseInt(req.query.collector, 10) : null;
  const levels      = applyLevel ? parseLevels(req.query.level) : [];

  const ftsQuery = search ? buildFtsQuery(search) : null;
  const useFts   = Boolean(ftsQuery);
  const prefix   = useFts ? 'l.' : '';

  const conditions = [];
  // FTS5 MATCH is an SQLite-specific construct with no query-builder node.
  // rawCond() is the documented escape hatch for dialect-specific syntax.
  if (useFts) conditions.push(rawCond('"logs_fts" MATCH ?', [ftsQuery]));

  conditions.push(eq(`${prefix}user_id`, req.user.userId));
  if (app) conditions.push(eq(`${prefix}app_name`, app));

  if (levels.length === 1)      conditions.push(eq(`${prefix}level`, levels[0]));
  else if (levels.length > 1)   conditions.push(inList(`${prefix}level`, levels));

  if (Number.isInteger(collectorId)) conditions.push(eq(`${prefix}collector_id`, collectorId));

  const fromTs = toUnixSec(from);
  const toTs   = toUnixSec(to);
  if (fromTs !== null) conditions.push(gte(`${prefix}timestamp`, fromTs));
  if (toTs   !== null) conditions.push(lte(`${prefix}timestamp`, toTs));

  return {
    useFts,
    prefix,
    table: useFts ? 'logs_fts' : 'logs',
    join:  useFts ? inner('logs', on('logs_fts.rowid', 'l.id'), 'l') : null,
    where: and(...conditions),
    fromTs,
    toTs,
  };
}

/** Apply a context's FROM/JOIN/WHERE to a SelectQuery. */
function applyContext(query, ctx) {
  if (ctx.join) query.join(ctx.join);
  return query.where(ctx.where);
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

/** Resolve collector names for a page of rows in a single query. */
async function resolveCollectors(rows, userId) {
  const map = new Map();
  const ids = [...new Set(rows.map(r => r.collector_id).filter(v => v != null).map(Number))];
  if (!ids.length) return map;

  const collectors = await db.query(
    new SelectQuery('collectors')
      .columns(['id', 'name', 'transfer_type'])
      .where(and(eq('user_id', userId), inList('id', ids)))
  );
  for (const c of collectors) map.set(Number(c.id), c);
  return map;
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
  const page   = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;

  const ctx = buildQueryContext(req);
  const p   = ctx.prefix;

  let rows = [];
  let total = 0;

  try {
    rows = await db.query(
      applyContext(
        new SelectQuery(ctx.table).columns([
          col(`${p}id`), col(`${p}app_name`), col(`${p}level`), col(`${p}message`),
          col(`${p}metadata`), col(`${p}raw`), col(`${p}timestamp`), col(`${p}collector_id`),
        ]),
        ctx
      )
        .orderBy(`${p}timestamp`, 'DESC')
        .orderBy(`${p}id`, 'DESC')
        .limit(limit).offset(offset)
    );

    const countRow = await db.query(
      applyContext(new SelectQuery(ctx.table).columns([aliasExpr(count(), 'count')]), ctx).single()
    );
    total = countRow ? Number(countRow.count) : 0;
  } catch (err) {
    // A malformed FTS expression must degrade to "no results", not a 500.
    if (!ctx.useFts) throw err;
    console.error('[fts] query error:', err.message);
    rows  = [];
    total = 0;
  }

  const collectorNames = await resolveCollectors(rows, req.user.userId);

  const logs = rows.map(r => {
    const c = r.collector_id != null ? collectorNames.get(Number(r.collector_id)) : null;
    let metadata = {};
    try { metadata = JSON.parse(r.metadata); } catch { /* keep {} */ }
    let raw = null;
    try { raw = JSON.parse(r.raw); } catch { /* keep null */ }

    return {
      id:             r.id,
      app_name:       r.app_name,
      level:          r.level,
      message:        r.message,
      timestamp:      r.timestamp * 1000, // return ms to the client
      collector_id:   r.collector_id != null ? Number(r.collector_id) : null,
      collector_name: c ? c.name : null,
      transfer_type:  c ? c.transfer_type : null,
      metadata,
      raw,
    };
  });

  res.json({
    logs,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
}));

/* ── GET /logs/stats ────────────────────────────────────────────────────────── */
/**
 * Aggregates powering the dashboard's level pills and the event-volume
 * histogram. Accepts exactly the same filters as GET /logs.
 *
 * The level breakdown deliberately ignores the `level` filter — the pills must
 * keep showing how many events each level has, including the ones filtered out.
 */
router.get('/stats', sessionAuth, wrap(async (req, res) => {
  const BUCKETS = Math.min(120, Math.max(12, parseInt(req.query.buckets, 10) || 60));

  // Level counts: every filter except `level`.
  const levelCtx = buildQueryContext(req, { applyLevel: false });
  const lp       = levelCtx.prefix;

  let levelRows = [];
  try {
    levelRows = await db.query(
      applyContext(
        new SelectQuery(levelCtx.table).columns([
          col(`${lp}level`),
          aliasExpr(count(), 'c'),
        ]),
        levelCtx
      ).groupBy([col(`${lp}level`)])
    );
  } catch (err) {
    if (!levelCtx.useFts) throw err;
    console.error('[fts] stats level query error:', err.message);
  }

  const levels = {};
  for (const l of KNOWN_LEVELS) levels[l] = 0;
  let totalUnfiltered = 0;
  for (const row of levelRows) {
    const key = String(row.level || 'unknown').toLowerCase();
    levels[key] = (levels[key] || 0) + Number(row.c);
    totalUnfiltered += Number(row.c);
  }

  // Histogram: all filters applied, bucketed across the selected window.
  const nowSec  = Math.floor(Date.now() / 1000);
  const barCtx  = buildQueryContext(req);
  const bp      = barCtx.prefix;
  const fromTs  = barCtx.fromTs !== null ? barCtx.fromTs : nowSec - 3600;
  const toTs    = barCtx.toTs   !== null ? barCtx.toTs   : nowSec;
  // Integer arithmetic only — interpolated into SQL, so it must never be user text.
  const span      = Math.max(BUCKETS, toTs - fromTs);
  const bucketSec = Math.max(1, Math.floor(span / BUCKETS));
  const bucketSql = `((${bp ? '"l"."timestamp"' : '"timestamp"'} - ${fromTs}) / ${bucketSec})`;

  let bucketRows = [];
  try {
    bucketRows = await db.query(
      applyContext(
        new SelectQuery(barCtx.table).columns([
          aliasExpr(rawExpr(bucketSql), 'b'),
          col(`${bp}level`),
          aliasExpr(count(), 'c'),
        ]),
        barCtx
      ).groupBy([rawExpr(bucketSql), col(`${bp}level`)])
    );
  } catch (err) {
    if (!barCtx.useFts) throw err;
    console.error('[fts] stats bucket query error:', err.message);
  }

  const buckets = Array.from({ length: BUCKETS }, (_, i) => ({
    from:   (fromTs + i * bucketSec) * 1000,
    to:     (fromTs + (i + 1) * bucketSec) * 1000,
    total:  0,
    levels: {},
  }));

  for (const row of bucketRows) {
    const raw = Number(row.b);
    if (!Number.isInteger(raw) || raw < 0) continue;
    // An event landing exactly on `toTs` computes to index BUCKETS (one past the
    // last slot). The WHERE clause already bounds the set, so clamp rather than
    // drop — otherwise the newest events disappear from the histogram.
    const idx = Math.min(BUCKETS - 1, raw);
    const key = String(row.level || 'unknown').toLowerCase();
    const n   = Number(row.c);
    buckets[idx].levels[key] = (buckets[idx].levels[key] || 0) + n;
    buckets[idx].total      += n;
  }

  res.json({
    levels,
    total: totalUnfiltered,
    range: { from: fromTs * 1000, to: toTs * 1000, bucket_ms: bucketSec * 1000 },
    buckets,
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
