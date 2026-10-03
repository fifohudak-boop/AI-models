// Starts the real dashboard server against a small fake Postiz and checks the
// Fifofarm features end to end: automatic Postiz setup, network keys, account
// chooser links, verification files, legal pages and password changes.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fifofarm-server-'));
const runtimeDir = path.join(root, 'runtime');
fs.mkdirSync(runtimeDir);
const PORT = 41000 + Math.floor(Math.random() * 4000);
const BASE = `http://127.0.0.1:${PORT}`;

let registered = false;
const fakePostiz = http.createServer((req, res) => {
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (url.pathname === '/api/auth/can-register') return send(200, { register: !registered });
    if (url.pathname === '/api/auth/register' && req.method === 'POST') {
      const data = JSON.parse(body);
      assert.equal(data.provider, 'LOCAL');
      assert.match(data.email, /^owner@/);
      assert.ok(data.password.length >= 20);
      registered = true;
      return send(200, { register: true }, {
        'Set-Cookie': 'auth=JWT123; Domain=.example.org; Path=/; HttpOnly; Secure; SameSite=None',
      });
    }
    if (url.pathname === '/api/user/self') {
      return req.headers.auth === 'JWT123' ? send(200, { publicApi: 'KEY123' }) : send(401, { msg: 'no' });
    }
    if (url.pathname.startsWith('/api/public/v1/')) {
      if (req.headers.authorization !== 'KEY123') return send(401, { msg: 'bad key' });
      const p = url.pathname.slice('/api/public/v1'.length);
      if (p === '/is-connected') return send(200, { connected: true });
      if (p === '/integrations') {
        return send(200, [
          { id: 'i1', name: 'Reference engine', identifier: 'instagram-standalone', picture: null, profile: 'reference_engine', disabled: false },
        ]);
      }
      if (p === '/integration-settings/i1') return send(200, { output: { maxLength: 2200 } });
      if (p === '/social/instagram-standalone') {
        return send(200, { url: 'https://www.instagram.com/oauth/authorize?enable_fb_login=0&client_id=950&state=abc' });
      }
    }
    send(404, { msg: 'not found' });
  });
});

let server;
let fakePort;

async function waitFor(fn, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // not yet
    }
    if (Date.now() - started > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 300));
  }
}

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

async function api(pathname, { method = 'GET', body, cookie, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { res, status: res.status, json, text };
}

before(async () => {
  await new Promise((r) => fakePostiz.listen(0, '127.0.0.1', r));
  fakePort = fakePostiz.address().port;
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: path.join(root, 'data'),
      RUNTIME_DIR: runtimeDir,
      DASHBOARD_PASSWORD: 'first-password',
      DASHBOARD_URL: `http://127.0.0.1:${PORT}`,
      POSTIZ_INTERNAL_URL: `http://127.0.0.1:${fakePort}`,
      POSTIZ_URL: 'https://postiz.example.org',
      INSTAGRAM_APP_ID: '950',
      INSTAGRAM_APP_SECRET: 'ig-secret-value-xyz',
      TEMPORAL_HTTP_URL: '',
      POSTIZ_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(d));
  await waitFor(async () => (await api('/api/health')).status === 200);
});

after(() => {
  server?.kill();
  fakePostiz.close();
});

test('creates the Postiz account and API key by itself', async () => {
  const health = await waitFor(async () => {
    const r = await api('/api/health');
    return r.json?.engine === 'ready' ? r.json : null;
  });
  assert.equal(health.setup, 'done');
  const settings = JSON.parse(fs.readFileSync(path.join(root, 'data', 'settings.json'), 'utf8'));
  assert.equal(settings.postizApiKey, 'KEY123');
  assert.equal(settings.postizLogin.email, 'owner@fifofarm.localhost');
});

test('legal pages are public and branded', async () => {
  const r = await api('/legal/privacy');
  assert.equal(r.status, 200);
  assert.match(r.text, /Fifofarm — Privacy Policy/);
  assert.equal((await api('/legal/nope')).status, 404);
});

let cookie;

test('login, status and system info', async () => {
  assert.equal((await api('/api/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  const ok = await api('/api/login', { method: 'POST', body: { password: 'first-password' } });
  assert.equal(ok.status, 200);
  cookie = cookieFrom(ok.res);
  const status = await api('/api/status', { cookie });
  assert.equal(status.json.postiz, 'ok');
  assert.equal(status.json.brand, 'Fifofarm');
  const system = await api('/api/system', { cookie });
  assert.equal(system.json.postizLogin.email, 'owner@fifofarm.localhost');
  assert.equal(system.json.domains.serverMode, false);
});

test('network keys are validated and queued for the server helper', async () => {
  const list = await api('/api/networks', { cookie });
  assert.equal(list.json.setups.find((s) => s.id === 'instagram').configured, true);
  assert.ok(!list.text.includes('ig-secret-value-xyz'));
  const bad = await api('/api/networks/tiktok', { method: 'PUT', cookie, body: { values: { TIKTOK_CLIENT_ID: 'has space' } } });
  assert.equal(bad.status, 400);
  const good = await api('/api/networks/tiktok', {
    method: 'PUT',
    cookie,
    body: { values: { TIKTOK_CLIENT_ID: 'awkey123', TIKTOK_CLIENT_SECRET: 'sec456' } },
  });
  assert.equal(good.status, 200);
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'pending.env'), 'utf8'), 'TIKTOK_CLIENT_ID=awkey123\nTIKTOK_CLIENT_SECRET=sec456\n');
});

test('verification files are served publicly at the site root', async () => {
  const up = await api('/api/verification', {
    method: 'PUT',
    cookie,
    body: { name: 'tiktokAbC123.txt', content: 'tiktok-developers-site-verification=xyz' },
  });
  assert.equal(up.status, 200);
  const pub = await api('/tiktokAbC123.txt');
  assert.equal(pub.status, 200);
  assert.equal(pub.text, 'tiktok-developers-site-verification=xyz');
  assert.equal((await api('/missing123.txt')).status, 404);
  await api('/api/verification/tiktokAbC123.txt', { method: 'DELETE', cookie });
  assert.equal((await api('/tiktokAbC123.txt')).status, 404);
});

test('"Add another" and shared links ask Instagram which account to use', async () => {
  const first = await api('/api/accounts/connect', { method: 'POST', cookie, body: { provider: 'instagram-standalone' } });
  assert.ok(!first.json.url.includes('force_reauth'));
  const another = await api('/api/accounts/connect', {
    method: 'POST',
    cookie,
    body: { provider: 'instagram-standalone', another: true },
  });
  assert.ok(another.json.url.endsWith('&force_reauth=true'));
  const link = await api('/api/accounts/connect-link', { method: 'POST', cookie, body: { provider: 'instagram-standalone' } });
  assert.ok(link.json.url.endsWith('&force_reauth=true'));
  assert.ok(Date.parse(link.json.expiresAt) > Date.now());
  const notSetUp = await api('/api/accounts/connect', { method: 'POST', cookie, body: { provider: 'youtube' } });
  assert.equal(notSetUp.status, 400);
  assert.match(notSetUp.json.error, /Set up/);
});

test('domain changes need server mode; cross-site requests are blocked', async () => {
  const r = await api('/api/settings/domain', { method: 'PUT', cookie, body: { domain: 'fifofarm.com' } });
  assert.equal(r.status, 409);
  const cross = await api('/api/settings/domain', {
    method: 'PUT',
    cookie,
    origin: 'https://evil.example',
    body: { domain: 'fifofarm.com' },
  });
  assert.equal(cross.status, 403);
});

test('changing the password signs out other sessions', async () => {
  const other = cookieFrom((await api('/api/login', { method: 'POST', body: { password: 'first-password' } })).res);
  const wrong = await api('/api/settings/password', { method: 'PUT', cookie, body: { current: 'nope', next: 'second-password' } });
  assert.equal(wrong.status, 400);
  const short = await api('/api/settings/password', { method: 'PUT', cookie, body: { current: 'first-password', next: 'short' } });
  assert.equal(short.status, 400);
  const ok = await api('/api/settings/password', {
    method: 'PUT',
    cookie,
    body: { current: 'first-password', next: 'second-password' },
  });
  assert.equal(ok.status, 200);
  const fresh = cookieFrom(ok.res);
  assert.equal((await api('/api/status', { cookie: other })).status, 401);
  assert.equal((await api('/api/status', { cookie: fresh })).status, 200);
  assert.equal((await api('/api/login', { method: 'POST', body: { password: 'first-password' } })).status, 401);
  assert.equal((await api('/api/login', { method: 'POST', body: { password: 'second-password' } })).status, 200);
});
