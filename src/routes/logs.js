'use strict';
const express         = require('express');
const db              = require('../db/database');
const logIngestAuth   = require('../middleware/logIngestAuth');
const sessionAuth     = require('../middleware/sessionAuth');

const router = express.Router();

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
router.post('/', logIngestAuth, (req, res) => {
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

  const insert = db.prepare(`
    INSERT INTO logs (user_id, token_id, app_name, level, message, metadata, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Wrap in a transaction so the whole batch succeeds or fails atomically
  const insertBatch = db.transaction((rows) => {
    for (const entry of rows) {
      const { appName, level, message, metadata, raw } = normaliseEntry(entry);
      insert.run(req.userId, req.tokenId, appName, level, message, metadata, raw);
    }
  });

  insertBatch(entries);

  const isBatch = Array.isArray(body);
  res.status(201).json(isBatch ? { ok: true, inserted: entries.length } : { ok: true });
});

/* ── GET /logs ──────────────────────────────────────────────────────────────── */
router.get('/', sessionAuth, (req, res) => {
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

    const selectSql = `
      SELECT l.id, l.app_name, l.level, l.message, l.metadata, l.raw, l.timestamp
      FROM logs_fts
      JOIN logs l ON logs_fts.rowid = l.id
      WHERE logs_fts MATCH ? AND l.user_id = ? ${filterStr}
      ORDER BY l.timestamp DESC
      LIMIT ? OFFSET ?
    `;
    const countSql = `
      SELECT COUNT(*) AS count
      FROM logs_fts
      JOIN logs l ON logs_fts.rowid = l.id
      WHERE logs_fts MATCH ? AND l.user_id = ? ${filterStr}
    `;

    try {
      rows  = db.prepare(selectSql).all(queryParams);
      total = db.prepare(countSql).get(baseParams).count;
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

    rows  = db.prepare(`
      SELECT id, app_name, level, message, metadata, raw, timestamp
      FROM logs WHERE ${whereClause}
      ORDER BY timestamp DESC LIMIT ? OFFSET ?
    `).all([...params, limit, offset]);

    total = db.prepare(
      `SELECT COUNT(*) AS count FROM logs WHERE ${whereClause}`
    ).get(params).count;
  }

  const logs = rows.map(r => ({
    id:       r.id,
    app_name: r.app_name,
    level:    r.level,
    message:  r.message,
    timestamp: r.timestamp * 1000, // return ms to the client
    metadata: (() => { try { return JSON.parse(r.metadata); } catch { return {}; } })()
  }));

  res.json({
    logs,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  });
});

/* ── GET /logs/apps ─────────────────────────────────────────────────────────── */
router.get('/apps', sessionAuth, (req, res) => {
  const apps = db.prepare(
    'SELECT DISTINCT app_name FROM logs WHERE user_id = ? ORDER BY app_name'
  ).all(req.user.userId);
  res.json(apps.map(r => r.app_name));
});

module.exports = router;
