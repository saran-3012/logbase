'use strict';

module.exports = {
  findByToken:  'SELECT id AS token_id, user_id FROM api_tokens WHERE token = ?',
  touchLastUsed:'UPDATE api_tokens SET last_used_at = unixepoch() WHERE id = ?',
  insert:       'INSERT INTO api_tokens (user_id, name, token) VALUES (?, ?, ?)',
  listByUser:  `SELECT id, name, created_at, last_used_at,
                       substr(token, 1, 8) || '...' AS token_preview
                FROM api_tokens
                WHERE user_id = ?
                ORDER BY created_at DESC`,
  deleteByUser: 'DELETE FROM api_tokens WHERE id = ? AND user_id = ?',
};
