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

const registry = require('../ingest/registry');

const ACCESS_TOKEN_TTL  = parseInt(process.env.OAUTH_ACCESS_TOKEN_TTL,  10) || 3600;        // default 1 hour
const REFRESH_TOKEN_TTL = parseInt(process.env.OAUTH_REFRESH_TOKEN_TTL, 10) || 2592000;     // default 30 days

/**
 * Static refresh tokens are long-lived by design — a client that cannot persist
 * a rotating credential should not be forced to re-authenticate on the same
 * cadence as one that can. Defaults to 90 days; set equal to
 * OAUTH_REFRESH_TOKEN_TTL to keep both modes aligned.
 *
 * Lifetime is chosen per token at issue time via refreshTtlFor().
 */
const STATIC_REFRESH_TOKEN_TTL =
  parseInt(process.env.OAUTH_STATIC_REFRESH_TOKEN_TTL, 10) || 7776000;                      // default 90 days

function refreshTtlFor(mode) {
  return mode === 'static' ? STATIC_REFRESH_TOKEN_TTL : REFRESH_TOKEN_TTL;
}

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
        aliasExpr(col('c.id'),                 'collector_id'),
        aliasExpr(col('c.user_id'),            'user_id'),
        aliasExpr(col('c.name'),               'name'),
        aliasExpr(col('c.enabled'),            'enabled'),
        aliasExpr(col('c.transfer_type'),      'transfer_type'),
        aliasExpr(col('c.auth_method'),        'auth_method'),
        aliasExpr(col('c.oauth_refresh_mode'), 'oauth_refresh_mode'),
      ])
      .join(inner('collectors', on('c.id', 'cc.collector_id'), 'c'))
      .where(and(eq('cc.public_id', String(clientId)), eq('cc.kind', 'oauth_client')))
      .single()
  );
}

/** Mint a signed access token for a collector. */
function signAccessToken(entry) {
  return jwt.sign(
    {
      sub:         entry.user_id,
      type:        'oauth',
      clientId:    entry.client_id,
      collectorId: Number(entry.collector_id),
    },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

/**
 * Issue an access token (JWT) + a refresh token for the given collector.
 *
 * The refresh token's lifetime and its recorded mode both follow the
 * collector's oauth_refresh_mode. The mode is stored on the token row rather
 * than read from the collector at redemption time, so a token already in the
 * wild keeps the semantics it was issued under even if the collector is
 * reconfigured later.
 *
 * @param {object} entry  - row from findOAuthCollector()
 * @param {object} [ctx]  - db context; defaults to the main db adapter
 */
async function issueTokenPair(entry, ctx = db) {
  const mode        = registry.refreshModeOf(entry) || registry.DEFAULT_OAUTH_REFRESH_MODE;
  const accessToken = signAccessToken(entry);

  const refreshToken     = crypto.randomBytes(48).toString('hex'); // 96-char hex
  const refreshTokenHash = sha256(refreshToken);
  const expiresAt        = Math.floor(Date.now() / 1000) + refreshTtlFor(mode);

  await ctx.query(
    new InsertQuery('oauth_refresh_tokens')
      .values({
        collector_id: Number(entry.collector_id),
        user_id:      entry.user_id,
        token_hash:   refreshTokenHash,
        mode,
        expires_at:   expiresAt,
      })
  );

  return { accessToken, refreshToken, expiresAt, mode };
}

/**
 * Shape the RFC 6749 §5.1 success body.
 *
 * In static mode the client keeps the refresh token it already holds, so the
 * response echoes it back unchanged — re-sending the same value keeps naive
 * clients that blindly overwrite their stored credential correct, and
 * refresh_token_expires_in tells them when re-authentication is due.
 */
function tokenResponse({ accessToken, refreshToken, expiresAt, mode }) {
  return {
    access_token:              accessToken,
    token_type:                'Bearer',
    expires_in:                ACCESS_TOKEN_TTL,
    refresh_token:             refreshToken,
    refresh_token_expires_in:  Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
    refresh_token_mode:        mode,
    scope:                     'logs:write',
  };
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

    return res.json(tokenResponse(await issueTokenPair(entry)));
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

    // The mode the token was issued under — not the collector's current setting.
    // A token already in circulation keeps its original semantics.
    const tokenMode = registry.isRefreshMode(row.mode)
      ? row.mode
      : registry.DEFAULT_OAUTH_REFRESH_MODE;

    if (row.revoked) {
      if (tokenMode === 'rotating') {
        // Replay of a consumed rotating token — treat the family as compromised
        // (RFC 6819 §5.2.2.3 / OAuth 2.1 §4.3.1).
        await db.query(
          new UpdateQuery('oauth_refresh_tokens').set({ revoked: 1 }).where(eq('collector_id', row.collector_id))
        );
        console.warn(`[oauth] Stolen refresh token reuse detected for collector_id=${row.collector_id}. All tokens revoked.`);
        return res.status(401).json({
          error:             'invalid_grant',
          error_description: 'Refresh token has already been used. All tokens for this client have been revoked due to possible theft.'
        });
      }

      // Static tokens are reusable by design, so a revoked one was deliberately
      // withdrawn (explicit revoke, rotation, or a mode switch). No family-wide
      // action — there is nothing to infer about theft.
      return res.status(401).json({
        error:             'invalid_grant',
        error_description: 'Refresh token has been revoked. Re-authenticate with client_credentials to obtain a new one.'
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
          aliasExpr(col('cc.public_id'),         'client_id'),
          aliasExpr(col('c.id'),                 'collector_id'),
          aliasExpr(col('c.user_id'),            'user_id'),
          aliasExpr(col('c.name'),               'name'),
          aliasExpr(col('c.enabled'),            'enabled'),
          aliasExpr(col('c.auth_method'),        'auth_method'),
          aliasExpr(col('c.oauth_refresh_mode'), 'oauth_refresh_mode'),
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

    /* ── Static mode ──────────────────────────────────────────────────────
       The presented token stays valid: mint a fresh access token and hand the
       same refresh token back. reuse_count becomes a plain usage counter and
       last_used_at records activity for the dashboard.                      */
    if (tokenMode === 'static') {
      await db.query(
        new UpdateQuery('oauth_refresh_tokens')
          .set({ reuse_count: rawExpr('reuse_count + 1'), last_used_at: rawExpr('unixepoch()') })
          .where(eq('id', row.id))
      );

      return res.json(tokenResponse({
        accessToken:  signAccessToken(credential),
        refreshToken: String(incomingToken),
        expiresAt:    Number(row.expires_at),
        mode:         'static',
      }));
    }

    /* ── Rotating mode ────────────────────────────────────────────────────
       Consume the presented token and issue a new pair atomically, so a
       failure part-way cannot leave the client with neither token valid.    */
    const issued = await db.transaction(async (ctx) => {
      await ctx.query(
        new UpdateQuery('oauth_refresh_tokens')
          .set({ revoked: 1, reuse_count: rawExpr('reuse_count + 1'), last_used_at: rawExpr('unixepoch()') })
          .where(eq('id', row.id))
      );
      return issueTokenPair(credential, ctx);
    });

    return res.json(tokenResponse(issued));
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
