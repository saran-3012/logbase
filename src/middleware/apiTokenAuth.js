'use strict';
const db = require('../db/database');
const { SelectQuery, UpdateQuery, eq, aliasExpr, col, rawExpr } = require('../db/query');

module.exports = async function apiTokenAuth(req, res, next) {
  try {
    const token = req.headers['x-api-token'];
    if (!token) {
      return res.status(401).json({ error: 'Missing X-API-Token header' });
    }

    const row = await db.query(
      new SelectQuery('api_tokens')
        .columns([aliasExpr(col('id'), 'token_id'), col('user_id')])
        .where(eq('token', String(token)))
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

    req.tokenId = row.token_id;
    req.userId  = row.user_id;
    next();
  } catch (err) {
    next(err);
  }
};
