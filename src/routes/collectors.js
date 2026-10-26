'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');

const db              = require('../db/database');
const sessionAuth     = require('../middleware/sessionAuth');
const registry        = require('../ingest/registry');
const listenerManager = require('../ingest/listenerManager');
const {
  SelectQuery, InsertQuery, UpdateQuery, DeleteQuery,
  eq, gt, and, col, aliasExpr, rawExpr,
} = require('../db/query');

const router = express.Router();
const wrap   = fn => (req, res, next) => fn(req, res, next).catch(next);

const HTTP_PORT = parseInt(process.env.PORT, 10) || 3000;

/* ── Helpers ────────────────────────────────────────────────────────────────── */

function isUniqueViolation(err) {
  return Boolean(err && err.message && /UNIQUE/i.test(err.message));
}

/** Resolve a collector owned by the requesting user, or null. */
async function findOwned(id, userId) {
  return db.query(
    new SelectQuery('collectors').where(and(eq('id', id), eq('user_id', userId))).single()
  );
}

/**
 * Live refresh-token summary for an OAuth collector — drives the dashboard
 * readout ("1 active refresh token, last used 3m ago").
 */
async function refreshTokenSummary(collectorId) {
  const row = await db.query(
    new SelectQuery('oauth_refresh_tokens')
      .columns([
        aliasExpr(rawExpr('COUNT(*)'), 'active'),
        aliasExpr(rawExpr('MAX(last_used_at)'), 'last_used_at'),
        aliasExpr(rawExpr('MIN(expires_at)'), 'expires_at'),
        aliasExpr(rawExpr('SUM(reuse_count)'), 'uses'),
      ])
      .where(and(
        eq('collector_id', collectorId),
        eq('revoked', 0),
        gt('expires_at', Math.floor(Date.now() / 1000)),
      ))
      .single()
  );

  return {
    active:       Number(row?.active || 0),
    uses:         Number(row?.uses || 0),
    last_used_at: row?.last_used_at != null ? Number(row.last_used_at) : null,
    expires_at:   row?.expires_at   != null ? Number(row.expires_at)   : null,
  };
}

async function credentialsFor(collectorId) {
  return db.query(
    new SelectQuery('collector_credentials')
      .columns([
        col('id'), col('kind'), col('public_id'), col('created_at'), col('last_used_at'),
        aliasExpr(rawExpr("CASE WHEN token IS NULL THEN NULL ELSE substr(token, 1, 8) || '...' END"), 'token_preview'),
      ])
      .where(eq('collector_id', collectorId))
      .orderBy('created_at', 'DESC')
  );
}

/** Build the public endpoint hint shown in the dashboard. */
function endpointFor(collector, req) {
  if (collector.transfer_type === 'http') {
    const host = process.env.PUBLIC_INGEST_HOST || `${req.protocol}://${req.get('host')}`;
    return `${host.replace(/\/+$/, '')}/logs`;
  }
  if (collector.transfer_type === 'udp') {
    const host = collector.public_host
      || process.env.PUBLIC_INGEST_HOST
      || req.hostname
      || 'your-host';
    return `${String(host).replace(/^https?:\/\//, '').replace(/\/+$/, '')}:${collector.port}`;
  }
  return null;
}

function serialise(collector, req, extra = {}) {
  return {
    id:               Number(collector.id),
    name:             collector.name,
    transfer_type:    collector.transfer_type,
    auth_method:      collector.auth_method,
    input_format:     collector.input_format,
    // null for non-OAuth collectors; 'rotating' | 'static' otherwise.
    oauth_refresh_mode: registry.refreshModeOf(collector),
    enabled:          Boolean(Number(collector.enabled)),
    bind_host:        collector.bind_host,
    public_host:      collector.public_host,
    port:             collector.port != null ? Number(collector.port) : null,
    created_at:       Number(collector.created_at),
    last_event_at:    collector.last_event_at != null ? Number(collector.last_event_at) : null,
    events_received:  Number(collector.events_received || 0),
    packets_received: Number(collector.packets_received || 0),
    rejected_count:   Number(collector.rejected_count || 0),
    endpoint:         endpointFor(collector, req),
    listener_status:  listenerManager.statusOf(collector.id, collector),
    listener_stats:   listenerManager.statsOf(collector.id),
    ...extra,
  };
}

/* ── GET /collectors/capabilities ───────────────────────────────────────────── */
router.get('/capabilities', sessionAuth, wrap(async (req, res) => {
  const cfg = listenerManager.config;
  res.json({
    ...registry.capabilitiesPayload(),
    oauth: {
      access_token_ttl:         parseInt(process.env.OAUTH_ACCESS_TOKEN_TTL, 10) || 3600,
      refresh_token_ttl:        parseInt(process.env.OAUTH_REFRESH_TOKEN_TTL, 10) || 2592000,
      static_refresh_token_ttl: parseInt(process.env.OAUTH_STATIC_REFRESH_TOKEN_TTL, 10) || 7776000,
    },
    udp: {
      enabled:             cfg.enabled,
      max_listeners:       cfg.maxListeners,
      active_listeners:    listenerManager.activeListenerCount(),
      port_range:          cfg.portRange,
      bind_host:           cfg.bindHost,
      public_host:         cfg.publicHost,
    },
  });
}));

/* ── GET /collectors ────────────────────────────────────────────────────────── */
router.get('/', sessionAuth, wrap(async (req, res) => {
  const rows = await db.query(
    new SelectQuery('collectors')
      .where(eq('user_id', req.user.userId))
      .orderBy('created_at', 'DESC')
  );

  const result = [];
  for (const row of rows) {
    const extra = { credentials: await credentialsFor(row.id) };
    if (registry.usesRefreshMode(row.auth_method)) {
      extra.refresh_tokens = await refreshTokenSummary(row.id);
    }
    result.push(serialise(row, req, extra));
  }
  res.json(result);
}));

/* ── POST /collectors ───────────────────────────────────────────────────────── */
router.post('/', sessionAuth, wrap(async (req, res) => {
  const {
    name, transfer_type: transferType, auth_method: authMethod,
    input_format: inputFormat, public_host: publicHost, port,
    oauth_refresh_mode: refreshMode,
  } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Collector name is required' });
  }

  const check = registry.validateCombination(transferType, authMethod, inputFormat);
  if (!check.ok) return res.status(400).json({ error: check.error });

  const resolvedMode = registry.resolveRefreshMode(authMethod, refreshMode);
  if (!resolvedMode.ok) return res.status(400).json({ error: resolvedMode.error });

  const cap = registry.capabilityOf(transferType);
  const userId = req.user.userId;

  /* ── Transport-specific validation ──────────────────────────────────────── */
  let portValue = null;
  if (cap.requiresPort) {
    portValue = parseInt(port, 10);
    if (!Number.isInteger(portValue)) {
      return res.status(400).json({ error: 'A port is required for this transfer type' });
    }
    if (!listenerManager.isPortInRange(portValue)) {
      const { min, max } = listenerManager.config.portRange;
      return res.status(400).json({ error: `Port must be within the configured range ${min}-${max}` });
    }
    if (portValue === HTTP_PORT) {
      return res.status(400).json({ error: `Port ${portValue} is used by the HTTP server` });
    }

    // One UDP collector per user (also enforced by a partial unique index).
    if (cap.maxPerUser != null) {
      const existing = await db.query(
        new SelectQuery('collectors')
          .columns(['id'])
          .where(and(eq('user_id', userId), eq('transfer_type', transferType)))
          .single()
      );
      if (existing) {
        return res.status(409).json({
          error: `Only ${cap.maxPerUser} ${transferType.toUpperCase()} collector is allowed per user. Delete the existing one first.`,
        });
      }
    }
  }

  /* ── Insert ─────────────────────────────────────────────────────────────── */
  let collectorId;
  try {
    const result = await db.query(
      new InsertQuery('collectors').values({
        user_id:       userId,
        name:          name.trim(),
        transfer_type: transferType,
        auth_method:   authMethod,
        input_format:  inputFormat,
        oauth_refresh_mode: resolvedMode.mode,
        enabled:       1,
        bind_host:     cap.requiresPort ? listenerManager.config.bindHost : null,
        public_host:   publicHost ? String(publicHost).trim() : null,
        port:          portValue,
      })
    );
    collectorId = result.lastInsertRowid;
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({
        error: 'A collector with that name already exists, or the port / listener slot is already taken.',
      });
    }
    throw err;
  }

  /* ── Credentials (HTTP only) ────────────────────────────────────────────── */
  const secrets = {};
  if (authMethod === 'api_token') {
    const token = crypto.randomBytes(32).toString('hex');
    await db.query(
      new InsertQuery('collector_credentials').values({ collector_id: collectorId, kind: 'api_token', token })
    );
    secrets.api_token = token;
  } else if (authMethod === 'oauth_client_credentials') {
    const clientId     = crypto.randomUUID();
    const clientSecret = crypto.randomBytes(32).toString('hex');
    await db.query(
      new InsertQuery('collector_credentials').values({
        collector_id: collectorId,
        kind:         'oauth_client',
        public_id:    clientId,
        secret_hash:  bcrypt.hashSync(clientSecret, 12),
      })
    );
    secrets.client_id     = clientId;
    secrets.client_secret = clientSecret;
  }

  /* ── Bind the listener now so failures are reported synchronously ───────── */
  const created = await findOwned(collectorId, userId);

  if (transferType === 'udp') {
    const bind = await listenerManager.enable(created);
    if (!bind.ok) {
      // Roll back — a collector that cannot bind must not be left half-created.
      await db.query(new DeleteQuery('collectors').where(eq('id', collectorId)));
      return res.status(409).json({ error: bind.message, code: bind.code });
    }
  }

  const fresh = await findOwned(collectorId, userId);
  res.status(201).json({
    ...serialise(fresh, req),
    // Secrets are returned exactly once, at creation time.
    secrets,
  });
}));

/* ── PATCH /collectors/:id ──────────────────────────────────────────────────── */
router.patch('/:id', sessionAuth, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid collector id' });

  const collector = await findOwned(id, req.user.userId);
  if (!collector) return res.status(404).json({ error: 'Collector not found' });

  const body = req.body || {};

  if (body.transfer_type && body.transfer_type !== collector.transfer_type) {
    return res.status(400).json({ error: 'transfer_type cannot be changed. Delete the collector and create a new one.' });
  }
  if (body.auth_method && body.auth_method !== collector.auth_method) {
    return res.status(400).json({ error: 'auth_method cannot be changed. Delete the collector and create a new one.' });
  }

  const updates = {};
  const cap = registry.capabilityOf(collector.transfer_type);

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return res.status(400).json({ error: 'name must be a non-empty string' });
    }
    updates.name = body.name.trim();
  }

  if (body.input_format !== undefined) {
    if (!cap.inputFormats.includes(body.input_format)) {
      return res.status(400).json({
        error: `input_format "${body.input_format}" is not available for transfer_type "${collector.transfer_type}". Supported: ${cap.inputFormats.join(', ')}`,
      });
    }
    updates.input_format = body.input_format;
  }

  if (body.public_host !== undefined) {
    updates.public_host = body.public_host ? String(body.public_host).trim() : null;
  }

  // Refresh mode is the one auth setting that can be changed in place — it
  // alters how tokens are redeemed, not the credential itself.
  let refreshModeChange = null;
  if (body.oauth_refresh_mode !== undefined) {
    if (!registry.usesRefreshMode(collector.auth_method)) {
      return res.status(400).json({
        error: `oauth_refresh_mode only applies to collectors using OAuth client credentials. This collector uses "${collector.auth_method}".`,
      });
    }
    const resolved = registry.resolveRefreshMode(collector.auth_method, body.oauth_refresh_mode);
    if (!resolved.ok) return res.status(400).json({ error: resolved.error });

    const current = registry.refreshModeOf(collector);
    if (resolved.mode !== current) {
      updates.oauth_refresh_mode = resolved.mode;
      refreshModeChange = { from: current, to: resolved.mode };
    }
  }

  if (body.port !== undefined && cap.requiresPort) {
    const nextPort = parseInt(body.port, 10);
    if (!Number.isInteger(nextPort)) return res.status(400).json({ error: 'port must be an integer' });
    if (!listenerManager.isPortInRange(nextPort)) {
      const { min, max } = listenerManager.config.portRange;
      return res.status(400).json({ error: `Port must be within the configured range ${min}-${max}` });
    }
    if (nextPort === HTTP_PORT) {
      return res.status(400).json({ error: `Port ${nextPort} is used by the HTTP server` });
    }
    updates.port = nextPort;
  }

  const wantsEnabled = body.enabled !== undefined ? Boolean(body.enabled) : null;
  if (wantsEnabled !== null) updates.enabled = wantsEnabled ? 1 : 0;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updatable fields supplied' });
  }

  // Port/enable changes require the socket to be rebound — close first.
  const needsRebind =
    collector.transfer_type === 'udp' &&
    (updates.port !== undefined || wantsEnabled !== null);

  if (needsRebind) {
    await listenerManager.disable(id);
  }

  try {
    await db.query(new UpdateQuery('collectors').set(updates).where(eq('id', id)));
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'That name or port is already taken by another collector.' });
    }
    throw err;
  }

  // Outstanding refresh tokens carry the mode they were issued under, so a
  // mode switch would otherwise leave old-semantics tokens circulating
  // indefinitely. Revoking them forces one clean re-authentication via
  // client_credentials, after which every token follows the new mode.
  let revokedTokens = 0;
  if (refreshModeChange) {
    const result = await db.query(
      new UpdateQuery('oauth_refresh_tokens')
        .set({ revoked: 1 })
        .where(and(eq('collector_id', id), eq('revoked', 0)))
    );
    revokedTokens = Number(result?.changes || 0);
  }

  let updated = await findOwned(id, req.user.userId);

  // Re-bind when the collector should be running.
  if (collector.transfer_type === 'udp' && Number(updated.enabled) === 1) {
    const bind = await listenerManager.enable(updated);
    if (!bind.ok) {
      // Leave it disabled rather than reporting a state we could not achieve.
      await db.query(new UpdateQuery('collectors').set({ enabled: 0 }).where(eq('id', id)));
      updated = await findOwned(id, req.user.userId);
      return res.status(409).json({
        error: bind.message,
        code:  bind.code,
        collector: serialise(updated, req),
      });
    }
  }

  const extra = {};
  if (registry.usesRefreshMode(updated.auth_method)) {
    extra.refresh_tokens = await refreshTokenSummary(id);
  }
  if (refreshModeChange) {
    extra.refresh_mode_change = {
      ...refreshModeChange,
      revoked_tokens: revokedTokens,
      message: revokedTokens > 0
        ? `Switched to ${refreshModeChange.to} refresh tokens. ${revokedTokens} outstanding refresh token${revokedTokens === 1 ? '' : 's'} were revoked — clients must re-authenticate with client_credentials.`
        : `Switched to ${refreshModeChange.to} refresh tokens.`,
    };
  }

  res.json(serialise(updated, req, extra));
}));

/* ── POST /collectors/:id/rotate ────────────────────────────────────────────── */
router.post('/:id/rotate', sessionAuth, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid collector id' });

  const collector = await findOwned(id, req.user.userId);
  if (!collector) return res.status(404).json({ error: 'Collector not found' });

  if (collector.auth_method === 'none') {
    return res.status(400).json({ error: 'This collector has no credentials to rotate.' });
  }

  await db.query(new DeleteQuery('collector_credentials').where(eq('collector_id', id)));

  // Refresh tokens are redeemed against the collector, not the client secret,
  // so they would survive a rotation and keep minting access tokens for the
  // credential the user just retired. Revoke them with the secret.
  let revokedTokens = 0;
  if (registry.usesRefreshMode(collector.auth_method)) {
    const result = await db.query(
      new UpdateQuery('oauth_refresh_tokens')
        .set({ revoked: 1 })
        .where(and(eq('collector_id', id), eq('revoked', 0)))
    );
    revokedTokens = Number(result?.changes || 0);
  }

  const secrets = {};
  if (collector.auth_method === 'api_token') {
    const token = crypto.randomBytes(32).toString('hex');
    await db.query(
      new InsertQuery('collector_credentials').values({ collector_id: id, kind: 'api_token', token })
    );
    secrets.api_token = token;
  } else {
    const clientId     = crypto.randomUUID();
    const clientSecret = crypto.randomBytes(32).toString('hex');
    await db.query(
      new InsertQuery('collector_credentials').values({
        collector_id: id,
        kind:         'oauth_client',
        public_id:    clientId,
        secret_hash:  bcrypt.hashSync(clientSecret, 12),
      })
    );
    secrets.client_id     = clientId;
    secrets.client_secret = clientSecret;
  }

  const message = revokedTokens > 0
    ? `Credentials rotated. The previous credentials are now invalid, and ${revokedTokens} outstanding refresh token${revokedTokens === 1 ? ' was' : 's were'} revoked.`
    : 'Credentials rotated. The previous credentials are now invalid.';

  res.json({ message, secrets, revoked_refresh_tokens: revokedTokens });
}));

/* ── POST /collectors/:id/test ──────────────────────────────────────────────── */
router.post('/:id/test', sessionAuth, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid collector id' });

  const collector = await findOwned(id, req.user.userId);
  if (!collector) return res.status(404).json({ error: 'Collector not found' });

  if (collector.transfer_type !== 'udp') {
    return res.status(400).json({ error: 'Self-test is only available for UDP collectors.' });
  }

  const result = await listenerManager.selfTest(collector);
  res.status(result.ok ? 200 : 409).json(result);
}));

/* ── DELETE /collectors/:id ─────────────────────────────────────────────────── */
router.delete('/:id', sessionAuth, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid collector id' });

  const collector = await findOwned(id, req.user.userId);
  if (!collector) return res.status(404).json({ error: 'Collector not found' });

  await listenerManager.remove(id);
  await db.query(new DeleteQuery('collectors').where(and(eq('id', id), eq('user_id', req.user.userId))));

  res.json({ message: 'Collector deleted' });
}));

module.exports = router;
