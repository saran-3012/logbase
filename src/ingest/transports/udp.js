'use strict';

const dgram = require('dgram');

const MAX_PACKET_BYTES = parseInt(process.env.UDP_MAX_PACKET_BYTES, 10) || 65507;

/**
 * A single bound UDP socket.
 *
 * Deliberately dumb: it owns the socket lifecycle and counters only. Collector
 * resolution, parsing, and persistence live in listenerManager.js so this class
 * stays reusable and easy to reason about.
 *
 * Failure policy: the `message` handler never throws. A malformed datagram must
 * not be able to kill the socket (and therefore the whole listener).
 */
class UdpListener {
  /**
   * @param {object}   opts
   * @param {number}   opts.port
   * @param {string}  [opts.host='0.0.0.0']
   * @param {function} opts.onDatagram  — (buffer, rinfo) => void | Promise<void>
   * @param {function} [opts.onError]   — (err) => void, for post-bind runtime errors
   * @param {string|number} [opts.label] — used in log lines
   */
  constructor({ port, host = '0.0.0.0', onDatagram, onError, label }) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`UdpListener: invalid port "${port}"`);
    }
    if (typeof onDatagram !== 'function') {
      throw new Error('UdpListener: onDatagram callback is required');
    }

    this.port       = port;
    this.host       = host;
    this.label      = label != null ? String(label) : `udp:${port}`;
    this.onDatagram = onDatagram;
    this.onError    = onError || (() => {});

    this.socket  = null;
    this.started = false;

    this.stats = {
      packets:      0,
      bytes:        0,
      oversized:    0,
      handlerErrors:0,
      lastPacketAt: null,
      startedAt:    null,
    };
  }

  /**
   * Bind the socket.
   * @returns {Promise<void>} resolves once listening; rejects with an Error
   *          carrying `.code` (EADDRINUSE / EACCES / EADDRNOTAVAIL / …) on failure.
   */
  start() {
    if (this.started) return Promise.resolve();

    return new Promise((resolve, reject) => {
      // reuseAddr:false — we *want* a hard EADDRINUSE so port conflicts surface
      // to the user instead of two collectors silently sharing a port.
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      let settled = false;

      const onBindError = (err) => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        try { socket.close(); } catch { /* already closed */ }
        reject(err);
      };

      socket.once('error', onBindError);

      socket.once('listening', () => {
        if (settled) return;
        settled = true;
        socket.removeListener('error', onBindError);

        // Runtime errors after bind must not crash the process.
        socket.on('error', (err) => {
          console.error(`[udp:${this.label}] socket error: ${err.message}`);
          this.onError(err);
        });

        this.socket           = socket;
        this.started          = true;
        this.stats.startedAt  = Date.now();
        resolve();
      });

      socket.on('message', (buf, rinfo) => {
        this.stats.packets++;
        this.stats.bytes       += buf.length;
        this.stats.lastPacketAt = Date.now();

        if (buf.length > MAX_PACKET_BYTES) {
          this.stats.oversized++;
          console.warn(`[udp:${this.label}] dropped oversized datagram (${buf.length} bytes) from ${rinfo.address}`);
          return;
        }

        try {
          const maybePromise = this.onDatagram(buf, rinfo);
          if (maybePromise && typeof maybePromise.catch === 'function') {
            maybePromise.catch((err) => {
              this.stats.handlerErrors++;
              console.error(`[udp:${this.label}] handler error: ${err.message}`);
            });
          }
        } catch (err) {
          this.stats.handlerErrors++;
          console.error(`[udp:${this.label}] handler error: ${err.message}`);
        }
      });

      try {
        socket.bind(this.port, this.host);
      } catch (err) {
        onBindError(err);
      }
    });
  }

  /** Close the socket. Safe to call repeatedly. */
  close() {
    return new Promise((resolve) => {
      if (!this.socket) { this.started = false; return resolve(); }
      const socket = this.socket;
      this.socket  = null;
      this.started = false;
      try {
        socket.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  snapshot() {
    return { port: this.port, host: this.host, started: this.started, ...this.stats };
  }
}

module.exports = { UdpListener, MAX_PACKET_BYTES };
