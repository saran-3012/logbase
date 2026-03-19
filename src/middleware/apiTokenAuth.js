'use strict';
const db = require('../db/database');

module.exports = function apiTokenAuth(req, res, next) {
  const token = req.headers['x-api-token'];
  if (!token) {
    return res.status(401).json({ error: 'Missing X-API-Token header' });
  }

  const row = db.prepare(
    'SELECT id AS token_id, user_id FROM api_tokens WHERE token = ?'
  ).get(token);

  if (!row) {
    return res.status(401).json({ error: 'Invalid API token' });
  }

  db.prepare('UPDATE api_tokens SET last_used_at = unixepoch() WHERE id = ?')
    .run(row.token_id);

  req.tokenId = row.token_id;
  req.userId  = row.user_id;
  next();
};
