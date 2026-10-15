'use strict';

const dgram = require('dgram');

const db                     = require('../db/database');
const { SelectQuery, eq, and } = require('../db/query');
const { UdpListener }        = require('./transports/udp');
const { parsePayload }       = require('./formats');
const { storeEvents, recordRejection } = require('./pipeline');

/* ── Configuration ──────────────────────────────────────────────────────────── */

const UDP_ENABLED       = String(process.env.UDP_ENABLED ?? 'true').toLowerCase() !== 'false';
const UDP_BIND_HOST     = process.env.UDP_BIND_HOST || '0.0.0.0';
const UDP_MAX_LISTENERS = parseInt(process.env.UDP_MAX_LISTENERS, 10) || 1;
const UDP_QUEUE_SIZE    = parseInt(process.env.UDP_QUEUE_SIZE, 10) || 5000;
const DRAIN_BATCH       = parseInt(process.env.UDP_DRAIN_BATCH, 10) || 200;
const RECONCILE_MS      = parseInt(process.env.UDP_RECONCILE_INTERVAL_MS, 10) || 60_000;

// Render routes HTTP only — a UDP socket binds fine inside the container but no
// external datagram will ever reach it. Detected so the UI can be honest.
const PLATFORM_NO_UDP_INGRESS = Boolean(process.env.RENDER);

function parsePortRange(raw) {
  const def = { min: 10000, max: 10010 };
  if (!raw) return def;
  const m = String(raw).match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return def;
  const min = parseInt(m[1], 10);
  const max = parseInt(m[2], 10);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) return def;
  return { min, max };
}

const PORT_RANGE = parsePortRange(process.env.UDP_PORT_RANGE);

/* ── Manager ────────────────────────────────────────────────────────────────── */

class ListenerManager {
  constructor() {
    /** @type {Map<number, UdpListener>} collectorId → listener */
    this.listeners = new Map();
    /** @type {Map<number, string>} collectorId → status string */
    this.statuses = new Map();

    this.queue        = [];
    this.queueDropped = 0;
    this.draining     = false;
    this.reconcileTimer = null;
    this.stopping     = false;
  }

  /* ── Config accessors (used by routes + UI) ──────────────────────────────── */

  get config() {
    return {
      enabled:            UDP_ENABLED,
      bindHost:           UDP_BIND_HOST,
      maxListeners:       UDP_MAX_LISTENERS,
      portRange:          PORT_RANGE,
      queueSize:          UDP_QUEUE_SIZE,
      platformNoIngress:  PLATFORM_NO_UDP_INGRESS,
      publicHost:         process.env.PUBLIC_INGEST_HOST || null,
    };
  }

  isPortInRange(port) {
    return Number.isInteger(port) && port >= PORT_RANGE.min && port <= PORT_RANGE.max;
  }

  activeListenerCount() {
    return this.listeners.size;
  }

  hasCapacity() {
    return this.listeners.size < UDP_MAX_LISTENERS;
  }

  /* ── Lifecycle ───────────────────────────────────────────────────────────── */

  async start() {
    if (!UDP_ENABLED) {
      console.log('[udp] UDP ingestion disabled (UDP_ENABLED=false)');
      return;
    }

    await this.reconcile();

    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch(err => console.error('[udp] reconcile failed:', err.message));
    }, RECONCILE_MS);
    if (this.reconcileTimer.unref) this.reconcileTimer.unref();

    const n = this.listeners.size;
    console.log(
      `[udp] Listener manager started — ${n} active listener(s), ` +
      `port range ${PORT_RANGE.min}-${PORT_RANGE.max}, max ${UDP_MAX_LISTENERS}`
    );
    if (PLATFORM_NO_UDP_INGRESS) {
      console.warn('[udp] Running on Render: sockets bind locally but the platform does not route inbound UDP. ' +
                   'Use tools/udp-forwarder or deploy on a host that routes UDP.');
    }
  }

  async stopAll() {
    this.stopping = true;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    const closing = [...this.listeners.values()].map(l => l.close());
    this.listeners.clear();
    await Promise.all(closing);
    await this.drainQueue();   // flush anything still buffered
    console.log('[udp] All listeners stopped');
  }

  /* ── Reconciliation ──────────────────────────────────────────────────────── */

  /**
   * Make the live sockets match the enabled UDP collectors in the database.
   * Safe to call repeatedly; runs on an interval and after every mutation.
   */
  async reconcile() {
    if (!UDP_ENABLED || this.stopping) return;

    const rows = await db.query(
      new SelectQuery('collectors')
        .where(and(eq('transfer_type', 'udp'), eq('enabled', 1)))
        .orderBy('created_at', 'ASC')
    );

    const wanted = new Map(rows.map(r => [Number(r.id), r]));

    // Close listeners whose collector was disabled, deleted, or re-ported.
    for (const [id, listener] of [...this.listeners.entries()]) {
      const row = wanted.get(id);
      if (!row || Number(row.port) !== listener.port) {
        await listener.close();
        this.listeners.delete(id);
        if (!row) this.statuses.delete(id);
      }
    }

    // Open listeners that should be running but are not.
    for (const [id, row] of wanted) {
      if (this.listeners.has(id)) continue;
      if (!this.hasCapacity()) {
        this.statuses.set(id, 'capacity_exceeded');
        continue;
      }
      await this._bind(row);
    }
  }

  /* ── Bind / unbind ───────────────────────────────────────────────────────── */

  /**
   * Bind a collector's listener immediately.
   * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
   */
  async enable(collector) {
    if (!UDP_ENABLED) {
      this.statuses.set(Number(collector.id), 'disabled_by_config');
      return { ok: false, code: 'UDP_DISABLED', message: 'UDP ingestion is disabled on this server (UDP_ENABLED=false)' };
    }
    const id = Number(collector.id);
    if (this.listeners.has(id)) return { ok: true };

    if (!this.hasCapacity()) {
      this.statuses.set(id, 'capacity_exceeded');
      return {
        ok: false,
        code: 'CAPACITY_EXCEEDED',
        message: `Only ${UDP_MAX_LISTENERS} UDP listener(s) may be active at a time. Disable the active listener first.`,
      };
    }
    return this._bind(collector);
  }

  async disable(collectorId) {
    const id = Number(collectorId);
    const listener = this.listeners.get(id);
    if (listener) {
      await listener.close();
      this.listeners.delete(id);
    }
    this.statuses.set(id, 'disabled');
    return { ok: true };
  }

  async remove(collectorId) {
    const id = Number(collectorId);
    const listener = this.listeners.get(id);
    if (listener) {
      await listener.close();
      this.listeners.delete(id);
    }
    this.statuses.delete(id);
  }

  async _bind(collector) {
    const id   = Number(collector.id);
    const port = Number(collector.port);
    const host = collector.bind_host || UDP_BIND_HOST;

    const listener = new UdpListener({
      port,
      host,
      label: `collector-${id}`,
      onDatagram: (buf) => this._handleDatagram(collector, buf),
    });

    try {
      await listener.start();
      this.listeners.set(id, listener);
      this.statuses.set(id, 'listening');
      console.log(`[udp] collector ${id} ("${collector.name}") listening on ${host}:${port}`);
      return { ok: true };
    } catch (err) {
      const code = err.code || 'BIND_ERROR';
      this.statuses.set(id, `bind_error:${code}`);
      console.error(`[udp] collector ${id} failed to bind ${host}:${port} — ${code}: ${err.message}`);
      return { ok: false, code, message: `Failed to bind UDP ${host}:${port} (${code})` };
    }
  }

  /* ── Datagram handling ───────────────────────────────────────────────────── */

  /**
   * UDP collectors are unauthenticated by design: the datagram arriving on the
   * dedicated port *is* the identification. Parse, enqueue, acknowledge nothing
   * (UDP has no response channel — failures are only visible via counters/logs).
   */
  _handleDatagram(collector, buf) {
    let parsed;
    try {
      parsed = parsePayload(collector.input_format, buf);
    } catch (err) {
      this._throttledWarn(
        `collector-${collector.id}-parse`,
        `[udp] collector ${collector.id} dropped a datagram: ${err.message}`
      );
      recordRejection(Number(collector.id), { packets: 1, rejected: 1 })
        .catch(e => console.error('[udp] counter update failed:', e.message));
      return;
    }

    if (this.queue.length >= UDP_QUEUE_SIZE) {
      this.queueDropped++;
      this._throttledWarn(
        'queue-full',
        `[udp] ingest queue full (${UDP_QUEUE_SIZE}); dropped ${this.queueDropped} datagram(s) so far`
      );
      return;
    }

    this.queue.push({
      userId:      Number(collector.user_id),
      collectorId: Number(collector.id),
      events:      parsed.events,
      rejected:    parsed.rejected,
    });

    this._scheduleDrain();
  }

  _scheduleDrain() {
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => {
      this.drainQueue()
        .catch(err => console.error('[udp] drain failed:', err.message))
        .finally(() => { this.draining = false; });
    });
  }

  /**
   * Drain the queue, grouping events into micro-batches so a burst of datagrams
   * does not open one DB transaction per packet.
   */
  async drainQueue() {
    while (this.queue.length > 0) {
      const first = this.queue.shift();
      const batch = {
        userId:      first.userId,
        collectorId: first.collectorId,
        events:      [...first.events],
        packets:     1,
        rejected:    first.rejected,
      };

      // Coalesce following items belonging to the same collector.
      while (
        this.queue.length > 0 &&
        this.queue[0].collectorId === batch.collectorId &&
        batch.events.length + this.queue[0].events.length <= DRAIN_BATCH
      ) {
        const next = this.queue.shift();
        batch.events.push(...next.events);
        batch.rejected += next.rejected;
        batch.packets  += 1;
      }

      try {
        await storeEvents(
          {
            userId:      batch.userId,
            collectorId: batch.collectorId,
            packets:     batch.packets,
            rejected:    batch.rejected,
          },
          batch.events
        );
      } catch (err) {
        console.error(`[udp] failed to store ${batch.events.length} event(s) for collector ${batch.collectorId}: ${err.message}`);
      }
    }
  }

  /* ── Status reporting ────────────────────────────────────────────────────── */

  statusOf(collectorId, collector) {
    const id = Number(collectorId);

    if (collector && collector.transfer_type !== 'udp') return 'n/a';
    if (!UDP_ENABLED) return 'disabled_by_config';
    if (collector && !collector.enabled) return 'disabled';

    const listener = this.listeners.get(id);
    if (listener && listener.started) {
      return PLATFORM_NO_UDP_INGRESS ? 'listening_no_platform_ingress' : 'listening';
    }
    return this.statuses.get(id) || 'stopped';
  }

  statsOf(collectorId) {
    const listener = this.listeners.get(Number(collectorId));
    return listener ? listener.snapshot() : null;
  }

  /* ── Loopback self-test ──────────────────────────────────────────────────── */

  /**
   * Send a datagram to the collector's own port from inside the process.
   * Proves parse → store works even where the platform blocks inbound UDP.
   */
  async selfTest(collector) {
    const id = Number(collector.id);
    if (!this.listeners.has(id)) {
      return { ok: false, error: `Collector ${id} has no active listener (status: ${this.statusOf(id, collector)})` };
    }

    const event = {
      app:     'logbase-selftest',
      level:   'info',
      message: `UDP self-test for collector "${collector.name}"`,
      collector_id: id,
      sent_at: new Date().toISOString(),
    };
    const payload = collector.input_format === 'json_array'
      ? JSON.stringify([event])
      : JSON.stringify(event) + '\n';

    const before = this.listeners.get(id).stats.packets;

    await new Promise((resolve, reject) => {
      const client = dgram.createSocket('udp4');
      client.send(Buffer.from(payload, 'utf8'), Number(collector.port), '127.0.0.1', (err) => {
        client.close();
        if (err) reject(err); else resolve();
      });
    });

    // Give the event loop a moment to deliver + drain.
    await new Promise(r => setTimeout(r, 250));
    await this.drainQueue();

    const after    = this.listeners.get(id)?.stats.packets ?? before;
    const received = after > before;

    return {
      ok: received,
      received,
      payload_sent: payload.trim(),
      message: received
        ? 'Self-test datagram was received and ingested. The listener works; any missing external traffic is a network/platform routing issue.'
        : 'Self-test datagram was not observed by the listener.',
    };
  }

  /* ── Internals ───────────────────────────────────────────────────────────── */

  _throttledWarn(key, message, intervalMs = 10_000) {
    this._warnTimes = this._warnTimes || new Map();
    const now  = Date.now();
    const last = this._warnTimes.get(key) || 0;
    if (now - last < intervalMs) return;
    this._warnTimes.set(key, now);
    console.warn(message);
  }
}

module.exports = new ListenerManager();
module.exports.ListenerManager = ListenerManager;
