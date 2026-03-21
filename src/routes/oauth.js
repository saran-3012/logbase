'use strict';
const express     = require('express');
const bcrypt      = require('bcryptjs');
const crypto      = require('crypto');
const jwt         = require('jsonwebtoken');
const db          = require('../db/database');
const sessionAuth = require('../middleware/sessionAuth');

const router = express.Router();

// Wrap async route handlers so unhandled rejections reach Express error handler
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

const ACCESS_TOKEN_TTL  = 3600;           // 1 hour  (seconds)
const REFRESH_TOKEN_TTL = 30 * 24 * 3600; // 30 days (seconds)

/* ── Helpers ────────────────────────────────────────────────────────────────── */

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Issue an access token (JWT) + a refresh token for the given client.
 * Stores the hashed refresh token via the provided db context (main db or
 * a transaction context) and returns the plain-text pair.
 * @param {object} client  - oauth_clients row
 * @param {object} [ctx]   - db context; defaults to the main db adapter
 */
async function issueTokenPair(client, ctx = db) {
  const accessToken = jwt.sign(
    { sub: client.user_id, type: 'oauth', clientId: client.client_id, clientDbId: client.id },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );

  const refreshToken     = crypto.randomBytes(48).toString('hex'); // 96-char hex
  const refreshTokenHash = sha256(refreshToken);
  const expiresAt        = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL;

  await ctx.run(
    'INSERT INTO oauth_refresh_tokens (client_db_id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    [client.id, client.user_id, refreshTokenHash, expiresAt]
  );

  return { accessToken, refreshToken, expiresAt };
}

/**
 * Extract and validate client credentials from either Basic Auth header
 * or form body fields. Returns { clientId, clientSecret }.
 */
function extractClientCredentials(req) {
  let clientId     = req.body?.client_id;
  let clientSecret = req.body?.client_secret;

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Basic ')) {
    const decoded  = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx > 0) {
      clientId     = decoded.slice(0, colonIdx);
      clientSecret = decoded.slice(colonIdx + 1);
    }
  }
  return { clientId, clientSecret };
}

/* ── POST /oauth/token ──────────────────────────────────────────────────────── */
router.post('/token', wrap(async (req, res) => {
  const body      = req.body || {};
  const grantType = body.grant_type;

  if (!grantType) {
    return res.status(400).json({
      error:             'invalid_request',
      error_description: 'grant_type is required'
    });
  }

  /* ── Grant: client_credentials ─────────────────────────────────────────── */
  if (grantType === 'client_credentials') {
    const { clientId, clientSecret } = extractClientCredentials(req);

    if (!clientId || !clientSecret) {
      return res.status(400).json({
        error:             'invalid_request',
        error_description: 'client_id and client_secret are required'
      });
    }

    const client = await db.get(
      'SELECT * FROM oauth_clients WHERE client_id = ?',
      [String(clientId)]
    );

    const hash  = client ? client.client_secret_hash : '$2a$12$invalidhashfortimingnormalization';
    const match = bcrypt.compareSync(String(clientSecret), hash);

    if (!client || !match) {
      return res.status(401).json({
        error:             'invalid_client',
        error_description: 'Invalid client_id or client_secret'
      });
    }

    const { accessToken, refreshToken } = await issueTokenPair(client);

    return res.json({
      access_token:  accessToken,
      token_type:    'Bearer',
      expires_in:    ACCESS_TOKEN_TTL,
      refresh_token: refreshToken,
      scope:         'logs:write'
    });
  }

  /* ── Grant: refresh_token ───────────────────────────────────────────────── */
  if (grantType === 'refresh_token') {
    const incomingToken = body.refresh_token;
    if (!incomingToken) {
      return res.status(400).json({
        error:             'invalid_request',
        error_description: 'refresh_token is required'
      });
    }

    const tokenHash = sha256(String(incomingToken));
    const now       = Math.floor(Date.now() / 1000);

    const row = await db.get(
      'SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?',
      [tokenHash]
    );

    if (!row) {
      return res.status(401).json({
        error:             'invalid_grant',
        error_description: 'Refresh token not found'
      });
    }

    // Detect replay of an already-rotated token — possible theft
    if (row.revoked) {
      // Revoke all active refresh tokens for this client as a precaution
      await db.run(
        'UPDATE oauth_refresh_tokens SET revoked = 1 WHERE client_db_id = ?',
        [row.client_db_id]
      );
      console.warn(`[oauth] Stolen refresh token reuse detected for client_db_id=${row.client_db_id}. All tokens revoked.`);
      return res.status(401).json({
        error:             'invalid_grant',
        error_description: 'Refresh token has already been used. All tokens for this client have been revoked due to possible theft.'
      });
    }

    if (row.expires_at < now) {
      await db.run('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE id = ?', [row.id]);
      return res.status(401).json({
        error:             'invalid_grant',
        error_description: 'Refresh token has expired. Please re-authenticate with client_credentials.'
      });
    }

    const client = await db.get(
      'SELECT * FROM oauth_clients WHERE id = ?',
      [row.client_db_id]
    );
    if (!client) {
      return res.status(401).json({
        error:             'invalid_client',
        error_description: 'OAuth client no longer exists'
      });
    }

    // Rotate: revoke the current refresh token and issue a new pair atomically
    const { accessToken, refreshToken } = await db.transaction(async (ctx) => {
      await ctx.run(
        'UPDATE oauth_refresh_tokens SET revoked = 1, reuse_count = reuse_count + 1 WHERE id = ?',
        [row.id]
      );
      return issueTokenPair(client, ctx);
    });

    return res.json({
      access_token:  accessToken,
      token_type:    'Bearer',
      expires_in:    ACCESS_TOKEN_TTL,
      refresh_token: refreshToken,
      scope:         'logs:write'
    });
  }

  return res.status(400).json({
    error:             'unsupported_grant_type',
    error_description: 'Supported grant types: client_credentials, refresh_token'
  });
}));

/* ── POST /oauth/revoke  (RFC 7009) ─────────────────────────────────────────── */
router.post('/revoke', wrap(async (req, res) => {
  const token = req.body?.token;
  if (!token) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'token is required' });
  }

  const tokenHash = sha256(String(token));
  await db.run(
    'UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token_hash = ?',
    [tokenHash]
  );

  // Per RFC 7009 §2.2 — always return 200 regardless of whether the token existed
  res.json({ ok: true });
}));

/* ── POST /oauth/clients ────────────────────────────────────────────────────── */
router.post('/clients', sessionAuth, wrap(async (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  const clientId     = crypto.randomUUID();
  const clientSecret = crypto.randomBytes(32).toString('hex');
  const secretHash   = bcrypt.hashSync(clientSecret, 12);

  try {
    const result = await db.run(
      'INSERT INTO oauth_clients (user_id, name, client_id, client_secret_hash) VALUES (?, ?, ?, ?)',
      [req.user.userId, name.trim(), clientId, secretHash]
    );
    // client_secret is returned ONLY at creation time — it is never stored in plain text
    res.status(201).json({
      id:            result.lastInsertRowid,
      name:          name.trim(),
      client_id:     clientId,
      client_secret: clientSecret
    });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'An OAuth client with that name already exists' });
    }
    throw err;
  }
}));

/* ── GET /oauth/clients ─────────────────────────────────────────────────────── */
router.get('/clients', sessionAuth, wrap(async (req, res) => {
  const clients = await db.all(
    `SELECT id, name, client_id, created_at
     FROM oauth_clients
     WHERE user_id = ?
     ORDER BY created_at DESC`,
    [req.user.userId]
  );
  res.json(clients);
}));

/* ── DELETE /oauth/clients/:id ──────────────────────────────────────────────── */
router.delete('/clients/:id', sessionAuth, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid client id' });
  }

  const result = await db.run(
    'DELETE FROM oauth_clients WHERE id = ? AND user_id = ?',
    [id, req.user.userId]
  );

  if (result.changes === 0) {
    return res.status(404).json({ error: 'OAuth client not found' });
  }
  res.json({ message: 'OAuth client revoked' });
}));

module.exports = router;
