'use strict';
const express        = require('express');
const bcrypt         = require('bcryptjs');
const crypto         = require('crypto');
const jwt            = require('jsonwebtoken');
const db             = require('../db/database');
const {
  SelectQuery, InsertQuery, UpdateQuery,
  eq, and, col, aliasExpr, inner, on, rawExpr,
} = require('../db/query');

const router = express.Router();

// Wrap async route handlers so unhandled rejections reach Express error handler
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

const ACCESS_TOKEN_TTL  = parseInt(process.env.OAUTH_ACCESS_TOKEN_TTL,  10) || 3600;        // default 1 hour
const REFRESH_TOKEN_TTL = parseInt(process.env.OAUTH_REFRESH_TOKEN_TTL, 10) || 2592000;     // default 30 days

/* ── Helpers ────────────────────────────────────────────────────────────────── */

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Load the OAuth credential + its owning collector by client_id.
 * Returns a flat object or null.
 */
async function findOAuthCollector(clientId) {
  return db.query(
    new SelectQuery('collector_credentials', 'cc')
      .columns([
        aliasExpr(col('cc.id'),           'credential_id'),
        aliasExpr(col('cc.public_id'),    'client_id'),
        aliasExpr(col('cc.secret_hash'),  'secret_hash'),
        aliasExpr(col('c.id'),            'collector_id'),
        aliasExpr(col('c.user_id'),       'user_id'),
        aliasExpr(col('c.name'),          'name'),
        aliasExpr(col('c.enabled'),       'enabled'),
        aliasExpr(col('c.transfer_type'), 'transfer_type'),
      ])
      .join(inner('collectors', on('c.id', 'cc.collector_id'), 'c'))
      .where(and(eq('cc.public_id', String(clientId)), eq('cc.kind', 'oauth_client')))
      .single()
  );
}

/**
 * Issue an access token (JWT) + a refresh token for the given collector.
 * Stores the hashed refresh token via the provided db context (main db or
 * a transaction context) and returns the plain-text pair.
 * @param {object} entry  - row from findOAuthCollector()
 * @param {object} [ctx]  - db context; defaults to the main db adapter
 */
async function issueTokenPair(entry, ctx = db) {
  const accessToken = jwt.sign(
    {
      sub:         entry.user_id,
      type:        'oauth',
      clientId:    entry.client_id,
      collectorId: Number(entry.collector_id),
    },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );

  const refreshToken     = crypto.randomBytes(48).toString('hex'); // 96-char hex
  const refreshTokenHash = sha256(refreshToken);
  const expiresAt        = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL;

  await ctx.query(
    new InsertQuery('oauth_refresh_tokens')
      .values({
        collector_id: Number(entry.collector_id),
        user_id:      entry.user_id,
        token_hash:   refreshTokenHash,
        expires_at:   expiresAt,
      })
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

    const entry = await findOAuthCollector(clientId);

    const hash  = entry ? entry.secret_hash : '$2a$12$invalidhashfortimingnormalization';
    const match = bcrypt.compareSync(String(clientSecret), hash);

    if (!entry || !match) {
      return res.status(401).json({
        error:             'invalid_client',
        error_description: 'Invalid client_id or client_secret'
      });
    }

    if (!Number(entry.enabled)) {
      return res.status(403).json({
        error:             'invalid_client',
        error_description: `Collector "${entry.name}" is disabled`
      });
    }

    const { accessToken, refreshToken } = await issueTokenPair(entry);

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

    const row = await db.query(
      new SelectQuery('oauth_refresh_tokens').where(eq('token_hash', tokenHash)).single()
    );

    if (!row) {
      return res.status(401).json({
        error:             'invalid_grant',
        error_description: 'Refresh token not found'
      });
    }

    // Detect replay of an already-rotated token — possible theft
    if (row.revoked) {
      // Revoke all active refresh tokens for this collector as a precaution
      await db.query(
        new UpdateQuery('oauth_refresh_tokens').set({ revoked: 1 }).where(eq('collector_id', row.collector_id))
      );
      console.warn(`[oauth] Stolen refresh token reuse detected for collector_id=${row.collector_id}. All tokens revoked.`);
      return res.status(401).json({
        error:             'invalid_grant',
        error_description: 'Refresh token has already been used. All tokens for this client have been revoked due to possible theft.'
      });
    }

    if (row.expires_at < now) {
      await db.query(new UpdateQuery('oauth_refresh_tokens').set({ revoked: 1 }).where(eq('id', row.id)));
      return res.status(401).json({
        error:             'invalid_grant',
        error_description: 'Refresh token has expired. Please re-authenticate with client_credentials.'
      });
    }

    const credential = await db.query(
      new SelectQuery('collector_credentials', 'cc')
        .columns([
          aliasExpr(col('cc.public_id'),    'client_id'),
          aliasExpr(col('c.id'),            'collector_id'),
          aliasExpr(col('c.user_id'),       'user_id'),
          aliasExpr(col('c.name'),          'name'),
          aliasExpr(col('c.enabled'),       'enabled'),
        ])
        .join(inner('collectors', on('c.id', 'cc.collector_id'), 'c'))
        .where(and(eq('cc.collector_id', row.collector_id), eq('cc.kind', 'oauth_client')))
        .single()
    );
    if (!credential) {
      return res.status(401).json({
        error:             'invalid_client',
        error_description: 'OAuth client no longer exists'
      });
    }
    if (!Number(credential.enabled)) {
      return res.status(403).json({
        error:             'invalid_client',
        error_description: `Collector "${credential.name}" is disabled`
      });
    }

    // Rotate: revoke the current refresh token and issue a new pair atomically
    const { accessToken, refreshToken } = await db.transaction(async (ctx) => {
      await ctx.query(
        new UpdateQuery('oauth_refresh_tokens')
          .set({ revoked: 1, reuse_count: rawExpr('reuse_count + 1') })
          .where(eq('id', row.id))
      );
      return issueTokenPair(credential, ctx);
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
  await db.query(new UpdateQuery('oauth_refresh_tokens').set({ revoked: 1 }).where(eq('token_hash', tokenHash)));

  // Per RFC 7009 §2.2 — always return 200 regardless of whether the token existed
  res.json({ ok: true });
}));

/*
 * OAuth client management moved to /collectors.
 * A client is now an HTTP collector with auth_method='oauth_client_credentials':
 *   POST   /collectors            { transfer_type: 'http', auth_method: 'oauth_client_credentials', … }
 *   POST   /collectors/:id/rotate — issues a new client_id + client_secret
 *   DELETE /collectors/:id        — cascades to credentials and refresh tokens
 */

module.exports = router;
