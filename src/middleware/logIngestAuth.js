'use strict';
const jwt = require('jsonwebtoken');
const db  = require('../db/database');
const { SelectQuery, UpdateQuery, eq, aliasExpr, col, rawExpr } = require('../db/query');

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
module.exports = async function logIngestAuth(req, res, next) {
  try {
    const apiToken   = req.headers['x-api-token'];
    const authHeader = req.headers['authorization'];

    /* ── API Token ─────────────────────────────────────────────────────────── */
    if (apiToken) {
      const row = await db.query(
        new SelectQuery('api_tokens')
          .columns([aliasExpr(col('id'), 'token_id'), col('user_id')])
          .where(eq('token', String(apiToken)))
          .single()
      );

      if (!row) {
        return res.status(401).json({ error: 'Invalid API token' });
      }

      await db.query(
        new UpdateQuery('api_tokens')
          .set({ last_used_at: rawExpr('unixepoch()') })
          .where(eq('id', row.token_id))
      );

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
      const client = await db.query(
        new SelectQuery('oauth_clients')
          .columns(['id'])
          .where(eq('client_id', payload.clientId))
          .where(eq('user_id', payload.sub))
          .single()
      );

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
  } catch (err) {
    next(err);
  }
};
