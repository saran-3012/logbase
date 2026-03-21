'use strict';

module.exports = {
  findById:       'SELECT id FROM users WHERE id = ?',
  findByUsername: 'SELECT * FROM users WHERE username = ?',
  insert:         'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
};
