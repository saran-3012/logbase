'use strict';

module.exports = {
  insert:           'INSERT INTO oauth_refresh_tokens (client_db_id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
  findByHash:       'SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?',
  revokeByClientId: 'UPDATE oauth_refresh_tokens SET revoked = 1 WHERE client_db_id = ?',
  revokeById:       'UPDATE oauth_refresh_tokens SET revoked = 1 WHERE id = ?',
  revokeWithReuse:  'UPDATE oauth_refresh_tokens SET revoked = 1, reuse_count = reuse_count + 1 WHERE id = ?',
  revokeByHash:     'UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token_hash = ?',
};
