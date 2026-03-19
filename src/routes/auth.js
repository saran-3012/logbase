'use strict';
const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const crypto    = require('crypto');
const db        = require('../db/database');
const sessionAuth = require('../middleware/sessionAuth');

const router = express.Router();

/* ── POST /auth/register ──────────────────────────────────────────────────── */
router.post('/register', (req, res) => {
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
    const result = db.prepare(
      'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)'
    ).run(username.trim(), email.trim().toLowerCase(), passwordHash);

    res.status(201).json({ message: 'Account created successfully', userId: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    throw err;
  }
});

/* ── POST /auth/login ─────────────────────────────────────────────────────── */
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());

  // Use constant-time compare even on missing user to prevent user enumeration
  const hash = user ? user.password_hash : '$2a$12$invalidhashfortimingnormalization';
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
});

/* ── POST /auth/tokens ────────────────────────────────────────────────────── */
router.post('/tokens', sessionAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Token name is required' });
  }

  // 64-char random hex token
  const token = crypto.randomBytes(32).toString('hex');

  try {
    const result = db.prepare(
      'INSERT INTO api_tokens (user_id, name, token) VALUES (?, ?, ?)'
    ).run(req.user.userId, name.trim(), token);

    res.status(201).json({ id: result.lastInsertRowid, name: name.trim(), token });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A token with that name already exists' });
    }
    throw err;
  }
});

/* ── GET /auth/tokens ─────────────────────────────────────────────────────── */
router.get('/tokens', sessionAuth, (req, res) => {
  const tokens = db.prepare(`
    SELECT id, name, created_at, last_used_at,
           substr(token, 1, 8) || '...' AS token_preview
    FROM api_tokens
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(req.user.userId);

  res.json(tokens);
});

/* ── DELETE /auth/tokens/:id ──────────────────────────────────────────────── */
router.delete('/tokens/:id', sessionAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid token id' });
  }

  const result = db.prepare(
    'DELETE FROM api_tokens WHERE id = ? AND user_id = ?'
  ).run(id, req.user.userId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Token not found' });
  }
  res.json({ message: 'Token revoked' });
});

module.exports = router;
