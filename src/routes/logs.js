'use strict';
const express         = require('express');
const db              = require('../db/database');
const logIngestAuth   = require('../middleware/logIngestAuth');
const sessionAuth     = require('../middleware/sessionAuth');
const {
  SelectQuery, InsertQuery,
  eq, lt, lte, gte, and, rawCond, aliasExpr, col, count,
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

/* ── Normalise a single log entry object into DB-ready fields ───────────────── */
function normaliseEntry(entry) {
  const appName = String(entry.app || entry.app_name || entry.source || 'unknown').slice(0, 128);
  const level   = String(entry.level || entry.severity || 'info').toLowerCase().slice(0, 32);
  const message = String(entry.message || entry.msg || '').slice(0, 8192);
  const { app, app_name, source, level: _l, severity: _s, message: _m, msg: _msg, ...rest } = entry;
  return { appName, level, message, metadata: JSON.stringify(rest), raw: JSON.stringify(entry) };
}

/* ── POST /logs ─────────────────────────────────────────────────────────────── */
router.post('/', logIngestAuth, wrap(async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Request body must be a JSON object or array' });
  }

  const entries = Array.isArray(body) ? body : [body];

  if (entries.length === 0) {
    return res.status(400).json({ error: 'Array must contain at least one log entry' });
  }
  if (entries.length > 1000) {
    return res.status(400).json({ error: 'Batch size cannot exceed 1000 entries' });
  }

  // Validate every element is a plain object before touching the DB
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i] || typeof entries[i] !== 'object' || Array.isArray(entries[i])) {
      return res.status(400).json({ error: `Entry at index ${i} must be a JSON object` });
    }
  }

  // Wrap in a transaction so the whole batch succeeds or fails atomically
  await db.transaction(async (ctx) => {
    for (const entry of entries) {
      const { appName, level, message, metadata, raw } = normaliseEntry(entry);
      await ctx.query(
        new InsertQuery('logs')
          .values({ user_id: req.userId, token_id: req.tokenId, app_name: appName, level, message, metadata, raw })
      );
    }
  });

  const isBatch = Array.isArray(body);
  res.status(201).json(isBatch ? { ok: true, inserted: entries.length } : { ok: true });
}));

/* ── GET /logs ──────────────────────────────────────────────────────────────── */
router.get('/', sessionAuth, wrap(async (req, res) => {
  const { search, app, level, from, to } = req.query;
  const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
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
    const fromTs = toUnixSec(from);
    const toTs   = toUnixSec(to);
    if (fromTs !== null) conditions.push(gte('timestamp', fromTs));
    if (toTs   !== null) conditions.push(lte('timestamp', toTs));

    const where = and(...conditions);

    rows = await db.query(
      new SelectQuery('logs')
        .columns(['id', 'app_name', 'level', 'message', 'metadata', 'raw', 'timestamp'])
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

  const logs = rows.map(r => ({
    id:        r.id,
    app_name:  r.app_name,
    level:     r.level,
    message:   r.message,
    timestamp: r.timestamp * 1000, // return ms to the client
    metadata:  (() => { try { return JSON.parse(r.metadata); } catch { return {}; } })()
  }));

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
