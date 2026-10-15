#!/usr/bin/env node
'use strict';

/**
 * Logbase UDP → HTTP forwarder.
 *
 * Standalone helper for platforms that do not route inbound UDP (Render, most
 * PaaS web services). Run it next to your log source: it listens for datagrams
 * locally and forwards them to a Logbase HTTP collector over HTTPS.
 *
 *   LISTEN_PORT=10000 \
 *   LOGBASE_URL=https://your-app.onrender.com/logs \
 *   LOGBASE_TOKEN=<api token of an http collector> \
 *   INPUT_FORMAT=ndjson \
 *   node tools/udp-forwarder/index.js
 *
 * No dependencies — plain Node.
 */

const dgram = require('dgram');

const LISTEN_PORT  = parseInt(process.env.LISTEN_PORT, 10) || 10000;
const LISTEN_HOST  = process.env.LISTEN_HOST  || '0.0.0.0';
const LOGBASE_URL  = process.env.LOGBASE_URL  || 'http://localhost:3000/logs';
const TOKEN        = process.env.LOGBASE_TOKEN;
const INPUT_FORMAT = process.env.INPUT_FORMAT || 'ndjson';   // must match the collector
const FLUSH_MS     = parseInt(process.env.FLUSH_INTERVAL_MS, 10) || 1000;
const MAX_BATCH    = parseInt(process.env.MAX_BATCH, 10) || 200;

if (!TOKEN) {
  console.error('LOGBASE_TOKEN is required (API token of an HTTP collector)');
  process.exit(1);
}
if (!['ndjson', 'json_array'].includes(INPUT_FORMAT)) {
  console.error(`INPUT_FORMAT must be "ndjson" or "json_array" (got "${INPUT_FORMAT}")`);
  process.exit(1);
}

let buffer = [];
let sending = false;

function parseDatagram(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) events.push(...parsed.filter(e => e && typeof e === 'object'));
      else if (parsed && typeof parsed === 'object') events.push(parsed);
    } catch {
      // Not JSON — forward it as a plain message so nothing is silently lost.
      events.push({ message: trimmed });
    }
  }
  return events;
}

async function flush() {
  if (sending || buffer.length === 0) return;
  sending = true;

  const batch = buffer.splice(0, MAX_BATCH);
  const body  = INPUT_FORMAT === 'json_array'
    ? JSON.stringify(batch)
    : batch.map(e => JSON.stringify(e)).join('\n');

  try {
    const res = await fetch(LOGBASE_URL, {
      method: 'POST',
      headers: {
        'X-API-Token':  TOKEN,
        'Content-Type': INPUT_FORMAT === 'json_array' ? 'application/json' : 'application/x-ndjson',
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[forwarder] HTTP ${res.status}: ${text.slice(0, 200)}`);
    } else {
      const data = await res.json().catch(() => ({}));
      console.log(`[forwarder] forwarded ${batch.length} event(s) → inserted ${data.inserted ?? '?'}`);
    }
  } catch (err) {
    console.error(`[forwarder] send failed: ${err.message}`);
  } finally {
    sending = false;
  }
}

const socket = dgram.createSocket('udp4');

socket.on('message', (buf) => {
  const events = parseDatagram(buf.toString('utf8'));
  buffer.push(...events);
  if (buffer.length >= MAX_BATCH) flush();
});

socket.on('error', (err) => {
  console.error(`[forwarder] socket error: ${err.message}`);
  process.exit(1);
});

socket.on('listening', () => {
  console.log(`[forwarder] listening on udp://${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`[forwarder] forwarding to ${LOGBASE_URL} as ${INPUT_FORMAT}`);
});

socket.bind(LISTEN_PORT, LISTEN_HOST);

setInterval(flush, FLUSH_MS).unref?.();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`[forwarder] ${sig} — flushing…`);
    socket.close();
    await flush();
    process.exit(0);
  });
}
