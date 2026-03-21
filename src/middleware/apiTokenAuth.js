'use strict';
const db         = require('../db/database');
const apiTokensQ = require('../db/queries/apiTokens');

module.exports = async function apiTokenAuth(req, res, next) {
  try {
    const token = req.headers['x-api-token'];
    if (!token) {
      return res.status(401).json({ error: 'Missing X-API-Token header' });
    }

    const row = await db.get(apiTokensQ.findByToken, [String(token)]);

    if (!row) {
      return res.status(401).json({ error: 'Invalid API token' });
    }

    await db.run(apiTokensQ.touchLastUsed, [row.token_id]);

    req.tokenId = row.token_id;
    req.userId  = row.user_id;
    next();
  } catch (err) {
    next(err);
  }
};
