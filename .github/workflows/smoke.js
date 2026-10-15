'use strict';
/* End-to-end smoke test run by .github/workflows/ci.yml against a booted server. */
const dgram = require('dgram');
const BASE = process.env.BASE || 'http://localhost:3998';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

const j = async (path, opts = {}) => {
  const res = await fetch(BASE + path, opts);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
};

(async () => {
  const user = 'smoke' + Date.now();

  let r = await j('/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, email: `${user}@ex.com`, password: 'password123' }),
  });
  ok('register', r.status === 201, JSON.stringify(r.body));

  r = await j('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: 'password123' }),
  });
  ok('login', r.status === 200 && !!r.body.token, JSON.stringify(r.body));
  const jwt = r.body.token;
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` };

  // capabilities
  r = await j('/collectors/capabilities', { headers: auth });
  const types = (r.body && r.body.transferTypes || []).map(t => t.value);
  ok('capabilities lists http+udp',
    r.status === 200 && types.includes('http') && types.includes('udp'), JSON.stringify(types));
  ok('capabilities exposes udp runtime config',
    r.body && r.body.udp && typeof r.body.udp.max_listeners === 'number',
    JSON.stringify(r.body && r.body.udp));

  // http json_array
  r = await j('/collectors', { method: 'POST', headers: auth, body: JSON.stringify({
    name: 'http-arr', transfer_type: 'http', auth_method: 'api_token', input_format: 'json_array' }) });
  ok('create http json_array collector', r.status === 201, JSON.stringify(r.body));
  const arrTok = r.body.secrets && r.body.secrets.api_token;
  const arrId  = r.body.id;

  r = await j('/logs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Token': arrTok },
    body: JSON.stringify([
      { app: 'svc', level: 'info', message: 'a' },
      { app: 'svc', level: 'warn', message: 'b' },
      { app: 'svc', level: 'error', message: 'c' }]) });
  ok('json_array batch -> inserted=3', r.status === 201 && r.body.inserted === 3, JSON.stringify(r.body));

  r = await j('/logs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Token': arrTok },
    body: JSON.stringify({ app: 'svc', message: 'single object' }) });
  ok('json_array collector rejects object -> 400', r.status === 400, JSON.stringify(r.body));

  // http ndjson
  r = await j('/collectors', { method: 'POST', headers: auth, body: JSON.stringify({
    name: 'http-nd', transfer_type: 'http', auth_method: 'api_token', input_format: 'ndjson' }) });
  ok('create http ndjson collector', r.status === 201, JSON.stringify(r.body));
  const ndTok = r.body.secrets && r.body.secrets.api_token;

  let res = await fetch(BASE + '/logs', { method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Token': ndTok },
    body: '{"app":"nd","level":"info","message":"l1"}\n{"app":"nd","level":"info","message":"l2"}\nNOT_JSON\n' });
  let b = await res.json();
  ok('ndjson batch -> inserted=2 rejected=1',
    res.status === 201 && b.inserted === 2 && b.rejected === 1, JSON.stringify(b));

  // udp
  r = await j('/collectors', { method: 'POST', headers: auth, body: JSON.stringify({
    name: 'udp-1', transfer_type: 'udp', auth_method: 'none', input_format: 'ndjson', port: 10001 }) });
  ok('create udp collector on 10001', r.status === 201, JSON.stringify(r.body));
  const udpId = r.body.id;
  ok('udp collector reports listening', r.body.listener_status &&
    String(r.body.listener_status.state || r.body.listener_status).includes('listening'),
    JSON.stringify(r.body.listener_status));

  r = await j('/collectors', { method: 'POST', headers: auth, body: JSON.stringify({
    name: 'udp-2', transfer_type: 'udp', auth_method: 'none', input_format: 'ndjson', port: 10002 }) });
  ok('second udp collector -> 409', r.status === 409, JSON.stringify(r.body));

  r = await j('/collectors', { method: 'POST', headers: auth, body: JSON.stringify({
    name: 'udp-bad', transfer_type: 'udp', auth_method: 'none', input_format: 'ndjson', port: 22 }) });
  ok('out-of-range udp port -> 400', r.status === 400, JSON.stringify(r.body));

  r = await j('/collectors', { method: 'POST', headers: auth, body: JSON.stringify({
    name: 'udp-auth', transfer_type: 'udp', auth_method: 'api_token', input_format: 'ndjson', port: 10003 }) });
  ok('udp + api_token -> 400', r.status === 400, JSON.stringify(r.body));

  // real datagram
  const sock = dgram.createSocket('udp4');
  await new Promise(resolve => {
    sock.send(Buffer.from('{"app":"udp","level":"info","message":"from datagram"}\n{"app":"udp","level":"warn","message":"second"}\n'),
      10001, '127.0.0.1', () => { sock.close(); resolve(); });
  });
  await new Promise(r2 => setTimeout(r2, 1500));
  r = await j('/logs?limit=200&app=udp', { headers: auth });
  ok('udp datagram stored 2 events', (r.body.logs || []).length === 2, `got ${(r.body.logs || []).length}`);

  r = await j(`/collectors/${udpId}/test`, { method: 'POST', headers: auth });
  ok('udp self-test ok', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

  // disable http -> ingest blocked
  r = await j(`/collectors/${arrId}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ enabled: false }) });
  ok('disable http collector', r.status === 200 && r.body.enabled === false, JSON.stringify(r.body));
  r = await j('/logs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Token': arrTok },
    body: JSON.stringify([{ app: 'svc', message: 'should fail' }]) });
  ok('disabled collector -> 403', r.status === 403, JSON.stringify(r.body));

  // disable udp releases the port
  r = await j(`/collectors/${udpId}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ enabled: false }) });
  ok('disable udp collector', r.status === 200, JSON.stringify(r.body));
  await new Promise(r2 => setTimeout(r2, 500));
  const free = await new Promise(resolve => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    s.once('error', () => resolve(false));
    s.bind(10001, '0.0.0.0', () => s.close(() => resolve(true)));
  });
  ok('port 10001 released after disable', free);

  r = await j(`/collectors/${udpId}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ enabled: true }) });
  ok('re-enable udp collector', r.status === 200 && r.body.enabled === true, JSON.stringify(r.body));

  // port change
  r = await j(`/collectors/${udpId}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ port: 10005 }) });
  ok('change udp port -> 10005', r.status === 200 && r.body.port === 10005, JSON.stringify(r.body));
  await new Promise(r2 => setTimeout(r2, 400));
  const oldFree = await new Promise(resolve => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    s.once('error', () => resolve(false));
    s.bind(10001, '0.0.0.0', () => s.close(() => resolve(true)));
  });
  ok('old port released after port change', oldFree);

  const sock2 = dgram.createSocket('udp4');
  await new Promise(resolve => {
    sock2.send(Buffer.from('{"app":"moved","level":"info","message":"new port"}\n'),
      10005, '127.0.0.1', () => { sock2.close(); resolve(); });
  });
  await new Promise(r2 => setTimeout(r2, 1500));
  r = await j('/logs?limit=50&app=moved', { headers: auth });
  ok('datagram on new port stored', (r.body.logs || []).length === 1, `got ${(r.body.logs || []).length}`);

  // FTS
  r = await j('/logs?search=datagram', { headers: auth });
  ok('FTS search works', r.status === 200 && (r.body.logs || []).length >= 1,
    JSON.stringify(r.body).slice(0, 160));

  // oauth
  r = await j('/collectors', { method: 'POST', headers: auth, body: JSON.stringify({
    name: 'oauth-c', transfer_type: 'http', auth_method: 'oauth_client_credentials', input_format: 'json_array' }) });
  ok('create oauth collector', r.status === 201, JSON.stringify(r.body));
  const cid  = r.body.secrets && r.body.secrets.client_id;
  const csec = r.body.secrets && r.body.secrets.client_secret;

  r = await j('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: cid, client_secret: csec }) });
  ok('oauth token issued', r.status === 200 && !!r.body.access_token, JSON.stringify(r.body));
  const at = r.body.access_token;
  const rt = r.body.refresh_token;

  r = await j('/logs', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${at}` },
    body: JSON.stringify([{ app: 'oa', level: 'info', message: 'via oauth' }]) });
  ok('oauth ingest -> inserted=1', r.status === 201 && r.body.inserted === 1, JSON.stringify(r.body));

  r = await j('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: rt }) });
  ok('refresh token rotates', r.status === 200 && !!r.body.access_token, JSON.stringify(r.body));

  // list
  r = await j('/collectors', { headers: auth });
  const list = Array.isArray(r.body) ? r.body : [];
  const udpRow = list.find(c => c.transfer_type === 'udp');
  ok('collector list reports listener_status', !!udpRow && !!udpRow.listener_status,
    JSON.stringify(udpRow && udpRow.listener_status));
  ok('collector list hides raw token',
    list.every(c => (c.credentials || []).every(cr => !cr.token)), 'a raw token leaked');

  // burst
  const burst = dgram.createSocket('udp4');
  for (let i = 0; i < 200; i++) {
    burst.send(Buffer.from(JSON.stringify({ app: 'burst', level: 'info', message: 'm' + i }) + '\n'), 10005, '127.0.0.1');
  }
  await new Promise(r2 => setTimeout(r2, 4000));
  burst.close();
  r = await j('/logs?limit=200&app=burst', { headers: auth });
  ok('200-datagram burst stored', (r.body.pagination || {}).total === 200,
    `got ${(r.body.pagination || {}).total}`);

  // rotate
  r = await j(`/collectors/${arrId}/rotate`, { method: 'POST', headers: auth });
  ok('rotate credentials', r.status === 200 && !!r.body.secrets.api_token, JSON.stringify(r.body));
  const newTok = r.body.secrets.api_token;
  r = await j('/logs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Token': arrTok },
    body: JSON.stringify([{ app: 'svc', message: 'old token' }]) });
  ok('old token invalid after rotate', r.status === 401, JSON.stringify(r.body));

  // ── Dashboard contract ────────────────────────────────────────────────
  // The UI is static + fetch-driven, so these two checks are what protect it:
  // the aggregate endpoint it renders from, and the assets it loads.
  r = await j('/logs/stats?buckets=60', { headers: auth });
  ok('GET /logs/stats', r.status === 200, JSON.stringify(r.body && r.body.range));
  ok('stats returns 60 buckets', (r.body.buckets || []).length === 60);
  ok('stats returns a level breakdown',
    r.body.levels && typeof r.body.levels.error === 'number', JSON.stringify(r.body.levels));
  const bucketSum = (r.body.buckets || []).reduce((a, b) => a + b.total, 0);
  ok('histogram total matches level total', bucketSum === r.body.total, `${bucketSum} vs ${r.body.total}`);

  r = await j('/logs/stats?level=error', { headers: auth });
  ok('level filter does not narrow the level breakdown',
    r.body.levels && r.body.levels.info > 0, JSON.stringify(r.body.levels));

  r = await j('/logs?level=error,warn&limit=200', { headers: auth });
  ok('multi-level filter accepted', r.status === 200, JSON.stringify(r.body && r.body.pagination));

  for (const asset of ['/', '/dashboard.html', '/css/app.css', '/js/dashboard.js', '/js/auth.js', '/favicon.svg']) {
    const res = await fetch(BASE + asset);
    ok(`static asset ${asset}`, res.status === 200, `status ${res.status}`);
  }

  // delete
  r = await j(`/collectors/${udpId}`, { method: 'DELETE', headers: auth });
  ok('delete udp collector', r.status === 200, JSON.stringify(r.body));
  await new Promise(r2 => setTimeout(r2, 400));
  const freeAfterDelete = await new Promise(resolve => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    s.once('error', () => resolve(false));
    s.bind(10005, '0.0.0.0', () => s.close(() => resolve(true)));
  });
  ok('port released after delete', freeAfterDelete);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SMOKE CRASH:', e); process.exit(1); });
