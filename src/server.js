'use strict';
require('dotenv').config();

const express = require('express');
const path    = require('path');
const db      = require('./db/database');
const logsQ   = require('./db/queries/logs');

const authRoutes  = require('./routes/auth');
const logsRoutes  = require('./routes/logs');
const oauthRoutes = require('./routes/oauth');

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

/* ── Middleware ─────────────────────────────────────────────────────────────── */
app.use(express.json({ limit: '2mb' }));
// application/x-www-form-urlencoded support for POST /oauth/token
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '../public')));

/* ── Routes ─────────────────────────────────────────────────────────────────── */
app.use('/auth',  authRoutes);
app.use('/oauth', oauthRoutes);
app.use('/logs',  logsRoutes);

/* ── Global error handler ───────────────────────────────────────────────────── */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

/* ── Log retention job ──────────────────────────────────────────────────────── */
const RETENTION_SECS = (parseInt(process.env.LOG_RETENTION_HOURS, 10) || 24) * 3600;

async function purgeOldLogs() {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SECS;
  const result = await db.run(logsQ.purge, [cutoff]);
  if (result.changes > 0) {
    const hours = Math.round(RETENTION_SECS / 3600);
    console.log(`[retention] Purged ${result.changes} log(s) older than ${hours}h`);
  }
}

/* ── Start ──────────────────────────────────────────────────────────────────── */
async function start() {
  await db.init();

  purgeOldLogs();                              // run once on startup
  setInterval(purgeOldLogs, 60 * 60 * 1000);  // then every hour

  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Log retention: ${Math.round(RETENTION_SECS / 3600)}h`);
  });
}

start().catch(err => {
  console.error('[fatal] Failed to start server:', err.message);
  process.exit(1);
});
