'use strict';

module.exports = {
  findByClientId:          'SELECT * FROM oauth_clients WHERE client_id = ?',
  findById:                'SELECT * FROM oauth_clients WHERE id = ?',
  findForTokenValidation:  'SELECT id FROM oauth_clients WHERE client_id = ? AND user_id = ?',
  insert:                  'INSERT INTO oauth_clients (user_id, name, client_id, client_secret_hash) VALUES (?, ?, ?, ?)',
  listByUser:             `SELECT id, name, client_id, created_at
                            FROM oauth_clients
                            WHERE user_id = ?
                            ORDER BY created_at DESC`,
  deleteByUser:            'DELETE FROM oauth_clients WHERE id = ? AND user_id = ?',
};
