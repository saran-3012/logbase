'use strict';
require('dotenv').config();

const express = require('express');
const path    = require('path');
const db      = require('./db/database');
const { DeleteQuery, lt } = require('./db/query');

const listenerManager = require('./ingest/listenerManager');

const authRoutes       = require('./routes/auth');
const logsRoutes       = require('./routes/logs');
const oauthRoutes      = require('./routes/oauth');
const collectorsRoutes = require('./routes/collectors');

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

const INGEST_BODY_LIMIT = process.env.INGEST_BODY_LIMIT || '10mb';

/* ── Middleware ─────────────────────────────────────────────────────────────── */

// Keep the exact bytes the client sent so src/ingest/formats.js remains the single
// place where a payload is interpreted (a collector declares json_array vs ndjson).
const captureRaw = (req, _res, buf) => {
  if (buf && buf.length) req.rawBody = buf.toString('utf8');
};

app.use(express.json({ limit: INGEST_BODY_LIMIT, verify: captureRaw }));

// NDJSON / plain-text ingestion bodies
app.use(express.text({
  type:   ['application/x-ndjson', 'application/ndjson', 'text/plain'],
  limit:  INGEST_BODY_LIMIT,
  verify: captureRaw,
}));

// application/x-www-form-urlencoded support for POST /oauth/token
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '../public')));

/* ── Health check (used by Render) ──────────────────────────────────────────── */
app.get('/healthz', (_req, res) => {
  res.json({
    ok:              true,
    uptime:          Math.round(process.uptime()),
    udp_listeners:   listenerManager.activeListenerCount(),
    udp_enabled:     listenerManager.config.enabled,
  });
});

/* ── Routes ─────────────────────────────────────────────────────────────────── */
app.use('/auth',       authRoutes);
app.use('/oauth',      oauthRoutes);
app.use('/logs',       logsRoutes);
app.use('/collectors', collectorsRoutes);

/* ── Global error handler ───────────────────────────────────────────────────── */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  // Body parsers surface malformed payloads as 400-ish errors — don't mask them as 500.
  if (err.type === 'entity.parse.failed' || err.status === 400) {
    return res.status(400).json({ error: `Malformed request body: ${err.message}` });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `Payload exceeds the ${INGEST_BODY_LIMIT} limit` });
  }
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

/* ── Log retention job ──────────────────────────────────────────────────────── */
const RETENTION_SECS = (parseInt(process.env.LOG_RETENTION_HOURS, 10) || 24) * 3600;

async function purgeOldLogs() {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SECS;
  const result = await db.query(new DeleteQuery('logs').where(lt('timestamp', cutoff)));
  if (result.changes > 0) {
    const hours = Math.round(RETENTION_SECS / 3600);
    console.log(`[retention] Purged ${result.changes} log(s) older than ${hours}h`);
  }
}

/* ── Start ──────────────────────────────────────────────────────────────────── */
let httpServer = null;

async function start() {
  await db.init();

  purgeOldLogs();                              // run once on startup
  setInterval(purgeOldLogs, 60 * 60 * 1000);  // then every hour

  httpServer = app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Log retention: ${Math.round(RETENTION_SECS / 3600)}h`);
  });

  // UDP listeners come up after HTTP so a bind failure can never prevent the
  // web service from serving traffic (critical on single-port PaaS hosts).
  await listenerManager.start();
}

/* ── Graceful shutdown ──────────────────────────────────────────────────────── */
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — closing listeners…`);

  const timer = setTimeout(() => {
    console.error('[shutdown] Forced exit after 10s');
    process.exit(1);
  }, 10_000);
  if (timer.unref) timer.unref();

  try {
    // Release UDP ports first: Render overlaps old and new instances during a
    // deploy, and a held port would make the new instance fail to bind.
    await listenerManager.stopAll();
    if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  } catch (err) {
    console.error('[shutdown] error:', err.message);
  }

  clearTimeout(timer);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// A failure in the UDP ingest path must never take down the HTTP service.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason);
});

start().catch(err => {
  console.error('[fatal] Failed to start server:', err.message);
  process.exit(1);
});
