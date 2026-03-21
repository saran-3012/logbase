'use strict';

// Static queries
const insert   = 'INSERT INTO logs (user_id, token_id, app_name, level, message, metadata, raw) VALUES (?, ?, ?, ?, ?, ?, ?)';
const appNames = 'SELECT DISTINCT app_name FROM logs WHERE user_id = ? ORDER BY app_name';
const purge    = 'DELETE FROM logs WHERE timestamp < ?';

// Dynamic queries — accept the caller-built predicate fragment so the core
// SELECT/FROM/JOIN/ORDER stays here rather than scattered across route code.
const ftsSelect = (filterStr) => `
  SELECT l.id, l.app_name, l.level, l.message, l.metadata, l.raw, l.timestamp
  FROM logs_fts
  JOIN logs l ON logs_fts.rowid = l.id
  WHERE logs_fts MATCH ? AND l.user_id = ? ${filterStr}
  ORDER BY l.timestamp DESC
  LIMIT ? OFFSET ?
`;

const ftsCount = (filterStr) => `
  SELECT COUNT(*) AS count
  FROM logs_fts
  JOIN logs l ON logs_fts.rowid = l.id
  WHERE logs_fts MATCH ? AND l.user_id = ? ${filterStr}
`;

const filteredSelect = (whereClause) =>
  `SELECT id, app_name, level, message, metadata, raw, timestamp
   FROM logs WHERE ${whereClause}
   ORDER BY timestamp DESC LIMIT ? OFFSET ?`;

const filteredCount = (whereClause) =>
  `SELECT COUNT(*) AS count FROM logs WHERE ${whereClause}`;

module.exports = { insert, appNames, purge, ftsSelect, ftsCount, filteredSelect, filteredCount };
