'use strict';
const express         = require('express');
const db              = require('../db/database');
const logIngestAuth   = require('../middleware/logIngestAuth');
const sessionAuth     = require('../middleware/sessionAuth');
const logsQ           = require('../db/queries/logs');

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
      await ctx.run(logsQ.insert, [req.userId, req.tokenId, appName, level, message, metadata, raw]);
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
    const extraFilters = [];
    const extraParams  = [];

    if (app)  { extraFilters.push('AND l.app_name = ?'); extraParams.push(app); }
    if (level){ extraFilters.push('AND l.level = ?');    extraParams.push(level.toLowerCase()); }
    const fromTs = toUnixSec(from);
    const toTs   = toUnixSec(to);
    if (fromTs !== null) { extraFilters.push('AND l.timestamp >= ?'); extraParams.push(fromTs); }
    if (toTs   !== null) { extraFilters.push('AND l.timestamp <= ?'); extraParams.push(toTs); }

    const filterStr = extraFilters.join(' ');

    const baseParams  = [ftsQuery, req.user.userId, ...extraParams];
    const queryParams = [...baseParams, limit, offset];

    const selectSql = logsQ.ftsSelect(filterStr);
    const countSql  = logsQ.ftsCount(filterStr);

    try {
      rows  = await db.all(selectSql, queryParams);
      const countRow = await db.get(countSql, baseParams);
      total = countRow ? Number(countRow.count) : 0;
    } catch (ftsErr) {
      console.error('[fts] query error:', ftsErr.message);
      rows  = [];
      total = 0;
    }
  } else {
    // ── Regular filtered query ─────────────────────────────────────────────
    const where  = ['user_id = ?'];
    const params = [req.user.userId];

    if (app)  { where.push('app_name = ?'); params.push(app); }
    if (level){ where.push('level = ?');    params.push(level.toLowerCase()); }
    const fromTs = toUnixSec(from);
    const toTs   = toUnixSec(to);
    if (fromTs !== null) { where.push('timestamp >= ?'); params.push(fromTs); }
    if (toTs   !== null) { where.push('timestamp <= ?'); params.push(toTs); }

    const whereClause = where.join(' AND ');

    rows = await db.all(logsQ.filteredSelect(whereClause), [...params, limit, offset]);

    const countRow = await db.get(logsQ.filteredCount(whereClause), params);
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
  const apps = await db.all(logsQ.appNames, [req.user.userId]);
  res.json(apps.map(r => r.app_name));
}));

module.exports = router;
