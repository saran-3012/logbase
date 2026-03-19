'use strict';
const jwt = require('jsonwebtoken');
const db  = require('../db/database');

/**
 * Combined log-ingest authentication middleware.
 *
 * Accepts either:
 *   X-API-Token: <token>             — existing API token (direct)
 *   Authorization: Bearer <jwt>      — OAuth 2.0 access token obtained via
 *                                      POST /oauth/token (client_credentials)
 *
 * Sets req.userId, req.tokenId (null for OAuth), and req.authMethod.
 */
module.exports = function logIngestAuth(req, res, next) {
  const apiToken   = req.headers['x-api-token'];
  const authHeader = req.headers['authorization'];

  /* ── API Token ─────────────────────────────────────────────────────────── */
  if (apiToken) {
    const row = db.prepare(
      'SELECT id AS token_id, user_id FROM api_tokens WHERE token = ?'
    ).get(String(apiToken));

    if (!row) {
      return res.status(401).json({ error: 'Invalid API token' });
    }

    db.prepare('UPDATE api_tokens SET last_used_at = unixepoch() WHERE id = ?')
      .run(row.token_id);

    req.tokenId    = row.token_id;
    req.userId     = row.user_id;
    req.authMethod = 'api_token';
    return next();
  }

  /* ── OAuth Bearer token ────────────────────────────────────────────────── */
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired OAuth access token' });
    }

    if (payload.type !== 'oauth') {
      return res.status(401).json({
        error: 'Session tokens cannot be used for log ingestion. Use an OAuth access token or X-API-Token.'
      });
    }

    // Verify the OAuth client has not been revoked since the token was issued
    const client = db.prepare(
      'SELECT id FROM oauth_clients WHERE client_id = ? AND user_id = ?'
    ).get(payload.clientId, payload.sub);

    if (!client) {
      return res.status(401).json({ error: 'OAuth client has been revoked' });
    }

    req.tokenId    = null;
    req.userId     = payload.sub;
    req.authMethod = 'oauth';
    return next();
  }

  return res.status(401).json({
    error: 'Authentication required. Provide X-API-Token header or Authorization: Bearer <oauth_access_token>'
  });
};
