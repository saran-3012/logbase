'use strict';

/* ── State ─────────────────────────────────────────────────────────────────── */
let expandedRowId  = null;
let autoRefreshId  = null;
let collectorData  = [];
let capabilities   = null;
let snippetLang    = 'curl';

const logState = {
  page: 1, limit: 50,
  search: '', app: '', level: '', from: '', to: ''
};

/* ── Utilities ─────────────────────────────────────────────────────────────── */

function escHtml(s) {
  return String(s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

function relTime(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s <   5) return 'just now';
  if (s <  60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

function fmtDate(ms) {
  return new Date(ms).toLocaleString();
}

/* ── Auth helpers ─────────────────────────────────────────────────────────── */

function getAuthToken() {
  return localStorage.getItem('authToken');
}

function logout() {
  localStorage.removeItem('authToken');
  localStorage.removeItem('authUser');
  window.location.href = '/';
}

async function apiFetch(method, path, body) {
  const token = getAuthToken();
  if (!token) { logout(); return null; }

  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json'
    }
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res  = await fetch(path, opts);
  if (res.status === 401) { logout(); return null; }

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

/* ── Section switching ─────────────────────────────────────────────────────── */

function showSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.getElementById(`section-${name}`).classList.remove('hidden');
  document.querySelector(`.nav-link[data-section="${name}"]`).classList.add('active');

  if (name === 'logs')       { loadAppFilter(); loadLogs(); }
  if (name === 'collectors') loadCollectors();
}

/* ══════════════════════════════════════════════════════════════════════════
   COLLECTORS
   ══════════════════════════════════════════════════════════════════════════ */

/* ── Capabilities → form wiring ────────────────────────────────────────────── */

async function loadCapabilities() {
  if (capabilities) return capabilities;
  capabilities = await apiFetch('GET', '/collectors/capabilities');
  return capabilities;
}

function transferCap(value) {
  return capabilities?.transferTypes.find(t => t.value === value) || null;
}

async function initCollectorForm() {
  const caps = await loadCapabilities();
  if (!caps) return;

  const transferSel = document.getElementById('collector-transfer');
  transferSel.innerHTML = caps.transferTypes
    .map(t => `<option value="${escHtml(t.value)}">${escHtml(t.label)}</option>`)
    .join('');

  // Platform warning banner (Render does not route inbound UDP)
  const note = document.getElementById('udp-platform-note');
  if (caps.udp?.platform_no_ingress) {
    note.innerHTML =
      '<strong>Heads-up:</strong> this host does not route inbound UDP traffic. A UDP collector will bind ' +
      'and the ingest pipeline works (verify with <em>Test</em>), but external datagrams will not arrive. ' +
      'Run Logbase on Docker/a VPS, or use <code>tools/udp-forwarder</code> next to your log source.';
    note.classList.remove('hidden');
  } else if (caps.udp && !caps.udp.enabled) {
    note.textContent = 'UDP ingestion is disabled on this server (UDP_ENABLED=false).';
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }

  onTransferTypeChange();
}

function onTransferTypeChange() {
  const value = document.getElementById('collector-transfer').value;
  const cap   = transferCap(value);
  if (!cap) return;

  const authSel   = document.getElementById('collector-auth');
  const formatSel = document.getElementById('collector-format');

  authSel.innerHTML = cap.authMethods
    .map(a => `<option value="${escHtml(a)}">${escHtml(capabilities.authMethods[a] || a)}</option>`)
    .join('');

  formatSel.innerHTML = cap.inputFormats
    .map(f => `<option value="${escHtml(f)}">${escHtml(capabilities.inputFormats[f] || f)}</option>`)
    .join('');

  // Port + host inputs only apply to listener-based transports.
  document.getElementById('fgroup-port').classList.toggle('hidden', !cap.requiresPort);
  document.getElementById('fgroup-public-host').classList.toggle('hidden', !cap.requiresPort);

  const hint = document.getElementById('transfer-hint');
  let text = cap.description;
  if (cap.requiresPort && capabilities.udp) {
    const r = capabilities.udp.port_range;
    text += ` Port must be between ${r.min} and ${r.max}.`;
    text += ` At most ${cap.maxPerUser} per user; ${capabilities.udp.max_listeners} listener(s) may be active server-wide.`;
    document.getElementById('collector-port').placeholder = String(r.min);
  }
  hint.textContent = text;
}

/* ── List + render ─────────────────────────────────────────────────────────── */

async function loadCollectors() {
  const tbody = document.getElementById('collector-list');
  tbody.innerHTML = '<tr><td colspan="8" class="loading-cell">Loading…</td></tr>';
  try {
    await initCollectorForm();
    collectorData = await apiFetch('GET', '/collectors') || [];
    renderCollectors(collectorData);
    populateSnippetSelect(collectorData);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="error-cell">${escHtml(err.message)}</td></tr>`;
  }
}

function statusBadge(status) {
  const map = {
    listening:                     ['status-listening', 'Listening'],
    listening_no_platform_ingress: ['status-warn',      'Bound (no platform ingress)'],
    disabled:                      ['status-off',       'Disabled'],
    disabled_by_config:            ['status-off',       'UDP disabled on server'],
    capacity_exceeded:             ['status-warn',      'Listener slot taken'],
    stopped:                       ['status-off',       'Stopped'],
    'n/a':                         ['status-off',       '—'],
  };
  if (status && status.startsWith('bind_error')) {
    return `<span class="status-badge status-error" title="${escHtml(status)}">Bind error</span>`;
  }
  const [cls, label] = map[status] || ['status-off', status || '—'];
  return `<span class="status-badge ${cls}" title="${escHtml(status || '')}">${escHtml(label)}</span>`;
}

function renderCollectors(collectors) {
  const tbody = document.getElementById('collector-list');
  if (!collectors.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No collectors yet. Create one above to start ingesting logs.</td></tr>';
    return;
  }

  tbody.innerHTML = collectors.map(c => {
    const cred = (c.credentials || [])[0];
    const credLine = cred
      ? (cred.token_preview
          ? `<div class="muted" style="font-size:.78rem;margin-top:.2rem;"><code>${escHtml(cred.token_preview)}</code></div>`
          : `<div class="muted" style="font-size:.78rem;margin-top:.2rem;"><code>${escHtml(cred.public_id || '')}</code></div>`)
      : '';

    const isUdp = c.transfer_type === 'udp';

    return `
      <tr>
        <td>
          ${escHtml(c.name)}
          <div class="muted" style="font-size:.75rem;">${escHtml(fmtDate(c.created_at * 1000))}</div>
        </td>
        <td><span class="level-badge ${isUdp ? 'level-warn' : 'level-info'}">${escHtml(c.transfer_type)}</span></td>
        <td>${escHtml(c.auth_method)}${credLine}</td>
        <td><code>${escHtml(c.input_format)}</code></td>
        <td><code>${escHtml(c.endpoint || '—')}</code></td>
        <td>${statusBadge(c.listener_status)}</td>
        <td>
          ${Number(c.events_received).toLocaleString()}
          ${c.last_event_at ? `<div class="muted" style="font-size:.75rem;">${escHtml(relTime(c.last_event_at * 1000))}</div>` : ''}
        </td>
        <td>
          <div class="row-actions">
            <label class="switch" title="${c.enabled ? 'Disable' : 'Enable'} collector">
              <input type="checkbox" ${c.enabled ? 'checked' : ''}
                     onchange="handleToggleCollector(${c.id}, this.checked, this)" />
              <span class="slider"></span>
            </label>
            ${isUdp ? `<button class="btn btn-ghost btn-sm" onclick="handleTestCollector(${c.id})">Test</button>` : ''}
            ${c.auth_method !== 'none' ? `<button class="btn btn-ghost btn-sm" onclick="handleRotateCollector(${c.id}, '${escHtml(c.name)}')">Rotate</button>` : ''}
            <button class="btn btn-danger btn-sm" onclick="handleDeleteCollector(${c.id}, '${escHtml(c.name)}')">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

/* ── Mutations ─────────────────────────────────────────────────────────────── */

async function handleCreateCollector(e) {
  e.preventDefault();

  const payload = {
    name:          document.getElementById('collector-name').value.trim(),
    transfer_type: document.getElementById('collector-transfer').value,
    auth_method:   document.getElementById('collector-auth').value,
    input_format:  document.getElementById('collector-format').value,
  };
  if (!payload.name) return;

  const cap = transferCap(payload.transfer_type);
  if (cap?.requiresPort) {
    payload.port        = parseInt(document.getElementById('collector-port').value, 10);
    payload.public_host = document.getElementById('collector-public-host').value.trim() || undefined;
    if (!Number.isInteger(payload.port)) {
      showAlert('collector-alert', 'A port is required for this transfer type', 'error');
      return;
    }
  }

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled    = true;
  btn.textContent = 'Creating…';

  try {
    const result = await apiFetch('POST', '/collectors', payload);
    document.getElementById('collector-name').value        = '';
    document.getElementById('collector-port').value        = '';
    document.getElementById('collector-public-host').value = '';

    if (result.secrets && Object.keys(result.secrets).length) {
      showSecretModal(`Collector created: ${result.name}`, result.secrets);
    } else {
      showAlert('collector-alert', `Collector "${result.name}" created.`, 'success');
    }
    await loadCollectors();
  } catch (err) {
    showAlert('collector-alert', err.message, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Create Collector';
  }
}

async function handleToggleCollector(id, enabled, inputEl) {
  inputEl.disabled = true;
  try {
    await apiFetch('PATCH', `/collectors/${id}`, { enabled });
    await loadCollectors();
  } catch (err) {
    inputEl.checked = !enabled;   // revert the switch — the change did not take
    showAlert('collector-alert', err.message, 'error');
    await loadCollectors();
  } finally {
    inputEl.disabled = false;
  }
}

async function handleDeleteCollector(id, name) {
  if (!confirm(`Delete collector "${name}"?\n\nIts credentials are revoked immediately and any listener is stopped.`)) return;
  try {
    await apiFetch('DELETE', `/collectors/${id}`);
    await loadCollectors();
  } catch (err) {
    showAlert('collector-alert', err.message, 'error');
  }
}

async function handleRotateCollector(id, name) {
  if (!confirm(`Rotate credentials for "${name}"?\n\nThe current credentials stop working immediately.`)) return;
  try {
    const result = await apiFetch('POST', `/collectors/${id}/rotate`);
    showSecretModal(`New credentials: ${name}`, result.secrets);
    await loadCollectors();
  } catch (err) {
    showAlert('collector-alert', err.message, 'error');
  }
}

async function handleTestCollector(id) {
  try {
    const result = await apiFetch('POST', `/collectors/${id}/test`);
    showAlert('collector-alert', result.message, result.ok ? 'success' : 'error');
    await loadCollectors();
  } catch (err) {
    showAlert('collector-alert', err.message, 'error');
  }
}

/* ── Credentials modal ─────────────────────────────────────────────────────── */

function showSecretModal(title, secrets) {
  document.getElementById('secret-modal-title').textContent = title;
  document.getElementById('secret-modal-body').innerHTML = Object.entries(secrets).map(([k, v]) => `
    <div style="margin-bottom:.75rem;">
      <div class="expand-label" style="margin-bottom:.3rem;">${escHtml(k)}</div>
      <div class="token-display" data-secret="${escHtml(k)}">${escHtml(v)}</div>
    </div>
  `).join('');
  document.getElementById('secret-modal').classList.remove('hidden');
}

function closeSecretModal() {
  document.getElementById('secret-modal').classList.add('hidden');
}

function copySecrets() {
  const text = [...document.querySelectorAll('#secret-modal-body .token-display')]
    .map(el => `${el.dataset.secret}: ${el.textContent}`)
    .join('\n');
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copy-secret-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  });
}

/* ── Integration snippets ──────────────────────────────────────────────────── */

function populateSnippetSelect(collectors) {
  const sel = document.getElementById('snippet-collector-select');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">— select a collector —</option>' +
    collectors.map(c => `<option value="${c.id}">${escHtml(c.name)} (${escHtml(c.transfer_type)})</option>`).join('');
  sel.value = prev;
  updateSnippet();
}

function snippetLanguagesFor(collector) {
  if (!collector) return ['curl'];
  return collector.transfer_type === 'udp'
    ? ['netcat', 'node', 'python']
    : ['curl', 'node', 'python'];
}

function sampleEvents(format) {
  const a = { app: 'my-service', level: 'error', message: 'Something went wrong', userId: 42 };
  const b = { app: 'my-service', level: 'info',  message: 'Recovered' };
  return format === 'json_array'
    ? JSON.stringify([a, b])
    : `${JSON.stringify(a)}\n${JSON.stringify(b)}`;
}

function buildSnippet(collector, lang) {
  if (!collector) return 'Select a collector to see a ready-to-use example.';

  const format  = collector.input_format;
  const payload = sampleEvents(format);

  /* ── UDP ─────────────────────────────────────────────────────────────── */
  if (collector.transfer_type === 'udp') {
    const [host, port] = String(collector.endpoint || '').split(':');
    const note = `# UDP is unauthenticated: anything sent to ${host}:${port} is ingested into this collector.
# There is no response and no delivery guarantee. Keep each batch inside one
# datagram (~1472 bytes is the safe MTU limit; ${format === 'json_array'
  ? 'an oversized JSON array arrives truncated and fails to parse'
  : 'NDJSON degrades gracefully — only the clipped line is lost'}).`;

    if (lang === 'netcat') {
      return `${note}

# Single batch
printf '%s' '${payload.replace(/\n/g, '\\n')}' | nc -u -w1 ${host} ${port}

# Or with socat
echo '${payload.split('\n')[0]}' | socat - UDP-DATAGRAM:${host}:${port}`;
    }

    if (lang === 'node') {
      return `${note}

const dgram = require('dgram');
const client = dgram.createSocket('udp4');

const events = [
  { app: 'my-service', level: 'error', message: 'Something went wrong', userId: 42 },
  { app: 'my-service', level: 'info',  message: 'Recovered' }
];

const payload = ${format === 'json_array'
  ? 'JSON.stringify(events)'
  : "events.map(e => JSON.stringify(e)).join('\\n')"};

client.send(Buffer.from(payload), ${port}, '${host}', (err) => {
  if (err) console.error(err);
  client.close();
});`;
    }

    return `${note}

import json
import socket

events = [
    {'app': 'my-service', 'level': 'error', 'message': 'Something went wrong', 'userId': 42},
    {'app': 'my-service', 'level': 'info',  'message': 'Recovered'},
]

payload = ${format === 'json_array'
  ? 'json.dumps(events)'
  : "'\\n'.join(json.dumps(e) for e in events)"}

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.sendto(payload.encode(), ('${host}', ${port}))
sock.close()`;
  }

  /* ── HTTP ────────────────────────────────────────────────────────────── */
  const url         = collector.endpoint;
  const contentType = format === 'ndjson' ? 'application/x-ndjson' : 'application/json';
  const isOAuth     = collector.auth_method === 'oauth_client_credentials';
  const authHeader  = isOAuth
    ? 'Authorization: Bearer <ACCESS_TOKEN>'
    : 'X-API-Token: <YOUR_API_TOKEN>';

  if (lang === 'curl') {
    const oauthStep = isOAuth ? `# Step 1 — exchange client credentials for an access token (valid 1 hour)
curl -X POST ${window.location.origin}/oauth/token \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=client_credentials&client_id=<CLIENT_ID>&client_secret=<CLIENT_SECRET>"

# Step 2 — push a batch
` : '';

    return `${oauthStep}curl -X POST ${url} \\
  -H "${authHeader}" \\
  -H "Content-Type: ${contentType}" \\
  --data-binary '${payload}'

# Response: { "ok": true, "inserted": 2, "rejected": 0 }
# This collector expects "${format}"${format === 'json_array'
  ? ' — send a JSON array; each element is one event.'
  : ' — send one JSON object per line.'}`;
  }

  if (lang === 'node') {
    return `const events = [
  { app: 'my-service', level: 'error', message: 'Something went wrong', userId: 42 },
  { app: 'my-service', level: 'info',  message: 'Recovered' }
];

const body = ${format === 'json_array'
  ? 'JSON.stringify(events)'
  : "events.map(e => JSON.stringify(e)).join('\\n')"};

const res = await fetch('${url}', {
  method: 'POST',
  headers: {
    '${authHeader.split(':')[0]}': '${authHeader.split(': ')[1]}',
    'Content-Type': '${contentType}'
  },
  body
});
const data = await res.json();   // { ok: true, inserted: 2, rejected: 0 }`;
  }

  return `import json
import requests

events = [
    {'app': 'my-service', 'level': 'error', 'message': 'Something went wrong', 'userId': 42},
    {'app': 'my-service', 'level': 'info',  'message': 'Recovered'},
]

body = ${format === 'json_array'
  ? 'json.dumps(events)'
  : "'\\n'.join(json.dumps(e) for e in events)"}

response = requests.post(
    '${url}',
    headers={
        '${authHeader.split(':')[0]}': '${authHeader.split(': ')[1]}',
        'Content-Type': '${contentType}',
    },
    data=body,
)
print(response.json())   # { 'ok': True, 'inserted': 2, 'rejected': 0 }`;
}

function updateSnippet() {
  const sel       = document.getElementById('snippet-collector-select');
  const collector = collectorData.find(c => String(c.id) === sel?.value) || null;
  const langs     = snippetLanguagesFor(collector);

  if (!langs.includes(snippetLang)) snippetLang = langs[0];

  document.getElementById('snippet-tabs').innerHTML = langs.map(l =>
    `<button class="snippet-tab${l === snippetLang ? ' active' : ''}" data-lang="${l}">${escHtml(l)}</button>`
  ).join('');

  document.querySelectorAll('#snippet-tabs .snippet-tab').forEach(t => {
    t.addEventListener('click', () => { snippetLang = t.dataset.lang; updateSnippet(); });
  });

  document.querySelector('#snippet-pane pre').textContent = buildSnippet(collector, snippetLang);
}

/* ══════════════════════════════════════════════════════════════════════════
   LOGS
   ══════════════════════════════════════════════════════════════════════════ */

async function loadAppFilter() {
  try {
    const apps = await apiFetch('GET', '/logs/apps') || [];
    const sel  = document.getElementById('filter-app');
    const prev = sel.value;
    sel.innerHTML = '<option value="">All Apps</option>' +
      apps.map(a => `<option value="${escHtml(a)}">${escHtml(a)}</option>`).join('');
    sel.value = prev; // restore selection
  } catch { /* non-fatal */ }
}

async function loadLogs() {
  const tbody  = document.getElementById('logs-body');
  const params = new URLSearchParams();

  if (logState.search) params.set('search', logState.search);
  if (logState.app)    params.set('app',    logState.app);
  if (logState.level)  params.set('level',  logState.level);
  if (logState.from)   params.set('from',   logState.from);
  if (logState.to)     params.set('to',     logState.to);
  params.set('page',  logState.page);
  params.set('limit', logState.limit);

  tbody.innerHTML = '<tr><td colspan="5" class="loading-cell">Loading…</td></tr>';

  try {
    const data = await apiFetch('GET', `/logs?${params}`);
    if (!data) return;
    renderLogs(data.logs);
    renderPagination(data.pagination);
    const n = data.pagination.total;
    document.getElementById('log-count').textContent =
      `${n.toLocaleString()} log${n !== 1 ? 's' : ''}`;
  } catch (err) {
    tbody.innerHTML =
      `<tr><td colspan="5" class="error-cell">${escHtml(err.message)}</td></tr>`;
  }
}

function levelClass(level) {
  switch ((level || '').toLowerCase()) {
    case 'error': case 'critical': case 'fatal': return 'level-error';
    case 'warn':  case 'warning':                return 'level-warn';
    case 'info':                                 return 'level-info';
    case 'debug':                                return 'level-debug';
    case 'trace':                                return 'level-trace';
    default:                                     return 'level-default';
  }
}

function renderLogs(logs) {
  const tbody = document.getElementById('logs-body');
  expandedRowId = null;

  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">No logs found.</td></tr>';
    return;
  }

  tbody.innerHTML = logs.map(log => {
    const fullEntry = {
      timestamp: new Date(log.timestamp).toISOString(),
      app: log.app_name, level: log.level, message: log.message,
      collector: log.collector_name || null,
      transfer:  log.transfer_type  || null,
      ...log.metadata
    };
    const jsonStr = JSON.stringify(fullEntry, null, 2);
    const preview = log.message.length > 120
      ? log.message.slice(0, 120) + '…'
      : log.message;
    const via = log.collector_name
      ? `<div class="muted" style="font-size:.72rem;">via ${escHtml(log.collector_name)}</div>`
      : '';

    return `
      <tr class="log-row" data-id="${log.id}" onclick="toggleExpand(${log.id}, this)">
        <td class="col-time" title="${escHtml(fmtDate(log.timestamp))}">
          ${escHtml(relTime(log.timestamp))}
        </td>
        <td class="col-app">${escHtml(log.app_name)}${via}</td>
        <td class="col-level">
          <span class="level-badge ${levelClass(log.level)}">${escHtml(log.level)}</span>
        </td>
        <td class="col-message">${escHtml(preview)}</td>
        <td class="col-expand">&#9654;</td>
      </tr>
      <tr class="expand-row hidden" id="expand-${log.id}">
        <td colspan="5">
          <div class="expand-content">
            <div class="expand-label">Full Log Entry</div>
            <pre class="json-view">${escHtml(jsonStr)}</pre>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function toggleExpand(id, clickedRow) {
  const expandRow = document.getElementById(`expand-${id}`);
  const arrow     = clickedRow.querySelector('.col-expand');

  // Collapse previously expanded row
  if (expandedRowId && expandedRowId !== id) {
    const prev      = document.getElementById(`expand-${expandedRowId}`);
    const prevRow   = document.querySelector(`.log-row[data-id="${expandedRowId}"]`);
    if (prev)    prev.classList.add('hidden');
    if (prevRow) {
      prevRow.querySelector('.col-expand').innerHTML = '&#9654;';
      prevRow.classList.remove('expanded');
    }
  }

  if (expandedRowId === id) {
    expandRow.classList.add('hidden');
    arrow.innerHTML = '&#9654;';
    clickedRow.classList.remove('expanded');
    expandedRowId = null;
  } else {
    expandRow.classList.remove('hidden');
    arrow.innerHTML = '&#9660;';
    clickedRow.classList.add('expanded');
    expandedRowId = id;
  }
}

/* ── Pagination ────────────────────────────────────────────────────────────── */

function renderPagination(p) {
  const container = document.getElementById('pagination');
  if (p.pages <= 1) { container.innerHTML = ''; return; }

  const buttons = [];
  if (p.pages <= 7) {
    for (let i = 1; i <= p.pages; i++) buttons.push(i);
  } else {
    const lo = Math.max(2, p.page - 2);
    const hi = Math.min(p.pages - 1, p.page + 2);
    buttons.push(1);
    if (lo > 2) buttons.push('…');
    for (let i = lo; i <= hi; i++) buttons.push(i);
    if (hi < p.pages - 1) buttons.push('…');
    buttons.push(p.pages);
  }

  container.innerHTML = buttons.map(pg =>
    pg === '…'
      ? '<span class="pg-ellipsis">…</span>'
      : `<button class="pg-btn${pg === p.page ? ' active' : ''}"
               onclick="gotoPage(${pg})">${pg}</button>`
  ).join('');
}

function gotoPage(n) {
  logState.page = n;
  loadLogs();
  document.getElementById('logs-table').scrollIntoView({ behavior: 'smooth' });
}

/* ── Search & Filters ──────────────────────────────────────────────────────── */

let searchDebounce = null;

function handleSearch() {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    logState.search = document.getElementById('search-input').value.trim();
    logState.page   = 1;
    loadLogs();
  }, 400);
}

function handleFilterChange() {
  logState.app   = document.getElementById('filter-app').value;
  logState.level = document.getElementById('filter-level').value;
  logState.limit = parseInt(document.getElementById('filter-limit').value, 10) || 50;

  const fromStr = document.getElementById('filter-from').value;
  const toStr   = document.getElementById('filter-to').value;
  logState.from = fromStr ? new Date(fromStr).setHours(0, 0, 0, 0).toString()    : '';
  logState.to   = toStr   ? new Date(toStr).setHours(23, 59, 59, 999).toString() : '';
  logState.page = 1;
  loadLogs();
}

function clearFilters() {
  document.getElementById('search-input').value = '';
  document.getElementById('filter-app').value   = '';
  document.getElementById('filter-level').value = '';
  document.getElementById('filter-from').value  = '';
  document.getElementById('filter-to').value    = '';
  document.getElementById('filter-limit').value = '50';
  Object.assign(logState, { search: '', app: '', level: '', from: '', to: '', page: 1, limit: 50 });
  loadLogs();
}

function toggleAutoRefresh() {
  const btn = document.getElementById('auto-refresh-btn');
  if (autoRefreshId) {
    clearInterval(autoRefreshId);
    autoRefreshId = null;
    btn.classList.remove('active');
    btn.textContent = 'Auto-refresh';
  } else {
    autoRefreshId = setInterval(loadLogs, 10_000);
    btn.classList.add('active');
    btn.textContent = 'Auto-refresh ✓';
  }
}

/* ── Alert helpers ─────────────────────────────────────────────────────────── */

function showAlert(containerId, message, type = 'error') {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.textContent = message;
  el.className   = `alert alert-${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 8000);
}

/* ── Init ──────────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  if (!getAuthToken()) { window.location.href = '/'; return; }

  document.getElementById('username-display').textContent = localStorage.getItem('authUser') || '';

  // Nav
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => showSection(link.dataset.section));
  });

  // Logout
  document.getElementById('logout-btn').addEventListener('click', logout);

  // Collector form
  document.getElementById('collector-form').addEventListener('submit', handleCreateCollector);
  document.getElementById('collector-transfer').addEventListener('change', onTransferTypeChange);
  document.getElementById('snippet-collector-select').addEventListener('change', updateSnippet);

  // Close credentials modal on overlay click
  document.getElementById('secret-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSecretModal();
  });

  // Search (debounced)
  document.getElementById('search-input').addEventListener('input', handleSearch);

  // Filters
  ['filter-app', 'filter-level', 'filter-from', 'filter-to', 'filter-limit']
    .forEach(id => document.getElementById(id).addEventListener('change', handleFilterChange));

  // Auto-refresh
  document.getElementById('auto-refresh-btn').addEventListener('click', toggleAutoRefresh);

  // Clear filters
  document.getElementById('clear-filters-btn').addEventListener('click', clearFilters);

  // Start on logs section
  showSection('logs');
});
