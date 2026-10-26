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

/**
 * Refresh-token behaviour for auth_method = 'oauth_client_credentials'.
 *
 *   rotating — every POST /oauth/token with grant_type=refresh_token consumes the
 *              presented token and returns a new one. Replaying a consumed token
 *              is treated as theft and revokes the whole family (OAuth 2.1 /
 *              RFC 6819 §5.2.2.3 recommended behaviour).
 *
 *   static   — the refresh token is long-lived and reusable until it expires or
 *              is revoked. The client stores one credential and never has to
 *              persist a rotating value. Simpler for daemons and embedded
 *              senders that cannot safely write state, at the cost of losing
 *              replay detection.
 */
const OAUTH_REFRESH_MODES = {
  rotating: {
    label:       'Rotating refresh tokens',
    short:       'Rotating',
    description: 'Each refresh returns a new refresh token and invalidates the old one. Replay of a used token revokes every token for this collector.',
    recommended: true,
  },
  static: {
    label:       'Static refresh token',
    short:       'Static',
    description: 'One long-lived refresh token is reused until it expires or you revoke it. Easier for clients that cannot persist a changing credential; no replay detection.',
    recommended: false,
  },
};

const DEFAULT_OAUTH_REFRESH_MODE = 'rotating';

/** @returns {boolean} whether the value is a known refresh mode. */
function isRefreshMode(mode) {
  return Object.prototype.hasOwnProperty.call(OAUTH_REFRESH_MODES, mode);
}

/** @returns {boolean} whether an auth method carries a refresh-mode setting. */
function usesRefreshMode(authMethod) {
  return authMethod === 'oauth_client_credentials';
}

/**
 * Normalise the stored refresh mode for a collector row.
 * A NULL column on an OAuth collector (pre-v3 rows) reads as 'rotating',
 * which is exactly how those tokens were issued.
 */
function refreshModeOf(collector) {
  if (!collector || !usesRefreshMode(collector.auth_method)) return null;
  const mode = collector.oauth_refresh_mode;
  return isRefreshMode(mode) ? mode : DEFAULT_OAUTH_REFRESH_MODE;
}

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
 * Validate a requested refresh mode against the chosen auth method.
 *
 * Returns the value to persist in collectors.oauth_refresh_mode:
 *   - null for auth methods that have no refresh tokens
 *   - the validated mode otherwise (defaulted when not supplied)
 *
 * @returns {{ ok: true, mode: string|null } | { ok: false, error: string }}
 */
function resolveRefreshMode(authMethod, requested) {
  if (!usesRefreshMode(authMethod)) {
    if (requested != null && requested !== '') {
      return {
        ok: false,
        error: `oauth_refresh_mode only applies to auth_method "oauth_client_credentials", not "${authMethod}".`,
      };
    }
    return { ok: true, mode: null };
  }

  if (requested == null || requested === '') {
    return { ok: true, mode: DEFAULT_OAUTH_REFRESH_MODE };
  }
  if (!isRefreshMode(requested)) {
    return {
      ok: false,
      error: `Unknown oauth_refresh_mode "${requested}". Supported: ${Object.keys(OAUTH_REFRESH_MODES).join(', ')}`,
    };
  }
  return { ok: true, mode: requested };
}

/**
 * Serialisable capability matrix for the UI.
 */
function capabilitiesPayload() {
  return {
    transferTypes:      TRANSFER_TYPES.map(t => ({ value: t, ...CAPABILITIES[t] })),
    authMethods:        AUTH_METHODS,
    inputFormats:       INPUT_FORMATS,
    oauthRefreshModes:  OAUTH_REFRESH_MODES,
    defaultRefreshMode: DEFAULT_OAUTH_REFRESH_MODE,
  };
}

module.exports = {
  TRANSFER_TYPES,
  AUTH_METHODS,
  INPUT_FORMATS,
  CAPABILITIES,
  OAUTH_REFRESH_MODES,
  DEFAULT_OAUTH_REFRESH_MODE,
  isTransferType,
  capabilityOf,
  validateCombination,
  isRefreshMode,
  usesRefreshMode,
  refreshModeOf,
  resolveRefreshMode,
  capabilitiesPayload,
};
