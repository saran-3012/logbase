'use strict';
const jwt    = require('jsonwebtoken');
const db     = require('../db/database');
const usersQ = require('../db/queries/users');

module.exports = async function sessionAuth(req, res, next) {
  try {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    const token = header.slice(7);
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired session token' });
    }

    if (payload.type === 'oauth') {
      return res.status(401).json({
        error: 'OAuth tokens cannot be used for session authentication'
      });
    }

    // Confirm the user still exists (guards against stale tokens after a DB reset)
    const user = await db.get(usersQ.findById, [payload.userId]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired session token' });
    }

    req.user = payload;
    next();
  } catch (err) {
    next(err);
  }
};
