'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   Logbase dashboard
   Views are hash-routed: #logs · #collectors · #new-collector
   ════════════════════════════════════════════════════════════════════════════ */

const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'];

const LEVEL_COLOR = {
  error: '#FF6B5E',
  warn:  '#F5A524',
  info:  '#5EB1FF',
  debug: '#8A939F',
  trace: '#6B7280',
};

const RANGES = {
  '15m': 15 * 60 * 1000,
  '1h':  60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
  'all': null,
};

const DEFAULT_RANGE = '1h';

const state = {
  view:        'logs',
  // logs
  search:      '',
  app:         '',
  collector:   '',
  levels:      new Set(),
  range:       DEFAULT_RANGE,
  page:        1,
  limit:       50,
  logs:        [],
  pagination:  { page: 1, limit: 50, total: 0, pages: 0 },
  stats:       null,
  selectedLog: null,
  live:        false,
  liveTimer:   null,
  everHadLogs: false,
  // collectors
  capabilities: null,
  collectors:   [],
  intCollector: null,
  snippetLang:  'curl',
  revealSecret: false,
  testResult:   null,   // { collectorId, ok, message } — survives list refreshes
  // new collector
  draft: { transfer_type: 'http', auth_method: '', input_format: 'json_array', port: null },
};

/* ── DOM helpers ───────────────────────────────────────────────────────────── */

const $  = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function relTime(ms) {
  if (!ms) return 'never';
  const s = (Date.now() - ms) / 1000;
  if (s < 5)     return 'just now';
  if (s < 60)    return `${Math.floor(s)}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });

function clockTime(ms) {
  const d = new Date(ms);
  return `${TIME_FMT.format(d)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
function dayLabel(ms) {
  const d = new Date(ms); const now = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  const yest = new Date(now.getTime() - 86400000);
  if (same(d, now))  return `Today · ${DAY_FMT.format(d)}`;
  if (same(d, yest)) return `Yesterday · ${DAY_FMT.format(d)}`;
  return DAY_FMT.format(d);
}
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';

/* ── Toasts ────────────────────────────────────────────────────────────────── */

function toast(message, kind = 'ok', ms = 5000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(message)}</span><button type="button" aria-label="Dismiss">✕</button>`;
  qs('button', el).addEventListener('click', () => el.remove());
  $('toasts').appendChild(el);
  if (ms) setTimeout(() => el.remove(), ms);
}

/* ── Confirm dialog (replaces window.confirm) ──────────────────────────────── */

let confirmResolve = null;
function confirmDialog(title, text, okLabel = 'Confirm') {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent  = text;
  $('confirm-ok').textContent    = okLabel;
  $('confirm-modal').classList.remove('hidden');
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function closeConfirm(result) {
  $('confirm-modal').classList.add('hidden');
  if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
}

/* ── API ───────────────────────────────────────────────────────────────────── */

const getToken = () => localStorage.getItem('authToken');

function logout() {
  localStorage.removeItem('authToken');
  localStorage.removeItem('authUser');
  window.location.href = '/';
}

async function api(method, path, body) {
  const token = getToken();
  if (!token) { logout(); throw new Error('Not authenticated'); }

  const opts = { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(path, opts);
  if (res.status === 401) { logout(); throw new Error('Session expired'); }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

/* ── Routing ───────────────────────────────────────────────────────────────── */

const VIEWS = ['logs', 'collectors', 'new-collector'];

function navigate(view) {
  if (!VIEWS.includes(view)) view = 'logs';
  if (window.location.hash.slice(1) !== view) {
    window.location.hash = view;
    return; // hashchange re-enters
  }
  renderView(view);
}

function renderView(view) {
  state.view = view;

  ['view-logs', 'view-logs-empty', 'view-collectors', 'view-new-collector']
    .forEach(id => $(id).classList.add('hidden'));

  const navKey = view === 'new-collector' ? 'collectors' : view;
  qsa('.nav-link').forEach(b => b.classList.toggle('active', b.dataset.view === navKey));

  if (view === 'logs') {
    // The empty state is shown only while the account genuinely has no events.
    $(state.everHadLogs ? 'view-logs' : 'view-logs-empty').classList.remove('hidden');
    loadLogsView();
  } else {
    stopLive();
    if (view === 'collectors')     { $('view-collectors').classList.remove('hidden'); loadCollectors(); }
    if (view === 'new-collector')  { $('view-new-collector').classList.remove('hidden'); initNewCollector(); }
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   LOGS
   ════════════════════════════════════════════════════════════════════════════ */

function queryParams({ forExport = false } = {}) {
  const p = new URLSearchParams();
  if (state.search)    p.set('search', state.search);
  if (state.app)       p.set('app', state.app);
  if (state.collector) p.set('collector', state.collector);
  if (state.levels.size) p.set('level', [...state.levels].join(','));

  const span = RANGES[state.range];
  if (span) p.set('from', String(Date.now() - span));

  if (!forExport) {
    p.set('page',  String(state.page));
    p.set('limit', String(state.limit));
  }
  return p;
}

/**
 * Whether the user has narrowed the view themselves.
 *
 * The default time range is deliberately excluded: it is applied on load, so
 * counting it would make every fresh account look "filtered" and would suppress
 * the first-run empty state. An account-wide probe (`state.everHadLogs`) is what
 * actually decides between onboarding and the explorer.
 */
function hasActiveFilters() {
  return Boolean(
    state.search || state.app || state.collector ||
    state.levels.size || state.range !== DEFAULT_RANGE
  );
}

async function loadLogsView() {
  try {
    const [logsRes, stats] = await Promise.all([
      api('GET', `/logs?${queryParams()}`),
      api('GET', `/logs/stats?${queryParams()}&buckets=60`).catch(() => null),
    ]);

    state.logs       = logsRes.logs;
    state.pagination = logsRes.pagination;
    state.stats      = stats;

    if (logsRes.pagination.total > 0) state.everHadLogs = true;

    // First visit with zero events and no filters → first-run experience.
    if (!state.everHadLogs && !hasActiveFilters()) {
      $('view-logs').classList.add('hidden');
      $('view-logs-empty').classList.remove('hidden');
      return;
    }
    $('view-logs-empty').classList.add('hidden');
    $('view-logs').classList.remove('hidden');

    renderLevelPills();
    renderVolume();
    renderLogRows();
    renderPager();
    $('logs-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    $('logs-body').innerHTML = `<div class="state-cell error">${esc(err.message)}</div>`;
  }
}

async function loadFilterSources() {
  try {
    const apps = await api('GET', '/logs/apps') || [];
    const sel  = $('filter-app');
    const prev = sel.value;
    sel.innerHTML = '<option value="">All</option>' +
      apps.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    sel.value = prev;
  } catch { /* non-fatal */ }

  try {
    if (!state.collectors.length) state.collectors = await api('GET', '/collectors') || [];
    const sel  = $('filter-collector');
    const prev = sel.value;
    sel.innerHTML = '<option value="">All</option>' +
      state.collectors.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    sel.value = prev;
  } catch { /* non-fatal */ }
}

function renderLevelPills() {
  const counts = state.stats?.levels || {};
  $('level-pills').innerHTML = LEVELS.map(l => {
    const on = state.levels.has(l);
    const n  = counts[l] ?? 0;
    return `<button type="button" class="pill" data-level="${l}" aria-pressed="${on}">
      <span class="dot" aria-hidden="true"></span>${esc(l.charAt(0).toUpperCase() + l.slice(1))}
      <span class="n">${n.toLocaleString()}</span>
    </button>`;
  }).join('');
}

function renderVolume() {
  const stats = state.stats;
  const chart = $('volume-chart');
  const axis  = $('volume-axis');

  if (!stats || !stats.buckets?.length) {
    chart.innerHTML = '';
    axis.innerHTML  = '';
    $('volume-count').textContent = String(state.pagination.total || 0);
    $('volume-caption').textContent = 'matching events';
    return;
  }

  const peak = Math.max(1, ...stats.buckets.map(b => b.total));
  const H    = 62;

  chart.innerHTML = stats.buckets.map(b => {
    const segs = LEVELS
      .filter(l => b.levels[l])
      .map(l => `<i style="height:${Math.max(2, Math.round((b.levels[l] / peak) * H))}px;background:${LEVEL_COLOR[l]}"></i>`)
      .join('');
    const title = b.total
      ? `${b.total} event(s) · ${new Date(b.from).toLocaleTimeString()}`
      : `No events · ${new Date(b.from).toLocaleTimeString()}`;
    return `<span class="bar" title="${esc(title)}">${segs}<i class="base"></i></span>`;
  }).join('');

  const marks = 5;
  axis.innerHTML = Array.from({ length: marks }, (_, i) => {
    const t = stats.range.from + ((stats.range.to - stats.range.from) * i) / (marks - 1);
    return `<span>${new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
  }).join('');

  const total = state.pagination.total;
  $('volume-count').textContent = total.toLocaleString();
  const bits = ['matching events'];
  if (state.range !== 'all') bits.push(`last ${state.range}`);
  if (state.app) bits.push(state.app);
  $('volume-caption').textContent = `· ${bits.join(' · ')}`.replace('· matching', 'matching');
}

function levelClass(level) {
  const l = String(level || '').toLowerCase();
  if (['error', 'critical', 'fatal'].includes(l)) return 'lvl-error';
  if (['warn', 'warning'].includes(l))            return 'lvl-warn';
  if (l === 'info')  return 'lvl-info';
  if (l === 'debug') return 'lvl-debug';
  if (l === 'trace') return 'lvl-trace';
  return 'lvl-debug';
}

function renderLogRows() {
  const body = $('logs-body');

  if (!state.logs.length) {
    body.innerHTML = `<div class="state-cell">No events match these filters.
      <div style="margin-top:12px"><button type="button" class="btn btn-sm" id="empty-clear">Clear filters</button></div></div>`;
    $('empty-clear')?.addEventListener('click', clearFilters);
    closeDetail();
    return;
  }

  let lastDay = '';
  const html = [];

  for (const log of state.logs) {
    const day = dayLabel(log.timestamp);
    if (day !== lastDay) {
      html.push(`<div class="log-daysep">${esc(day)}</div>`);
      lastDay = day;
    }
    const sel = state.selectedLog?.id === log.id ? ' selected' : '';
    const via = log.collector_name ? `<div class="via">via ${esc(log.collector_name)}</div>` : '';

    html.push(`<button type="button" class="log-row log-cols${sel}" data-id="${log.id}" aria-label="Open event">
      <span class="t">${esc(clockTime(log.timestamp))}</span>
      <span><span class="lvl ${levelClass(log.level)}">${esc(log.level)}</span></span>
      <span class="app">${esc(log.app_name)}${via}</span>
      <span class="msg">${esc(log.message || '—')}</span>
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8A939F" stroke-width="2"><path d="m9 6 6 6-6 6"></path></svg>
    </button>`);
  }

  body.innerHTML = html.join('');
  qs('.log-head span:first-child').innerHTML = `Time <span class="mono">(${esc(TZ.split('/').pop())})</span>`;
}

function renderPager() {
  const p = state.pagination;
  const first = p.total === 0 ? 0 : (p.page - 1) * p.limit + 1;
  const last  = Math.min(p.total, p.page * p.limit);

  $('logs-range-label').innerHTML = p.total
    ? `Showing <strong style="color:var(--text);font-weight:500">${first}–${last}</strong> of ${p.total.toLocaleString()}`
    : 'No results';
  $('page-indicator').textContent = `${p.page} / ${Math.max(1, p.pages)}`;
  $('prev-page').disabled = p.page <= 1;
  $('next-page').disabled = p.page >= p.pages;
}

/* ── Detail panel ──────────────────────────────────────────────────────────── */

function openDetail(id) {
  const log = state.logs.find(l => String(l.id) === String(id));
  if (!log) return;
  state.selectedLog = log;

  const lvl = $('detail-level');
  lvl.className   = `lvl ${levelClass(log.level)}`;
  lvl.textContent = log.level;

  const meta = log.metadata && Object.keys(log.metadata).length ? log.metadata : null;
  const rawObj = log.raw ?? { level: log.level, app: log.app_name, message: log.message, ...(meta || {}) };

  const rows = [
    ['Timestamp', `${new Date(log.timestamp).toLocaleString()} ${TZ}`, true],
    ['App', esc(log.app_name), false],
    ['Collector', log.collector_name
      ? `${esc(log.collector_name)}${log.transfer_type ? ` · ${esc(log.transfer_type.toUpperCase())}` : ''}`
      : '<span class="mut">—</span>', false],
  ];
  for (const [k, v] of Object.entries(meta || {}).slice(0, 8)) {
    if (v === null || typeof v === 'object') continue;
    rows.push([k, esc(v), true]);
  }

  $('detail-body').innerHTML = `
    <p class="detail-msg">${esc(log.message || '—')}</p>
    <dl class="kv">
      ${rows.map(([k, v, mono]) => `<dt>${esc(k)}</dt><dd class="${mono ? 'mono' : ''}">${v}</dd>`).join('')}
    </dl>
    <div>
      <div class="sub-head">
        <h3>Raw event</h3>
        <button type="button" class="btn btn-sm" id="detail-copy">
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>
          Copy JSON
        </button>
      </div>
      <pre class="code">${esc(JSON.stringify(rawObj, null, 2))}</pre>
    </div>
    <div class="detail-actions">
      <button type="button" class="btn btn-accent" id="detail-around">Show surrounding events</button>
      ${log.app_name ? `<button type="button" class="btn" id="detail-filter-app">Filter by app</button>` : ''}
    </div>`;

  $('detail-copy').addEventListener('click', () => {
    copyText(JSON.stringify(rawObj, null, 2), 'Raw event copied');
  });
  $('detail-around').addEventListener('click', () => {
    // Clear narrowing filters but keep the time context around this event.
    state.search = ''; $('q').value = '';
    state.levels.clear();
    state.app = ''; $('filter-app').value = '';
    state.page = 1;
    toast('Filters cleared — showing surrounding events', 'ok', 3500);
    loadLogsView();
  });
  $('detail-filter-app')?.addEventListener('click', () => {
    state.app = log.app_name;
    $('filter-app').value = log.app_name;
    state.page = 1;
    loadLogsView();
  });

  $('detail-panel').classList.remove('hidden');
  qsa('.log-row').forEach(r => r.classList.toggle('selected', r.dataset.id === String(id)));
}

function closeDetail() {
  state.selectedLog = null;
  $('detail-panel').classList.add('hidden');
  qsa('.log-row').forEach(r => r.classList.remove('selected'));
}

/* ── Live tail ─────────────────────────────────────────────────────────────── */

function startLive() {
  state.live = true;
  $('live-btn').setAttribute('aria-pressed', 'true');
  qs('.live-dot', $('live-btn')).classList.remove('off');
  $('live-label').textContent = 'Live tail on';
  state.liveTimer = setInterval(() => {
    if (state.view === 'logs' && state.page === 1) loadLogsView();
  }, 5000);
}

function stopLive() {
  state.live = false;
  if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; }
  const btn = $('live-btn');
  if (!btn) return;
  btn.setAttribute('aria-pressed', 'false');
  qs('.live-dot', btn).classList.add('off');
  $('live-label').textContent = 'Live tail off';
}

/* ── Export ────────────────────────────────────────────────────────────────── */

async function exportLogs() {
  const btn = $('export-btn');
  btn.disabled = true;
  try {
    const all = [];
    const MAX_PAGES = 10, PER = 200;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const p = queryParams({ forExport: true });
      p.set('page', String(page));
      p.set('limit', String(PER));
      const res = await api('GET', `/logs?${p}`);
      all.push(...res.logs);
      if (page >= res.pagination.pages) break;
    }
    if (!all.length) { toast('Nothing to export for these filters', 'warn'); return; }

    const ndjson = all.map(l => JSON.stringify({
      timestamp: new Date(l.timestamp).toISOString(),
      level: l.level, app: l.app_name, message: l.message,
      collector: l.collector_name, ...l.metadata,
    })).join('\n');

    const url = URL.createObjectURL(new Blob([ndjson], { type: 'application/x-ndjson' }));
    const a   = document.createElement('a');
    a.href = url;
    a.download = `logbase-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.ndjson`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${all.length.toLocaleString()} event(s)`);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ── Filter mutations ──────────────────────────────────────────────────────── */

function clearFilters() {
  state.search = ''; state.app = ''; state.collector = '';
  state.levels.clear(); state.range = DEFAULT_RANGE; state.page = 1;
  $('q').value = '';
  $('filter-app').value = '';
  $('filter-collector').value = '';
  qsa('#range-group button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.range === DEFAULT_RANGE)));
  closeDetail();
  loadLogsView();
}

/* ════════════════════════════════════════════════════════════════════════════
   COLLECTORS
   ════════════════════════════════════════════════════════════════════════════ */

async function loadCapabilities(force = false) {
  if (state.capabilities && !force) return state.capabilities;
  state.capabilities = await api('GET', '/collectors/capabilities');
  return state.capabilities;
}

const capOf = (t) => state.capabilities?.transferTypes.find(x => x.value === t) || null;

function statusMeta(c) {
  const s = c.listener_status || '';
  if (c.transfer_type !== 'udp') {
    return c.enabled ? ['status-ok', 'Active'] : ['status-off', 'Paused'];
  }
  if (!c.enabled) return ['status-off', 'Paused'];
  if (s === 'listening') return ['status-ok', 'Listening'];
  if (s === 'capacity_exceeded')  return ['status-warn', 'Slot taken'];
  if (s === 'disabled_by_config') return ['status-off', 'UDP off'];
  if (s.startsWith('bind_error')) return ['status-err', 'Bind error'];
  return ['status-off', 'Stopped'];
}

async function loadCollectors() {
  const rowsEl = $('collector-rows');
  try {
    await loadCapabilities();
    state.collectors = await api('GET', '/collectors') || [];
    renderCollectorNotice();
    renderCollectorRows();
    renderIntegration();
  } catch (err) {
    rowsEl.innerHTML = `<div class="state-cell error">${esc(err.message)}</div>`;
  }
}

/**
 * Collector-level notice.
 *
 * Only conditions the user can act on are surfaced here, and only when they are
 * relevant to a collector they actually own. Deployment and hosting details are
 * operator concerns and belong in the server log, not in the dashboard.
 */
function renderCollectorNotice() {
  const udp = state.capabilities?.udp;
  const el  = $('collector-notice');
  if (!el) return;

  const hasUdp = state.collectors.some(c => c.transfer_type === 'udp');

  if (udp && !udp.enabled && hasUdp) {
    el.innerHTML = `<div class="note note-warn">${warnIcon()}
      <span>UDP ingestion is turned off by the server configuration. Existing UDP collectors keep their settings but will not listen.</span></div>`;
    return;
  }

  el.innerHTML = '';
}

function warnIcon() {
  return `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F5A524" stroke-width="2" stroke-linecap="round"><path d="M12 3 2 20h20L12 3z"></path><path d="M12 10v4M12 17h.01"></path></svg>`;
}

function renderCollectorRows() {
  const el = $('collector-rows');

  if (!state.collectors.length) {
    el.innerHTML = `<div class="state-cell">
      No collectors yet.
      <div style="margin-top:14px"><button type="button" class="btn btn-accent" data-nav="new-collector">Create your first collector</button></div>
    </div>`;
    return;
  }

  el.innerHTML = state.collectors.map(c => {
    const [cls, label] = statusMeta(c);
    const sel  = state.intCollector === c.id ? ' sel' : '';
    const auth = state.capabilities?.authMethods[c.auth_method] || c.auth_method;
    const fmt  = c.input_format === 'json_array' ? 'JSON array' : 'NDJSON';
    const bindErr = String(c.listener_status || '').startsWith('bind_error');

    return `<div class="col-row${sel}" data-id="${c.id}">
      <div class="col-cols cells">
        <div>
          <div class="name">${esc(c.name)}</div>
          <div class="sub">Last event ${esc(relTime(c.last_event_at ? c.last_event_at * 1000 : 0))}</div>
        </div>
        <span><span class="tag">${esc(c.transfer_type)}</span></span>
        <div style="font-size:13px;line-height:1.4">
          <div>${esc(auth)}</div>
          <div class="mut">${esc(fmt)}</div>
        </div>
        <div class="endpoint">
          <code>${esc(c.endpoint || '—')}</code>
          <button type="button" class="btn btn-icon sm" data-copy-endpoint="${c.id}" aria-label="Copy endpoint for ${esc(c.name)}">
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>
          </button>
        </div>
        <span class="mono" style="font-size:13px">${Number(c.events_received).toLocaleString()}</span>
        <button type="button" class="switch" role="switch" aria-checked="${c.enabled}" data-toggle="${c.id}"
                aria-label="Collector ${esc(c.name)} enabled">
          <span class="track" aria-hidden="true"><i></i></span>
          <span class="status ${cls}" style="padding:0;background:transparent">${esc(label)}</span>
        </button>
        <div class="menu-wrap">
          <button type="button" class="btn btn-icon btn-quiet" style="border:0" data-menu="${c.id}" aria-haspopup="true" aria-expanded="false" aria-label="More actions for ${esc(c.name)}">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg>
          </button>
          <div class="menu hidden" data-menu-for="${c.id}" role="menu">
            <button type="button" role="menuitem" data-act="integrate" data-id="${c.id}">Integration &amp; snippets</button>
            ${c.transfer_type === 'udp' ? `<button type="button" role="menuitem" data-act="test" data-id="${c.id}">Send test event</button>` : ''}
            ${c.auth_method !== 'none' ? `<button type="button" role="menuitem" data-act="rotate" data-id="${c.id}">Rotate credentials</button>` : ''}
            <button type="button" role="menuitem" data-act="logs" data-id="${c.id}">View its logs</button>
            <hr />
            <button type="button" role="menuitem" class="danger" data-act="delete" data-id="${c.id}">Delete collector</button>
          </div>
        </div>
      </div>
      ${bindErr ? `<div class="note note-err note-row">${warnIcon()}
        <span>The listener could not bind: <code>${esc(c.listener_status)}</code>. The port may be in use by another process.</span></div>` : ''}
    </div>`;
  }).join('');
}

/* ── Integration panel ─────────────────────────────────────────────────────── */

function renderIntegration() {
  const panel = $('integration-panel');
  if (!state.collectors.length) { panel.classList.add('hidden'); return; }

  if (!state.collectors.some(c => c.id === state.intCollector)) {
    state.intCollector = state.collectors[0].id;
  }
  const c = state.collectors.find(x => x.id === state.intCollector);
  panel.classList.remove('hidden');

  $('int-select').innerHTML = state.collectors
    .map(x => `<option value="${x.id}"${x.id === c.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('');

  $('int-name').textContent = c.name;
  const auth = state.capabilities?.authMethods[c.auth_method] || c.auth_method;
  const fmt  = c.input_format === 'json_array' ? 'JSON array' : 'NDJSON';
  $('int-sub').textContent = `${c.transfer_type.toUpperCase()} · ${auth} · ${fmt}. Copy a snippet, run it, and watch the event land in Logs.`;

  const langs = snippetLangs(c);
  if (!langs.includes(state.snippetLang)) state.snippetLang = langs[0];

  $('snippet-tabs').innerHTML = langs.map(l =>
    `<button type="button" role="tab" data-lang="${l}" aria-selected="${l === state.snippetLang}">${esc(l)}</button>`
  ).join('');

  $('snippet-code').textContent = buildSnippet(c, state.snippetLang);
  $('snippet-reveal').classList.toggle('hidden', c.auth_method === 'none');
  $('snippet-reveal').setAttribute('aria-pressed', String(state.revealSecret));

  $('int-test').textContent = c.transfer_type === 'udp' ? 'Send test event' : 'How to verify';
  $('int-test').disabled = c.transfer_type !== 'udp';

  $('int-security').innerHTML = c.auth_method === 'none'
    ? `UDP ingestion is <strong style="color:var(--warn-fg);font-weight:500">unauthenticated and unencrypted</strong> — anyone who can reach
       <code class="mono">${esc(c.endpoint || '')}</code> can write to this collector. Restrict access with your firewall.`
    : `Keep the credential secret — anyone with it can write to this collector.
       <button type="button" class="btn-link" data-act="rotate" data-id="${c.id}" style="padding:0">Rotate credentials</button>`;

  renderTestResult(c);
}

/**
 * The result of a self-test must survive the collector reload that follows it,
 * so it is held in state rather than written straight into the DOM.
 */
function renderTestResult(c) {
  const el = $('int-test-result');
  const r  = state.testResult;

  if (r && r.collectorId === c.id) {
    el.innerHTML = `<div class="note ${r.ok ? 'note-ok' : 'note-warn'}">
      ${r.ok ? infoIcon() : warnIcon()}
      <div style="font-size:13px">
        <div style="font-weight:500">${r.ok ? 'Test event received' : 'Test event not observed'}</div>
        <div class="mut">${esc(r.message || '')}</div>
      </div></div>`;
    return;
  }

  el.innerHTML = c.transfer_type === 'udp'
    ? ''
    : `<div class="note note-info">${infoIcon()}<span>HTTP collectors are verified by running the snippet — a successful call returns <code>{"ok":true}</code>.</span></div>`;
}

function infoIcon() {
  return `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C8F135" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto;margin-top:1px"><circle cx="12" cy="12" r="9"></circle><path d="m8 12 3 3 5-6"></path></svg>`;
}

function snippetLangs(c) {
  return c.transfer_type === 'udp' ? ['netcat', 'node', 'python'] : ['curl', 'node', 'python'];
}

function secretFor(c) {
  if (c.auth_method === 'none') return null;
  const cred = (c.credentials || [])[0];
  if (c.auth_method === 'oauth_client_credentials') {
    return state.revealSecret ? (cred?.public_id || '<CLIENT_ID>') : '<CLIENT_ID>';
  }
  if (!cred?.token_preview) return '<YOUR_API_TOKEN>';
  return state.revealSecret ? cred.token_preview : 'lb_••••••••••••••••';
}

function sampleBody(format) {
  const a = { level: 'info',  app: 'my-service', message: 'hello from logbase' };
  const b = { level: 'error', app: 'my-service', message: 'something went wrong', retry: 2 };
  return format === 'json_array'
    ? JSON.stringify([a, b])
    : `${JSON.stringify(a)}\n${JSON.stringify(b)}`;
}

function buildSnippet(c, lang) {
  const format  = c.input_format;
  const payload = sampleBody(format);

  /* ── UDP ─────────────────────────────────────────────────────────────── */
  if (c.transfer_type === 'udp') {
    const ep   = String(c.endpoint || 'host:port');
    const idx  = ep.lastIndexOf(':');
    const host = idx > 0 ? ep.slice(0, idx) : ep;
    const port = idx > 0 ? ep.slice(idx + 1) : '10000';

    const note = `# UDP is unauthenticated — anything sent to ${host}:${port} is ingested here.
# There is no response and no delivery guarantee. Keep each batch inside one
# datagram (~1472 bytes is the safe MTU limit; ${format === 'json_array'
      ? 'an oversized JSON array arrives truncated and fails to parse'
      : 'NDJSON degrades gracefully — only the clipped line is lost'}).`;

    if (lang === 'netcat') {
      return `${note}

printf '%s' '${payload.replace(/\n/g, '\\n')}' | nc -u -w1 ${host} ${port}

# or with socat
printf '%s' '${payload.replace(/\n/g, '\\n')}' | socat - UDP-DATAGRAM:${host}:${port}`;
    }

    if (lang === 'node') {
      return `${note}

const dgram = require('dgram');
const socket = dgram.createSocket('udp4');

const events = [
  { level: 'info',  app: 'my-service', message: 'hello from logbase' },
  { level: 'error', app: 'my-service', message: 'something went wrong', retry: 2 }
];

const payload = ${format === 'json_array'
        ? 'JSON.stringify(events)'
        : "events.map(e => JSON.stringify(e)).join('\\n')"};

socket.send(Buffer.from(payload), ${port}, '${host}', (err) => {
  if (err) console.error(err);
  socket.close();
});`;
    }

    return `${note}

import json, socket

events = [
    {'level': 'info',  'app': 'my-service', 'message': 'hello from logbase'},
    {'level': 'error', 'app': 'my-service', 'message': 'something went wrong', 'retry': 2},
]

payload = ${format === 'json_array'
      ? 'json.dumps(events)'
      : "'\\n'.join(json.dumps(e) for e in events)"}

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.sendto(payload.encode(), ('${host}', ${port}))
sock.close()`;
  }

  /* ── HTTP ────────────────────────────────────────────────────────────── */
  const url         = c.endpoint || `${window.location.origin}/logs`;
  const contentType = format === 'ndjson' ? 'application/x-ndjson' : 'application/json';
  const isOAuth     = c.auth_method === 'oauth_client_credentials';
  const secret      = secretFor(c);
  const headerName  = isOAuth ? 'Authorization' : 'X-API-Token';
  const headerValue = isOAuth ? 'Bearer <ACCESS_TOKEN>' : secret;

  if (lang === 'curl') {
    const oauthStep = isOAuth ? `# 1 — exchange client credentials for an access token (valid 1 hour)
curl -X POST ${window.location.origin}/oauth/token \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=client_credentials&client_id=${secret}&client_secret=<CLIENT_SECRET>"

# 2 — push a batch
` : '';

    return `${oauthStep}curl -X POST ${url} \\
  -H "Content-Type: ${contentType}" \\
  -H "${headerName}: ${headerValue}" \\
  --data-binary '${payload}'

# → { "ok": true, "inserted": 2, "rejected": 0 }
# This collector expects "${format}"${format === 'json_array'
      ? ' — send a JSON array; each element is one event.'
      : ' — send one JSON object per line.'}`;
  }

  if (lang === 'node') {
    return `const events = [
  { level: 'info',  app: 'my-service', message: 'hello from logbase' },
  { level: 'error', app: 'my-service', message: 'something went wrong', retry: 2 }
];

const body = ${format === 'json_array'
      ? 'JSON.stringify(events)'
      : "events.map(e => JSON.stringify(e)).join('\\n')"};

const res = await fetch('${url}', {
  method: 'POST',
  headers: {
    '${headerName}': '${headerValue}',
    'Content-Type': '${contentType}'
  },
  body
});

console.log(await res.json());  // { ok: true, inserted: 2, rejected: 0 }`;
  }

  return `import json, requests

events = [
    {'level': 'info',  'app': 'my-service', 'message': 'hello from logbase'},
    {'level': 'error', 'app': 'my-service', 'message': 'something went wrong', 'retry': 2},
]

body = ${format === 'json_array'
    ? 'json.dumps(events)'
    : "'\\n'.join(json.dumps(e) for e in events)"}

response = requests.post(
    '${url}',
    headers={
        '${headerName}': '${headerValue}',
        'Content-Type': '${contentType}',
    },
    data=body,
)
print(response.json())  # {'ok': True, 'inserted': 2, 'rejected': 0}`;
}

/* ── Collector mutations ───────────────────────────────────────────────────── */

async function toggleCollector(id, btn) {
  const c = state.collectors.find(x => x.id === Number(id));
  if (!c) return;
  const next = !c.enabled;

  btn.disabled = true;
  try {
    await api('PATCH', `/collectors/${id}`, { enabled: next });
    toast(`Collector "${c.name}" ${next ? 'enabled' : 'paused'}`);
  } catch (err) {
    // The server refuses when a listener cannot bind — report the real reason.
    toast(err.message, 'err', 9000);
  } finally {
    btn.disabled = false;
    await loadCollectors();
  }
}

async function deleteCollector(id) {
  const c = state.collectors.find(x => x.id === Number(id));
  if (!c) return;
  const ok = await confirmDialog(
    `Delete “${c.name}”?`,
    'Its credentials are revoked immediately and any listener is stopped. Existing log events are kept but lose their collector link.',
    'Delete collector'
  );
  if (!ok) return;

  try {
    await api('DELETE', `/collectors/${id}`);
    if (state.intCollector === Number(id)) state.intCollector = null;
    toast(`Collector "${c.name}" deleted`);
    await loadCollectors();
  } catch (err) { toast(err.message, 'err'); }
}

async function rotateCollector(id) {
  const c = state.collectors.find(x => x.id === Number(id));
  if (!c) return;
  const ok = await confirmDialog(
    `Rotate credentials for “${c.name}”?`,
    'The current credentials stop working immediately. Any sender still using them will start receiving 401 responses.',
    'Rotate'
  );
  if (!ok) return;

  try {
    const res = await api('POST', `/collectors/${id}/rotate`);
    showSecrets(`New credentials for ${c.name}`, res.secrets);
    await loadCollectors();
  } catch (err) { toast(err.message, 'err'); }
}

async function testCollector(id) {
  const btn  = $('int-test');
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = 'Sending…';

  try {
    const res = await api('POST', `/collectors/${id}/test`);
    state.testResult = { collectorId: Number(id), ok: Boolean(res.ok), message: res.message };
    toast(res.ok ? 'Self-test succeeded' : 'Self-test did not receive the datagram', res.ok ? 'ok' : 'warn');
  } catch (err) {
    state.testResult = { collectorId: Number(id), ok: false, message: err.message };
    toast(err.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = prev;
    // Reloading refreshes the event counters; renderIntegration() re-paints the
    // stored result afterwards.
    await loadCollectors();
  }
}

/* ── Secrets modal ─────────────────────────────────────────────────────────── */

const SECRET_LABEL = {
  api_token:     'API token  (send as X-API-Token)',
  client_id:     'Client ID',
  client_secret: 'Client secret',
};

function showSecrets(title, secrets) {
  if (!secrets || !Object.keys(secrets).length) return;
  $('secret-title').textContent = title;
  $('secret-body').innerHTML = Object.entries(secrets).map(([k, v]) => `
    <div class="secret">
      <div class="k">${esc(SECRET_LABEL[k] || k)}</div>
      <div class="v" data-secret="${esc(k)}">${esc(v)}</div>
    </div>`).join('');
  $('secret-modal').classList.remove('hidden');
}

function copyText(text, message = 'Copied') {
  navigator.clipboard?.writeText(text)
    .then(() => toast(message, 'ok', 2500))
    .catch(() => toast('Clipboard unavailable — copy manually', 'warn'));
}

/* ════════════════════════════════════════════════════════════════════════════
   NEW COLLECTOR
   ════════════════════════════════════════════════════════════════════════════ */

async function initNewCollector() {
  try {
    await loadCapabilities(true);
    if (!state.collectors.length) state.collectors = await api('GET', '/collectors') || [];
  } catch (err) {
    $('nc-error').innerHTML = `<div class="note note-err" style="margin:0 24px 18px">${warnIcon()}<span>${esc(err.message)}</span></div>`;
    return;
  }

  const caps = state.capabilities;
  const first = caps.transferTypes[0];
  state.draft.transfer_type = state.draft.transfer_type || first.value;

  const cap = capOf(state.draft.transfer_type) || first;
  state.draft.auth_method  = cap.authMethods[0];
  state.draft.input_format = cap.inputFormats.includes(state.draft.input_format)
    ? state.draft.input_format : cap.inputFormats[0];
  if (cap.requiresPort && !state.draft.port) state.draft.port = caps.udp?.port_range?.min ?? 10000;

  renderNewCollector();
}

const FORMAT_SAMPLE = {
  json_array: '[{"level":"info",…}, {…}]',
  ndjson:     '{"level":"info",…}\n{"level":"warn",…}',
};
const FORMAT_TITLE = {
  json_array: ['JSON array', 'Each element is one event.'],
  ndjson:     ['Newline-delimited JSON', 'Each line is one event.'],
};

function renderNewCollector() {
  const caps  = state.capabilities;
  const d     = state.draft;
  const cap   = capOf(d.transfer_type);
  const isUdp = cap?.requiresPort;

  /* Transport choices */
  $('nc-transports').innerHTML = caps.transferTypes.map(t => {
    const on       = t.value === d.transfer_type;
    const udpBlock = t.value === 'udp' && caps.udp && !caps.udp.enabled;
    return `<label class="choice${on ? ' on' : ''}${udpBlock ? ' disabled' : ''}" data-transfer="${t.value}">
      <input type="radio" name="nc-transfer" value="${t.value}" ${on ? 'checked' : ''} ${udpBlock ? 'disabled' : ''} />
      <span class="top">
        <span class="radio" aria-hidden="true"><i></i></span>
        <span>
          <b>${esc(t.label)}${t.value === 'http' ? ' <span class="soft">· recommended</span>' : ''}</b>
          <span class="desc">${esc(t.description)}</span>
        </span>
      </span>
    </label>`;
  }).join('');

  /* Transport-level warning */
  const noteEl = $('nc-transport-note');
  if (isUdp) {
    noteEl.innerHTML = `<div class="note note-warn" role="note">${warnIcon()}
      <span>UDP is <strong>unauthenticated and unencrypted</strong>. Anyone who can reach the port can write events to this collector — restrict access with your firewall.</span></div>`;
  } else {
    noteEl.innerHTML = '';
  }

  /* Auth */
  const authChoices = cap?.authMethods || [];
  if (!authChoices.includes(d.auth_method)) d.auth_method = authChoices[0];

  if (authChoices.length > 1) {
    $('nc-auth-choices').innerHTML = `<div class="choices">` + authChoices.map(a => {
      const on = a === d.auth_method;
      return `<label class="choice${on ? ' on' : ''}" data-auth="${a}">
        <input type="radio" name="nc-auth" value="${a}" ${on ? 'checked' : ''} />
        <span class="top"><span class="radio" aria-hidden="true"><i></i></span>
        <span><b>${esc(caps.authMethods[a] || a)}</b>
        <span class="desc">${a === 'api_token'
          ? 'A long-lived token sent in the X-API-Token header. Generated on create, rotatable later.'
          : 'OAuth 2.0 client credentials — exchange a client id/secret for a short-lived bearer token.'}</span></span></span>
      </label>`;
    }).join('') + `</div>`;
    $('nc-auth-readout').innerHTML = '';
  } else {
    $('nc-auth-choices').innerHTML = '';
    const only = authChoices[0];
    $('nc-auth-readout').innerHTML = `<div class="readout">
      ${only === 'none' ? lockIcon() : keyIcon()}
      <div><b>${esc(caps.authMethods[only] || only)}</b>
      <span>${only === 'none'
        ? 'UDP collectors accept any datagram sent to the port. Restrict access with your firewall.'
        : 'We generate the credential when you create the collector. You can rotate it later.'}</span></div>
    </div>`;
  }

  /* Format */
  const formats = cap?.inputFormats || [];
  if (!formats.includes(d.input_format)) d.input_format = formats[0];
  $('nc-formats').innerHTML = formats.map(f => {
    const on = f === d.input_format;
    const [title, desc] = FORMAT_TITLE[f] || [f, ''];
    return `<label class="choice${on ? ' on' : ''}" data-format="${f}">
      <input type="radio" name="nc-format" value="${f}" ${on ? 'checked' : ''} />
      <span class="top"><span class="radio" aria-hidden="true"><i></i></span>
      <span><b>${esc(title)}</b><span class="desc">${esc(desc)}</span></span></span>
      <code>${esc(FORMAT_SAMPLE[f] || '')}</code>
    </label>`;
  }).join('');

  /* Listener */
  $('nc-listener').classList.toggle('hidden', !isUdp);
  if (isUdp && caps.udp) {
    const r = caps.udp.port_range;
    $('nc-listener-usage').innerHTML =
      `UDP listeners in use: <strong style="color:var(--text);font-weight:500">${caps.udp.active_listeners} of ${caps.udp.max_listeners}</strong> server-wide · limit ${cap.maxPerUser} per user`;
    const portEl = $('nc-port');
    portEl.min = r.min; portEl.max = r.max;
    if (!portEl.value) portEl.value = d.port ?? r.min;
    $('nc-port-h').textContent = `${r.min}–${r.max}`;
    if (!$('nc-host').value && caps.udp.public_host) $('nc-host').value = caps.udp.public_host;
  }

  renderPreview();
}

function lockIcon() {
  return `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#98A2AE" stroke-width="2" stroke-linecap="round" style="flex:0 0 auto;margin-top:1px"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 7.5-2"></path></svg>`;
}
function keyIcon() {
  return `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C8F135" stroke-width="2" stroke-linecap="round" style="flex:0 0 auto;margin-top:1px"><circle cx="8" cy="15" r="4"></circle><path d="m11 12 9-9M17 6l3 3M14 9l2 2"></path></svg>`;
}

function renderPreview() {
  const d     = state.draft;
  const caps  = state.capabilities;
  const cap   = capOf(d.transfer_type);
  const isUdp = cap?.requiresPort;
  const name  = $('nc-name').value.trim() || 'my-collector';

  const host = $('nc-host')?.value.trim() || caps?.udp?.public_host || 'logs.example.com';
  const port = $('nc-port')?.value || caps?.udp?.port_range?.min || 10000;
  const endpoint = isUdp ? `udp://${host}:${port}` : `${window.location.origin}/logs`;

  $('pv-endpoint').textContent = endpoint;
  $('pv-auth').textContent     = caps?.authMethods[d.auth_method] || d.auth_method || '—';
  $('pv-format').textContent   = (FORMAT_TITLE[d.input_format] || [d.input_format])[0];

  const sec = $('pv-security');
  sec.textContent = isUdp ? 'Unencrypted · unauthenticated' : 'TLS encrypted · credential required';
  sec.style.color = isUdp ? 'var(--warn-fg)' : 'var(--text)';
  $('pv-token-note').textContent = isUdp ? '' : ', your credential';

  const preview = {
    transfer_type: d.transfer_type,
    input_format:  d.input_format,
    auth_method:   d.auth_method,
    endpoint,
    name,
    credentials: [],
  };
  $('pv-snippet').textContent = buildSnippet(preview, isUdp ? 'netcat' : 'curl')
    .split('\n').slice(0, 14).join('\n');
}

async function submitNewCollector(e) {
  e.preventDefault();

  const d    = state.draft;
  const cap  = capOf(d.transfer_type);
  const name = $('nc-name').value.trim();
  const errEl = $('nc-error');
  errEl.innerHTML = '';

  if (!name) {
    errEl.innerHTML = `<div class="note note-err" style="margin:0 24px">${warnIcon()}<span>A collector name is required.</span></div>`;
    $('nc-name').focus();
    return;
  }

  const payload = {
    name,
    transfer_type: d.transfer_type,
    auth_method:   d.auth_method,
    input_format:  d.input_format,
  };

  if (cap?.requiresPort) {
    const port = parseInt($('nc-port').value, 10);
    if (!Number.isInteger(port)) {
      errEl.innerHTML = `<div class="note note-err" style="margin:0 24px">${warnIcon()}<span>A port is required for a ${d.transfer_type.toUpperCase()} collector.</span></div>`;
      return;
    }
    payload.port = port;
    const host = $('nc-host').value.trim();
    if (host) payload.public_host = host;
  }

  const btn = $('nc-submit');
  btn.disabled = true; btn.textContent = 'Creating…';

  try {
    const created = await api('POST', '/collectors', payload);
    state.collectors = [];
    state.intCollector = created.id;
    state.draft = { transfer_type: 'http', auth_method: '', input_format: 'json_array', port: null };
    $('nc-name').value = ''; $('nc-host').value = ''; $('nc-port').value = '';

    if (created.secrets && Object.keys(created.secrets).length) {
      showSecrets(`Collector “${created.name}” created`, created.secrets);
    } else {
      toast(`Collector "${created.name}" created`);
    }
    navigate('collectors');
  } catch (err) {
    errEl.innerHTML = `<div class="note note-err" style="margin:0 24px">${warnIcon()}<span>${esc(err.message)}</span></div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Create collector';
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   EVENT WIRING
   ════════════════════════════════════════════════════════════════════════════ */

function closeAllMenus() {
  qsa('.menu').forEach(m => m.classList.add('hidden'));
  qsa('[aria-haspopup="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
}

function wireGlobal() {
  // Hash routing
  window.addEventListener('hashchange', () => renderView(window.location.hash.slice(1) || 'logs'));

  // Nav
  qsa('.nav-link').forEach(b => b.addEventListener('click', () => navigate(b.dataset.view)));

  // Any [data-nav] button navigates
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { navigate(nav.dataset.nav); return; }

    // Close menus when clicking outside
    if (!e.target.closest('.menu-wrap')) closeAllMenus();
  });

  // Account menu
  $('account-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('account-menu');
    const open = menu.classList.contains('hidden');
    closeAllMenus();
    menu.classList.toggle('hidden', !open);
    $('account-btn').setAttribute('aria-expanded', String(open));
  });
  $('logout-btn').addEventListener('click', logout);

  // Modals
  $('secret-done').addEventListener('click', () => $('secret-modal').classList.add('hidden'));
  $('secret-copy').addEventListener('click', () => {
    const text = qsa('#secret-body .v').map(el => `${el.dataset.secret}: ${el.textContent}`).join('\n');
    copyText(text, 'Credentials copied');
  });
  $('secret-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) $('secret-modal').classList.add('hidden');
  });
  $('confirm-ok').addEventListener('click', () => closeConfirm(true));
  $('confirm-cancel').addEventListener('click', () => closeConfirm(false));
  $('confirm-modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeConfirm(false); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('confirm-modal').classList.contains('hidden')) return closeConfirm(false);
      if (!$('secret-modal').classList.contains('hidden')) return $('secret-modal').classList.add('hidden');
      closeAllMenus();
      if (state.view === 'logs' && state.selectedLog) closeDetail();
      return;
    }
    // "/" focuses search, unless already typing
    if (e.key === '/' && state.view === 'logs' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      $('q').focus();
    }
  });
}

function wireLogs() {
  let debounce = null;
  $('q').addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.search = $('q').value.trim();
      state.page = 1;
      loadLogsView();
    }, 350);
  });

  $('range-group').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b) return;
    state.range = b.dataset.range;
    state.page  = 1;
    qsa('#range-group button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    loadLogsView();
  });

  $('level-pills').addEventListener('click', (e) => {
    const b = e.target.closest('.pill');
    if (!b) return;
    const l = b.dataset.level;
    if (state.levels.has(l)) state.levels.delete(l); else state.levels.add(l);
    state.page = 1;
    loadLogsView();
  });

  $('filter-app').addEventListener('change', () => {
    state.app = $('filter-app').value; state.page = 1; loadLogsView();
  });
  $('filter-collector').addEventListener('change', () => {
    state.collector = $('filter-collector').value; state.page = 1; loadLogsView();
  });
  $('per-page').addEventListener('change', () => {
    state.limit = parseInt($('per-page').value, 10) || 50;
    state.page  = 1;
    loadLogsView();
  });

  $('prev-page').addEventListener('click', () => { if (state.page > 1) { state.page--; loadLogsView(); } });
  $('next-page').addEventListener('click', () => { if (state.page < state.pagination.pages) { state.page++; loadLogsView(); } });

  $('clear-filters').addEventListener('click', clearFilters);
  $('export-btn').addEventListener('click', exportLogs);
  $('live-btn').addEventListener('click', () => (state.live ? stopLive() : startLive()));

  $('logs-body').addEventListener('click', (e) => {
    const row = e.target.closest('.log-row');
    if (!row) return;
    if (state.selectedLog && String(state.selectedLog.id) === row.dataset.id) closeDetail();
    else openDetail(row.dataset.id);
  });

  $('detail-close').addEventListener('click', closeDetail);
}

function wireCollectors() {
  $('collectors-refresh').addEventListener('click', () => loadCollectors());

  $('collector-rows').addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy-endpoint]');
    if (copyBtn) {
      const c = state.collectors.find(x => x.id === Number(copyBtn.dataset.copyEndpoint));
      if (c?.endpoint) copyText(c.endpoint, 'Endpoint copied');
      return;
    }

    const toggle = e.target.closest('[data-toggle]');
    if (toggle) { await toggleCollector(toggle.dataset.toggle, toggle); return; }

    const menuBtn = e.target.closest('[data-menu]');
    if (menuBtn) {
      e.stopPropagation();
      const menu = qs(`[data-menu-for="${menuBtn.dataset.menu}"]`);
      const open = menu.classList.contains('hidden');
      closeAllMenus();
      menu.classList.toggle('hidden', !open);
      menuBtn.setAttribute('aria-expanded', String(open));
      return;
    }

    const act = e.target.closest('[data-act]');
    if (act) {
      closeAllMenus();
      const id = Number(act.dataset.id);
      switch (act.dataset.act) {
        case 'integrate':
          state.intCollector = id;
          renderCollectorRows(); renderIntegration();
          $('integration-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        case 'test':
          state.intCollector = id;
          renderIntegration();
          await testCollector(id);
          break;
        case 'rotate': await rotateCollector(id); break;
        case 'delete': await deleteCollector(id); break;
        case 'logs':
          state.collector = String(id);
          state.page = 1;
          navigate('logs');
          setTimeout(() => { $('filter-collector').value = String(id); }, 0);
          break;
      }
    }
  });

  // The security blurb hosts a rotate shortcut too.
  $('int-security').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act="rotate"]');
    if (act) await rotateCollector(Number(act.dataset.id));
  });

  $('int-select').addEventListener('change', () => {
    state.intCollector = Number($('int-select').value);
    state.revealSecret = false;
    renderCollectorRows();
    renderIntegration();
  });

  $('snippet-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lang]');
    if (!b) return;
    state.snippetLang = b.dataset.lang;
    renderIntegration();
  });

  $('snippet-copy').addEventListener('click', () => copyText($('snippet-code').textContent, 'Snippet copied'));

  $('snippet-reveal').addEventListener('click', () => {
    state.revealSecret = !state.revealSecret;
    renderIntegration();
    if (state.revealSecret) {
      toast('Only a preview of the stored credential is available — the full value is shown once at creation.', 'warn', 7000);
    }
  });

  $('int-test').addEventListener('click', () => {
    if (state.intCollector) testCollector(state.intCollector);
  });
}

function wireNewCollector() {
  const form = $('new-collector-form');

  form.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'nc-transfer') {
      state.draft.transfer_type = t.value;
      const cap = capOf(t.value);
      state.draft.auth_method = cap.authMethods[0];
      if (!cap.inputFormats.includes(state.draft.input_format)) state.draft.input_format = cap.inputFormats[0];
      $('nc-port').value = '';
      renderNewCollector();
    }
    if (t.name === 'nc-auth')   { state.draft.auth_method  = t.value; renderNewCollector(); }
    if (t.name === 'nc-format') { state.draft.input_format = t.value; renderNewCollector(); }
  });

  ['nc-name', 'nc-host', 'nc-port'].forEach(id =>
    $(id).addEventListener('input', renderPreview)
  );

  form.addEventListener('submit', submitNewCollector);
}

/* ── Boot ──────────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', async () => {
  if (!getToken()) { window.location.href = '/'; return; }

  const user = localStorage.getItem('authUser') || 'account';
  $('account-name').textContent = user;
  $('account-initials').textContent = user.slice(0, 2).toUpperCase();

  wireGlobal();
  wireLogs();
  wireCollectors();
  wireNewCollector();

  // Collector + app filter sources are shared by several views.
  await loadFilterSources();

  // Knowing whether the account has ever ingested anything decides between the
  // explorer and the first-run empty state before the first paint.
  try {
    const probe = await api('GET', '/logs?limit=1');
    state.everHadLogs = probe.pagination.total > 0;
  } catch { /* fall through to the explorer */ }

  renderView(window.location.hash.slice(1) || 'logs');
});
