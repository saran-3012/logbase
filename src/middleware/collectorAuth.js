'use strict';
const jwt = require('jsonwebtoken');
const db  = require('../db/database');
const {
  SelectQuery, UpdateQuery,
  eq, and, inner, on, col, aliasExpr, rawExpr,
} = require('../db/query');

/**
 * HTTP log-ingest authentication, resolved against a collector.
 *
 * Accepts either:
 *   X-API-Token: <token>          — collector with auth_method 'api_token'
 *   Authorization: Bearer <jwt>   — OAuth access token from POST /oauth/token
 *
 * On success sets:
 *   req.collector  — the full collectors row (input_format drives parsing)
 *   req.userId     — owning user id
 *   req.authMethod — 'api_token' | 'oauth_client_credentials'
 *
 * Rejects when the collector is disabled (403) or is not an HTTP collector (400).
 */

const COLLECTOR_COLUMNS = [
  aliasExpr(col('c.id'), 'id'),
  aliasExpr(col('c.user_id'), 'user_id'),
  aliasExpr(col('c.name'), 'name'),
  aliasExpr(col('c.transfer_type'), 'transfer_type'),
  aliasExpr(col('c.auth_method'), 'auth_method'),
  aliasExpr(col('c.input_format'), 'input_format'),
  aliasExpr(col('c.enabled'), 'enabled'),
];

function guardCollector(res, collector) {
  if (collector.transfer_type !== 'http') {
    res.status(400).json({
      error: `Collector "${collector.name}" uses transfer type "${collector.transfer_type}" and cannot accept HTTP ingestion.`,
    });
    return false;
  }
  if (!Number(collector.enabled)) {
    res.status(403).json({ error: `Collector "${collector.name}" is disabled.` });
    return false;
  }
  return true;
}

module.exports = async function collectorAuth(req, res, next) {
  try {
    const apiToken   = req.headers['x-api-token'];
    const authHeader = req.headers['authorization'];

    /* ── API token ─────────────────────────────────────────────────────────── */
    if (apiToken) {
      const row = await db.query(
        new SelectQuery('collector_credentials', 'cc')
          .columns([...COLLECTOR_COLUMNS, aliasExpr(col('cc.id'), 'credential_id')])
          .join(inner('collectors', on('c.id', 'cc.collector_id'), 'c'))
          .where(and(eq('cc.token', String(apiToken)), eq('cc.kind', 'api_token')))
          .single()
      );

      if (!row) return res.status(401).json({ error: 'Invalid API token' });
      if (!guardCollector(res, row)) return;

      await db.query(
        new UpdateQuery('collector_credentials')
          .set({ last_used_at: rawExpr('unixepoch()') })
          .where(eq('id', row.credential_id))
      );

      req.collector  = row;
      req.userId     = row.user_id;
      req.authMethod = 'api_token';
      return next();
    }

    /* ── OAuth bearer token ────────────────────────────────────────────────── */
    if (authHeader && authHeader.startsWith('Bearer ')) {
      let payload;
      try {
        payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
      } catch {
        return res.status(401).json({ error: 'Invalid or expired OAuth access token' });
      }

      if (payload.type !== 'oauth') {
        return res.status(401).json({
          error: 'Session tokens cannot be used for log ingestion. Use an OAuth access token or X-API-Token.',
        });
      }

      const row = await db.query(
        new SelectQuery('collectors', 'c')
          .columns(COLLECTOR_COLUMNS)
          .where(and(eq('c.id', payload.collectorId), eq('c.user_id', payload.sub)))
          .single()
      );

      if (!row) return res.status(401).json({ error: 'Collector no longer exists' });
      if (!guardCollector(res, row)) return;

      req.collector  = row;
      req.userId     = row.user_id;
      req.authMethod = 'oauth_client_credentials';
      return next();
    }

    return res.status(401).json({
      error: 'Authentication required. Provide X-API-Token header or Authorization: Bearer <oauth_access_token>',
    });
  } catch (err) {
    next(err);
  }
};
