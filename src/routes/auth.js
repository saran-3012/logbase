'use strict';
const express     = require('express');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const db          = require('../db/database');
const { SelectQuery, InsertQuery, eq } = require('../db/query');

const router = express.Router();

// Wrap async route handlers so unhandled rejections reach Express error handler
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

/* ── POST /auth/register ──────────────────────────────────────────────────── */
router.post('/register', wrap(async (req, res) => {
  const { username, email, password } = req.body || {};

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email, and password are required' });
  }
  if (typeof username !== 'string' || username.trim().length < 2) {
    return res.status(400).json({ error: 'Username must be at least 2 characters' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const passwordHash = bcrypt.hashSync(password, 12);

  try {
    const result = await db.query(
      new InsertQuery('users')
        .values({ username: username.trim(), email: email.trim().toLowerCase(), password_hash: passwordHash })
    );
    res.status(201).json({ message: 'Account created successfully', userId: result.lastInsertRowid });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    throw err;
  }
}));

/* ── POST /auth/login ─────────────────────────────────────────────────────── */
router.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const user = await db.query(
    new SelectQuery('users')
      .where(eq('username', String(username).trim()))
      .single()
  );

  // Use constant-time compare even on missing user to prevent user enumeration
  const hash  = user ? user.password_hash : '$2a$12$invalidhashfortimingnormalization';
  const match = bcrypt.compareSync(String(password), hash);

  if (!user || !match) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign(
    { userId: user.id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

  res.json({ token, username: user.username });
}));

/*
 * API token management moved to /collectors.
 * A token now belongs to an HTTP collector with auth_method='api_token':
 *   POST   /collectors            { transfer_type: 'http', auth_method: 'api_token', … }
 *   POST   /collectors/:id/rotate
 *   DELETE /collectors/:id
 */

module.exports = router;

