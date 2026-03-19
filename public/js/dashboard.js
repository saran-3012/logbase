'use strict';

/* ── State ─────────────────────────────────────────────────────────────────── */
let expandedRowId   = null;
let autoRefreshId   = null;
let tokenData       = [];

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

  if (name === 'tokens') loadTokens();
  if (name === 'logs')   { loadAppFilter(); loadLogs(); }
  if (name === 'oauth')  loadOAuthClients();
}

/* ── Token management ─────────────────────────────────────────────────────── */

async function loadTokens() {
  const tbody = document.getElementById('token-list');
  tbody.innerHTML = '<tr><td colspan="5" class="loading-cell">Loading…</td></tr>';
  try {
    tokenData = await apiFetch('GET', '/auth/tokens') || [];
    renderTokens(tokenData);
    populateSnippetSelect(tokenData);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="error-cell">${escHtml(err.message)}</td></tr>`;
  }
}

function renderTokens(tokens) {
  const tbody = document.getElementById('token-list');
  if (!tokens.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">No tokens yet. Create one above to start pushing logs.</td></tr>';
    return;
  }
  tbody.innerHTML = tokens.map(t => `
    <tr>
      <td>${escHtml(t.name)}</td>
      <td><code>${escHtml(t.token_preview)}</code></td>
      <td>${fmtDate(t.created_at * 1000)}</td>
      <td>${t.last_used_at ? relTime(t.last_used_at * 1000) : '<span class="muted">Never</span>'}</td>
      <td>
        <button class="btn btn-danger btn-sm"
          onclick="handleDeleteToken(${t.id}, '${escHtml(t.name)}')">Revoke</button>
      </td>
    </tr>
  `).join('');
}

async function handleCreateToken(e) {
  e.preventDefault();
  const nameInput = document.getElementById('token-name');
  const name      = nameInput.value.trim();
  if (!name) return;

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled    = true;
  btn.textContent = 'Creating…';

  try {
    const result = await apiFetch('POST', '/auth/tokens', { name });
    nameInput.value = '';
    showTokenModal(result.token, result.name);
    await loadTokens();
  } catch (err) {
    showAlert('token-alert', err.message, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Create Token';
  }
}

async function handleDeleteToken(id, name) {
  if (!confirm(`Revoke token "${name}"?\n\nAny apps using it will immediately lose access.`)) return;
  try {
    await apiFetch('DELETE', `/auth/tokens/${id}`);
    await loadTokens();
  } catch (err) {
    showAlert('token-alert', err.message, 'error');
  }
}

/* ── Token modal ───────────────────────────────────────────────────────────── */

function showTokenModal(token, name) {
  document.getElementById('modal-token-name').textContent  = name;
  document.getElementById('modal-token-value').textContent = token;
  document.getElementById('token-modal').classList.remove('hidden');
}

function closeTokenModal() {
  document.getElementById('token-modal').classList.add('hidden');
}

function copyModalToken() {
  const val = document.getElementById('modal-token-value').textContent;
  navigator.clipboard.writeText(val).then(() => {
    const btn = document.getElementById('copy-token-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  });
}

/* ── Integration snippet ───────────────────────────────────────────────────── */

function populateSnippetSelect(tokens) {
  const sel = document.getElementById('snippet-token-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">— select a token —</option>' +
    tokens.map(t => `<option value="${escHtml(t.name)}">${escHtml(t.name)}</option>`).join('');
  updateSnippet();
}

function updateSnippet() {
  const sel    = document.getElementById('snippet-token-select');
  const picked = sel?.value || '';
  const token  = picked
    ? `<YOUR_TOKEN_FOR_${picked.toUpperCase().replace(/[^A-Z0-9]/g, '_')}>`
    : '<YOUR_API_TOKEN>';
  const host   = window.location.origin;

  const curl = `curl -X POST ${host}/logs \\
  -H "X-API-Token: ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "app": "my-service",
    "level": "error",
    "message": "Something went wrong",
    "metadata": { "userId": 42, "errorCode": 500 }
  }'`;

  const node = `const res = await fetch('${host}/logs', {
  method: 'POST',
  headers: {
    'X-API-Token': '${token}',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    app:     'my-service',
    level:   'error',
    message: 'Something went wrong',
    metadata: { userId: 42, errorCode: 500 }
  })
});
const data = await res.json();   // { ok: true }`;

  const python = `import requests

response = requests.post(
    '${host}/logs',
    headers={'X-API-Token': '${token}'},
    json={
        'app':     'my-service',
        'level':   'warning',
        'message': 'Low disk space',
        'metadata': {'disk': '85%', 'host': 'prod-1'}
    }
)`;

  document.querySelector('#snippet-curl pre').textContent   = curl;
  document.querySelector('#snippet-node pre').textContent   = node;
  document.querySelector('#snippet-python pre').textContent = python;
}

function showSnippetTab(lang) {
  document.querySelectorAll('.snippet-pane').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.snippet-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`snippet-${lang}`).classList.remove('hidden');
  document.querySelector(`.snippet-tab[data-lang="${lang}"]`).classList.add('active');
}

/* ── Logs ──────────────────────────────────────────────────────────────────── */

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
    const fullEntry = { timestamp: new Date(log.timestamp).toISOString(),
      app: log.app_name, level: log.level, message: log.message, ...log.metadata };
    const jsonStr = JSON.stringify(fullEntry, null, 2);
    const preview = log.message.length > 120
      ? log.message.slice(0, 120) + '…'
      : log.message;

    return `
      <tr class="log-row" data-id="${log.id}" onclick="toggleExpand(${log.id}, this)">
        <td class="col-time" title="${escHtml(fmtDate(log.timestamp))}">
          ${escHtml(relTime(log.timestamp))}
        </td>
        <td class="col-app">${escHtml(log.app_name)}</td>
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
  setTimeout(() => el.classList.add('hidden'), 6000);
}

/* ── OAuth Client management ───────────────────────────────────────────────── */

let oauthClientData = [];

async function loadOAuthClients() {
  const tbody = document.getElementById('oauth-client-list');
  tbody.innerHTML = '<tr><td colspan="4" class="loading-cell">Loading…</td></tr>';
  try {
    oauthClientData = await apiFetch('GET', '/oauth/clients') || [];
    renderOAuthClients(oauthClientData);
    populateOAuthSnippetSelect(oauthClientData);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="error-cell">${escHtml(err.message)}</td></tr>`;
  }
}

function renderOAuthClients(clients) {
  const tbody = document.getElementById('oauth-client-list');
  if (!clients.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">No OAuth clients yet. Create one above.</td></tr>';
    return;
  }
  tbody.innerHTML = clients.map(c => `
    <tr>
      <td>${escHtml(c.name)}</td>
      <td><code>${escHtml(c.client_id)}</code></td>
      <td>${fmtDate(c.created_at * 1000)}</td>
      <td>
        <button class="btn btn-danger btn-sm"
          onclick="handleDeleteOAuthClient(${c.id}, '${escHtml(c.name)}')">Revoke</button>
      </td>
    </tr>
  `).join('');
}

async function handleCreateOAuthClient(e) {
  e.preventDefault();
  const nameInput = document.getElementById('oauth-client-name');
  const name      = nameInput.value.trim();
  if (!name) return;

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled    = true;
  btn.textContent = 'Creating…';

  try {
    const result = await apiFetch('POST', '/oauth/clients', { name });
    nameInput.value = '';
    showOAuthModal(result.name, result.client_id, result.client_secret);
    await loadOAuthClients();
  } catch (err) {
    showAlert('oauth-alert', err.message, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Create OAuth Client';
  }
}

async function handleDeleteOAuthClient(id, name) {
  if (!confirm(`Revoke OAuth client "${name}"?\n\nAny apps using it will immediately lose access.`)) return;
  try {
    await apiFetch('DELETE', `/oauth/clients/${id}`);
    await loadOAuthClients();
  } catch (err) {
    showAlert('oauth-alert', err.message, 'error');
  }
}

/* ── OAuth modal ───────────────────────────────────────────────────────────── */

function showOAuthModal(name, clientId, clientSecret) {
  document.getElementById('oauth-modal-name').textContent          = name;
  document.getElementById('oauth-modal-client-id').textContent     = clientId;
  document.getElementById('oauth-modal-client-secret').textContent = clientSecret;
  document.getElementById('oauth-modal').classList.remove('hidden');
}

function closeOAuthModal() {
  document.getElementById('oauth-modal').classList.add('hidden');
}

function copyOAuthCredentials() {
  const id  = document.getElementById('oauth-modal-client-id').textContent;
  const sec = document.getElementById('oauth-modal-client-secret').textContent;
  navigator.clipboard.writeText(`client_id:     ${id}\nclient_secret: ${sec}`).then(() => {
    const btn = document.querySelector('#oauth-modal .modal-actions .btn-ghost');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy both'; }, 2000);
  });
}

/* ── OAuth Integration snippet ─────────────────────────────────────────────── */

function populateOAuthSnippetSelect(clients) {
  const sel = document.getElementById('oauth-snippet-client-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">— select a client —</option>' +
    clients.map(c => `<option value="${escHtml(c.client_id)}" data-name="${escHtml(c.name)}">${escHtml(c.name)}</option>`).join('');
  updateOAuthSnippet();
}

function updateOAuthSnippet() {
  const sel      = document.getElementById('oauth-snippet-client-select');
  const clientId = sel?.value || '<YOUR_CLIENT_ID>';
  const secret   = '<YOUR_CLIENT_SECRET>';
  const host     = window.location.origin;

  const curl = `# Step 1: Exchange client credentials for an access token + refresh token
curl -X POST ${host}/oauth/token \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=client_credentials&client_id=${clientId}&client_secret=${secret}"

# Response:
# {
#   "access_token":  "eyJ...",   <-- valid for 1 hour
#   "token_type":    "Bearer",
#   "expires_in":    3600,
#   "refresh_token": "a3f9...",  <-- valid for 30 days
#   "scope":         "logs:write"
# }

# Step 2: Push logs using the access token
curl -X POST ${host}/logs \\
  -H "Authorization: Bearer <access_token>" \\
  -H "Content-Type: application/json" \\
  -d '{"app":"my-service","level":"error","message":"Something failed"}'

# Step 3: When access token expires, use the refresh token to get a new pair
#         (no need to send client_secret again)
curl -X POST ${host}/oauth/token \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=refresh_token&refresh_token=<refresh_token>"
# Returns a new access_token + a new refresh_token (old one is revoked)

# Step 4: Explicitly revoke a refresh token when no longer needed
curl -X POST ${host}/oauth/revoke \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "token=<refresh_token>"`;

  const node = `// Token manager — handles automatic refresh
class OAuthClient {
  constructor() {
    this.clientId     = '${clientId}';
    this.clientSecret = '${secret}';
    this.accessToken  = null;
    this.refreshToken = null;
    this.expiresAt    = 0;
  }

  async getToken() {
    if (this.accessToken && Date.now() < this.expiresAt - 30_000) {
      return this.accessToken; // still valid (with 30s buffer)
    }
    if (this.refreshToken) {
      return this._refresh();  // use refresh token — no secret needed
    }
    return this._initialGrant(); // first time — use client credentials
  }

  async _initialGrant() {
    const res  = await fetch('${host}/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     this.clientId,
        client_secret: this.clientSecret
      })
    });
    return this._store(await res.json());
  }

  async _refresh() {
    const res = await fetch('${host}/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: this.refreshToken
      })
    });
    const data = await res.json();
    if (data.error === 'invalid_grant') {
      this.refreshToken = null; // expired — fall back to client credentials
      return this._initialGrant();
    }
    return this._store(data);
  }

  _store({ access_token, refresh_token, expires_in }) {
    this.accessToken  = access_token;
    this.refreshToken = refresh_token;
    this.expiresAt    = Date.now() + expires_in * 1000;
    return access_token;
  }
}

const oauth = new OAuthClient();

// Push a log — token is refreshed automatically
const token = await oauth.getToken();
await fetch('${host}/logs', {
  method: 'POST',
  headers: { 'Authorization': \`Bearer \${token}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ app: 'my-service', level: 'info', message: 'Deploy complete' })
});`;

  const python = `import time
import requests

HOST = '${host}'

class OAuthClient:
    def __init__(self, client_id, client_secret):
        self.client_id     = client_id
        self.client_secret = client_secret
        self.access_token  = None
        self.refresh_token = None
        self.expires_at    = 0

    def get_token(self):
        if self.access_token and time.time() < self.expires_at - 30:
            return self.access_token   # still valid (30s buffer)
        if self.refresh_token:
            return self._refresh()     # use refresh token
        return self._initial_grant()   # first time

    def _initial_grant(self):
        r = requests.post(f'{HOST}/oauth/token', data={
            'grant_type':    'client_credentials',
            'client_id':     self.client_id,
            'client_secret': self.client_secret
        })
        return self._store(r.json())

    def _refresh(self):
        r = requests.post(f'{HOST}/oauth/token', data={
            'grant_type':    'refresh_token',
            'refresh_token': self.refresh_token
        })
        data = r.json()
        if data.get('error') == 'invalid_grant':
            self.refresh_token = None
            return self._initial_grant()
        return self._store(data)

    def _store(self, data):
        self.access_token  = data['access_token']
        self.refresh_token = data.get('refresh_token')
        self.expires_at    = time.time() + data['expires_in']
        return self.access_token


client = OAuthClient('${clientId}', '${secret}')

# Push a log — token is refreshed automatically
token = client.get_token()
requests.post(f'{HOST}/logs',
    headers={'Authorization': f'Bearer {token}'},
    json={'app': 'my-service', 'level': 'warning', 'message': 'High CPU'}
)`;

  document.querySelector('#oauth-snippet-curl pre').textContent   = curl;
  document.querySelector('#oauth-snippet-node pre').textContent   = node;
  document.querySelector('#oauth-snippet-python pre').textContent = python;
}

function showOAuthSnippetTab(lang) {
  document.querySelectorAll('#section-oauth .snippet-pane').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.oauth-snippet-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`oauth-snippet-${lang}`).classList.remove('hidden');
  document.querySelector(`.oauth-snippet-tab[data-lang="${lang}"]`).classList.add('active');
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

  // Token form
  document.getElementById('token-form').addEventListener('submit', handleCreateToken);

  // OAuth form
  document.getElementById('oauth-form').addEventListener('submit', handleCreateOAuthClient);

  // Close OAuth modal on overlay click
  document.getElementById('oauth-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeOAuthModal();
  });

  // OAuth snippet tabs
  document.querySelectorAll('.oauth-snippet-tab').forEach(t => {
    t.addEventListener('click', () => showOAuthSnippetTab(t.dataset.lang));
  });

  // OAuth snippet client selector
  document.getElementById('oauth-snippet-client-select').addEventListener('change', updateOAuthSnippet);

  // Close modal on overlay click
  document.getElementById('token-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeTokenModal();
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

  // Snippet tabs
  document.querySelectorAll('.snippet-tab').forEach(t => {
    t.addEventListener('click', () => showSnippetTab(t.dataset.lang));
  });

  // Snippet token selector
  document.getElementById('snippet-token-select').addEventListener('change', updateSnippet);

  // Start on logs section
  showSection('logs');
});
