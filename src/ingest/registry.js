'use strict';

/**
 * Ingestion capability registry.
 *
 * Single source of truth for which auth methods and input formats are valid for
 * each transfer type. Consumed by:
 *   - src/routes/collectors.js  → request validation
 *   - GET /collectors/capabilities → drives the dashboard dropdowns
 *
 * To add a transport (e.g. tcp): add an entry here, implement a listener under
 * src/ingest/transports, and register it in listenerManager.js. Nothing else
 * needs to change.
 */

const TRANSFER_TYPES = ['http', 'udp'];

const AUTH_METHODS = {
  api_token:               'API token (X-API-Token header)',
  oauth_client_credentials:'OAuth 2.0 client credentials',
  none:                    'No authentication',
};

const INPUT_FORMATS = {
  json_array: 'JSON array — each element is one event',
  ndjson:     'Newline-delimited JSON — each line is one event',
};

const CAPABILITIES = {
  http: {
    label:        'HTTP',
    description:  'POST events to /logs over HTTPS.',
    authMethods:  ['api_token', 'oauth_client_credentials'],
    inputFormats: ['json_array', 'ndjson'],
    requiresPort: false,
    maxPerUser:   null,
    supportsTls:  true,
  },
  udp: {
    label:        'UDP',
    description:  'Datagram listener bound to a dedicated port. Unauthenticated and unencrypted — use only on trusted networks.',
    authMethods:  ['none'],
    inputFormats: ['json_array', 'ndjson'],
    requiresPort: true,
    maxPerUser:   1,
    supportsTls:  false,
  },

  // tcp: {
  //   label:        'TCP',
  //   description:  'Line-delimited stream listener.',
  //   authMethods:  ['none'],
  //   inputFormats: ['ndjson'],
  //   requiresPort: true,
  //   maxPerUser:   1,
  //   supportsTls:  false,
  // },
};

/** @returns {boolean} whether the transfer type is known. */
function isTransferType(t) {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, t);
}

/** @returns {object|null} capability descriptor for a transfer type. */
function capabilityOf(transferType) {
  return CAPABILITIES[transferType] || null;
}

/**
 * Validate a transfer / auth / format triple.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateCombination(transferType, authMethod, inputFormat) {
  const cap = capabilityOf(transferType);
  if (!cap) {
    return { ok: false, error: `Unknown transfer_type "${transferType}". Supported: ${TRANSFER_TYPES.join(', ')}` };
  }
  if (!cap.authMethods.includes(authMethod)) {
    return {
      ok: false,
      error: `auth_method "${authMethod}" is not available for transfer_type "${transferType}". Supported: ${cap.authMethods.join(', ')}`,
    };
  }
  if (!cap.inputFormats.includes(inputFormat)) {
    return {
      ok: false,
      error: `input_format "${inputFormat}" is not available for transfer_type "${transferType}". Supported: ${cap.inputFormats.join(', ')}`,
    };
  }
  return { ok: true };
}

/**
 * Serialisable capability matrix for the UI.
 */
function capabilitiesPayload() {
  return {
    transferTypes: TRANSFER_TYPES.map(t => ({ value: t, ...CAPABILITIES[t] })),
    authMethods:   AUTH_METHODS,
    inputFormats:  INPUT_FORMATS,
  };
}

module.exports = {
  TRANSFER_TYPES,
  AUTH_METHODS,
  INPUT_FORMATS,
  CAPABILITIES,
  isTransferType,
  capabilityOf,
  validateCombination,
  capabilitiesPayload,
};
