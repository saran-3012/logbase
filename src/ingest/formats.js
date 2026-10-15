'use strict';

/**
 * Payload parsers — transport agnostic.
 *
 * A collector declares an input_format; both the HTTP route and the UDP
 * listener run the received bytes through parsePayload() so the batching
 * semantics are identical on every transport.
 *
 *   json_array → the payload is a JSON array; each element is one event.
 *   ndjson     → the payload is newline-delimited JSON; each line is one event.
 *                Malformed lines are counted in `rejected` instead of failing
 *                the whole batch (important for lossy/streamed sources).
 */

const MAX_BATCH_SIZE = parseInt(process.env.MAX_BATCH_SIZE, 10) || 1000;

/** Error thrown when the payload itself is structurally unusable. */
class PayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PayloadError';
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function toText(input) {
  if (Buffer.isBuffer(input)) return input.toString('utf8');
  if (typeof input === 'string') return input;
  // Already-parsed body (express.json) — re-serialise so one code path handles all.
  if (input !== null && typeof input === 'object') return JSON.stringify(input);
  throw new PayloadError('Payload must be a string, Buffer, or JSON value');
}

/* ── json_array ─────────────────────────────────────────────────────────────── */

function parseJsonArray(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PayloadError(`Invalid JSON: ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new PayloadError(
      `Collector expects input_format "json_array" — payload must be a JSON array, received ${
        isPlainObject(parsed) ? 'a JSON object' : typeof parsed
      }`
    );
  }

  const events   = [];
  const errors   = [];
  let   rejected = 0;

  for (let i = 0; i < parsed.length; i++) {
    if (!isPlainObject(parsed[i])) {
      rejected++;
      if (errors.length < 10) errors.push(`Element at index ${i} is not a JSON object`);
      continue;
    }
    events.push(parsed[i]);
  }

  return { events, rejected, errors };
}

/* ── ndjson ─────────────────────────────────────────────────────────────────── */

function parseNdjson(text) {
  const events   = [];
  const errors   = [];
  let   rejected = 0;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      rejected++;
      if (errors.length < 10) errors.push(`Line ${i + 1}: invalid JSON (${err.message})`);
      continue;
    }

    if (!isPlainObject(parsed)) {
      rejected++;
      if (errors.length < 10) errors.push(`Line ${i + 1}: expected a JSON object`);
      continue;
    }
    events.push(parsed);
  }

  return { events, rejected, errors };
}

/* ── Public API ─────────────────────────────────────────────────────────────── */

/**
 * Parse a raw payload according to the collector's declared input format.
 *
 * @param {'json_array'|'ndjson'} format
 * @param {string|Buffer|object}  input
 * @returns {{ events: object[], rejected: number, errors: string[] }}
 * @throws  {PayloadError} when the payload is structurally invalid or over the batch cap
 */
function parsePayload(format, input) {
  const text = toText(input);

  if (!text.trim()) {
    throw new PayloadError('Payload is empty');
  }

  let result;
  switch (format) {
    case 'json_array': result = parseJsonArray(text); break;
    case 'ndjson':     result = parseNdjson(text);    break;
    default:
      throw new PayloadError(`Unknown input_format "${format}"`);
  }

  if (result.events.length === 0) {
    throw new PayloadError(
      result.rejected > 0
        ? `No valid events in payload (${result.rejected} rejected): ${result.errors.join('; ')}`
        : 'Payload contained no events'
    );
  }

  if (result.events.length > MAX_BATCH_SIZE) {
    throw new PayloadError(`Batch size cannot exceed ${MAX_BATCH_SIZE} events (received ${result.events.length})`);
  }

  return result;
}

module.exports = { parsePayload, PayloadError, MAX_BATCH_SIZE };
