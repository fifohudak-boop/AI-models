// Starts the real dashboard server against a small fake Postiz and checks the
// Fifofarm features end to end: automatic Postiz setup, the owner's sign-in
// surviving the team-accounts update, sign-up, who sees which account, network
// keys, account chooser links, verification files, legal pages, passwords and
// analytics.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fifofarm-server-'));
const runtimeDir = path.join(root, 'runtime');
fs.mkdirSync(runtimeDir);
const PORT = 41000 + Math.floor(Math.random() * 4000);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-session-secret';

// ---- Fake Postiz ----

let registered = false;
const integrations = [
  { id: 'i1', name: 'Reference engine', identifier: 'instagram-standalone', picture: null, profile: 'reference_engine', disabled: false },
];
const posts = new Map(); // id -> post
let nextPost = 1;

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
      if (p === '/integrations') return send(200, integrations);
      if (p.startsWith('/integration-settings/')) return send(200, { output: { maxLength: 2200 } });
      if (p === '/social/instagram-standalone') {
        return send(200, { url: 'https://www.instagram.com/oauth/authorize?enable_fb_login=0&client_id=950&state=abc' });
      }
      if (p === '/posts' && req.method === 'POST') {
        const data = JSON.parse(body);
        const id = `p${nextPost++}`;
        posts.set(id, {
          id,
          publishDate: new Date(Date.now() - 60_000).toISOString(),
          state: 'PUBLISHED',
          releaseURL: `https://x.com/i/status/${id}`,
          releaseId: `rel-${id}`,
          integration: { id: data.posts[0].integration.id },
        });
        return send(200, [{ postId: id, integration: data.posts[0].integration.id }]);
      }
      if (p === '/posts' && req.method === 'GET') return send(200, { posts: [...posts.values()] });
      if (p.startsWith('/analytics/post/')) {
        const id = decodeURIComponent(p.slice('/analytics/post/'.length));
        if (!posts.has(id)) return send(200, []);
        const today = new Date().toISOString().slice(0, 10);
        return send(200, [
          { label: 'Impressions', percentageChange: 0, data: [{ total: '120', date: today }] },
          { label: 'Likes', percentageChange: 0, data: [{ total: '7', date: today }] },
          { label: 'Retweets', percentageChange: 0, data: [{ total: '2', date: today }] },
        ]);
      }
      if (p.startsWith('/analytics/')) {
        const today = new Date().toISOString().slice(0, 10);
        return send(200, [
          { label: 'Followers', percentageChange: 0, data: [{ total: '1500', date: today }] },
          {
            label: 'Reach',
            percentageChange: 0,
            data: [
              { total: '10', date: '2026-01-01' },
              { total: '20', date: today },
            ],
          },
        ]);
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
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: path.join(root, 'data'),
      RUNTIME_DIR: runtimeDir,
      DASHBOARD_PASSWORD: 'first-password',
      DASHBOARD_SECRET: SECRET,
      DASHBOARD_URL: `http://127.0.0.1:${PORT}`,
      POSTIZ_INTERNAL_URL: `http://127.0.0.1:${fakePort}`,
      POSTIZ_URL: 'https://postiz.example.org',
      INSTAGRAM_APP_ID: '950',
      INSTAGRAM_APP_SECRET: 'ig-secret-value-xyz',
      TEMPORAL_HTTP_URL: '',
      POSTIZ_API_KEY: '',
      ANALYTICS_LOOP: 'off',
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

let owner;
let ana;

test('a browser signed in before the update stays signed in as the owner', async () => {
  const expires = String(Math.floor(Date.now() / 1000) + 3600);
  const payload = `${expires}.0`;
  const legacy = `autopost_session=${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
  const r = await api('/api/session', { cookie: legacy });
  assert.equal(r.json.loggedIn, true);
  assert.equal(r.json.user.role, 'owner');
  assert.equal(r.json.ownerNeedsEmail, true);
  assert.equal((await api('/api/team', { cookie: legacy })).status, 200);
});

test('the owner signs in with just the password until they add an email', async () => {
  assert.equal((await api('/api/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  const ok = await api('/api/login', { method: 'POST', body: { email: '', password: 'first-password' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.role, 'owner');
  owner = cookieFrom(ok.res);
  const status = await api('/api/status', { cookie: owner });
  assert.equal(status.json.postiz, 'ok');
  assert.equal(status.json.brand, 'Fifofarm');
  const system = await api('/api/system', { cookie: owner });
  assert.equal(system.json.postizLogin.email, 'owner@fifofarm.localhost');
  assert.equal(system.json.domains.serverMode, false);
});

test('anyone can sign up as a member while sign-up is open', async () => {
  const bad = await api('/api/signup', { method: 'POST', body: { name: 'Ana', email: 'not-an-email', password: 'ana-password' } });
  assert.equal(bad.status, 400);
  const short = await api('/api/signup', { method: 'POST', body: { name: 'Ana', email: 'ana@example.com', password: 'short' } });
  assert.equal(short.status, 400);
  const r = await api('/api/signup', { method: 'POST', body: { name: 'Ana', email: 'Ana@Example.com', password: 'ana-password' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.user.role, 'member');
  assert.equal(r.json.user.email, 'ana@example.com');
  ana = cookieFrom(r.res);
  const dup = await api('/api/signup', { method: 'POST', body: { name: 'Ana 2', email: 'ana@example.com', password: 'ana-password' } });
  assert.equal(dup.status, 400);
  const login = await api('/api/login', { method: 'POST', body: { email: 'ANA@example.com', password: 'ana-password' } });
  assert.equal(login.status, 200);
  assert.equal((await api('/api/login', { method: 'POST', body: { email: 'ana@example.com', password: 'nope-nope' } })).status, 401);
});

test('members only see the owner-only pages as forbidden', async () => {
  for (const [method, url, body] of [
    ['GET', '/api/system'],
    ['GET', '/api/team'],
    ['PUT', '/api/networks/tiktok', { values: { TIKTOK_CLIENT_ID: 'a', TIKTOK_CLIENT_SECRET: 'b' } }],
    ['PUT', '/api/preferences', { autoShorten: false }],
    ['PUT', '/api/settings/domain', { domain: 'fifofarm.com' }],
  ]) {
    assert.equal((await api(url, { method, cookie: ana, body })).status, 403, url);
  }
});

test('a member sees only the accounts they connected; the owner sees all', async () => {
  assert.deepEqual((await api('/api/accounts', { cookie: ana })).json, []);
  const connect = await api('/api/accounts/connect', { method: 'POST', cookie: ana, body: { provider: 'instagram-standalone' } });
  assert.equal(connect.status, 200);
  // Ana approves in Instagram's window; Postiz now has her account.
  integrations.push({ id: 'i2', name: 'Ana IG', identifier: 'instagram-standalone', picture: null, profile: 'ana', disabled: false });
  const mine = (await api('/api/accounts', { cookie: ana })).json;
  assert.deepEqual(
    mine.map((a) => a.id),
    ['i2']
  );
  const all = (await api('/api/accounts', { cookie: owner })).json;
  assert.deepEqual(
    all.map((a) => [a.id, a.ownerName]),
    [
      ['i1', 'Owner'],
      ['i2', 'Ana'],
    ]
  );
  // Ana can't touch the owner's account.
  assert.equal((await api('/api/accounts/i1', { method: 'DELETE', cookie: ana })).status, 404);
  const post = await api('/api/posts', { method: 'POST', cookie: ana, body: { accountIds: ['i1'], caption: 'hi' } });
  assert.equal(post.status, 400);
});

test('the owner can move an account to someone else', async () => {
  const team = (await api('/api/team', { cookie: owner })).json;
  const ownerId = team.users.find((u) => u.role === 'owner').id;
  assert.equal(team.users.find((u) => u.email === 'ana@example.com').accounts, 1);
  const moved = await api('/api/accounts/i2/owner', { method: 'PUT', cookie: owner, body: { userId: ownerId } });
  assert.equal(moved.status, 200);
  assert.deepEqual((await api('/api/accounts', { cookie: ana })).json, []);
  const back = team.users.find((u) => u.email === 'ana@example.com').id;
  await api('/api/accounts/i2/owner', { method: 'PUT', cookie: owner, body: { userId: back } });
  assert.equal((await api('/api/accounts', { cookie: ana })).json.length, 1);
});

test('the owner can close sign-up', async () => {
  assert.equal((await api('/api/team/signups', { method: 'PUT', cookie: owner, body: { open: false } })).json.signupsOpen, false);
  const r = await api('/api/signup', { method: 'POST', body: { name: 'Bo', email: 'bo@example.com', password: 'bo-password' } });
  assert.equal(r.status, 403);
  assert.equal((await api('/api/session')).json.signupsOpen, false);
  await api('/api/team/signups', { method: 'PUT', cookie: owner, body: { open: true } });
});

test('network keys are validated and queued for the server helper', async () => {
  const list = await api('/api/networks', { cookie: owner });
  assert.equal(list.json.setups.find((s) => s.id === 'instagram').configured, true);
  assert.ok(!list.text.includes('ig-secret-value-xyz'));
  const bad = await api('/api/networks/tiktok', { method: 'PUT', cookie: owner, body: { values: { TIKTOK_CLIENT_ID: 'has space' } } });
  assert.equal(bad.status, 400);
  const good = await api('/api/networks/tiktok', {
    method: 'PUT',
    cookie: owner,
    body: { values: { TIKTOK_CLIENT_ID: 'awkey123', TIKTOK_CLIENT_SECRET: 'sec456' } },
  });
  assert.equal(good.status, 200);
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'pending.env'), 'utf8'), 'TIKTOK_CLIENT_ID=awkey123\nTIKTOK_CLIENT_SECRET=sec456\n');
});

test('verification files are served publicly at the site root', async () => {
  const up = await api('/api/verification', {
    method: 'PUT',
    cookie: owner,
    body: { name: 'tiktokAbC123.txt', content: 'tiktok-developers-site-verification=xyz' },
  });
  assert.equal(up.status, 200);
  const pub = await api('/tiktokAbC123.txt');
  assert.equal(pub.status, 200);
  assert.equal(pub.text, 'tiktok-developers-site-verification=xyz');
  assert.equal((await api('/missing123.txt')).status, 404);
  await api('/api/verification/tiktokAbC123.txt', { method: 'DELETE', cookie: owner });
  assert.equal((await api('/tiktokAbC123.txt')).status, 404);
});

test('"Add another" and shared links ask Instagram which account to use', async () => {
  const first = await api('/api/accounts/connect', { method: 'POST', cookie: owner, body: { provider: 'instagram-standalone' } });
  assert.ok(!first.json.url.includes('force_reauth'));
  const another = await api('/api/accounts/connect', {
    method: 'POST',
    cookie: owner,
    body: { provider: 'instagram-standalone', another: true },
  });
  assert.ok(another.json.url.endsWith('&force_reauth=true'));
  const link = await api('/api/accounts/connect-link', { method: 'POST', cookie: owner, body: { provider: 'instagram-standalone' } });
  assert.ok(link.json.url.endsWith('&force_reauth=true'));
  assert.ok(Date.parse(link.json.expiresAt) > Date.now());
  const notSetUp = await api('/api/accounts/connect', { method: 'POST', cookie: owner, body: { provider: 'youtube' } });
  assert.equal(notSetUp.status, 400);
  assert.match(notSetUp.json.error, /Set up/);
});

test('domain changes need server mode; cross-site requests are blocked', async () => {
  const r = await api('/api/settings/domain', { method: 'PUT', cookie: owner, body: { domain: 'fifofarm.com' } });
  assert.equal(r.status, 409);
  const cross = await api('/api/settings/domain', {
    method: 'PUT',
    cookie: owner,
    origin: 'https://evil.example',
    body: { domain: 'fifofarm.com' },
  });
  assert.equal(cross.status, 403);
});

test('posts and analytics: everyone sees the numbers of their own accounts', async () => {
  integrations.push({ id: 'x1', name: 'Fifo on X', identifier: 'x', picture: null, profile: 'fifo', disabled: false });
  await api('/api/accounts', { cookie: owner }); // owner refreshes; x1 is theirs
  const posted = await api('/api/posts', { method: 'POST', cookie: owner, body: { accountIds: ['x1'], caption: 'First post' } });
  assert.equal(posted.status, 201);
  const postId = posted.json.items[0].postId;
  assert.ok(postId);

  const fresh = await api('/api/analytics/refresh?days=30', { method: 'POST', cookie: owner });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.totals.videos, 1);
  assert.equal(fresh.json.totals.views, 120); // X reports impressions
  assert.equal(fresh.json.totals.likes, 7);
  assert.equal(fresh.json.totals.shares, 2);
  const video = fresh.json.videos.find((v) => v.postId === postId);
  assert.equal(video.status, 'ok');
  assert.equal(video.caption, 'First post');
  assert.equal(video.accountName, 'Fifo on X');
  const x = fresh.json.accounts.find((a) => a.id === 'x1');
  assert.equal(x.views, 120);
  assert.equal(x.network.find((m) => m.key === 'followers').value, 1500);
  assert.equal(x.network.find((m) => m.key === 'reach').value, 20); // only points inside the period count
  assert.equal(fresh.json.daily.reduce((sum, d) => sum + d.views, 0), 120);

  const detail = await api(`/api/analytics/videos/${postId}`, { cookie: owner });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.history.length, 1);
  assert.equal(detail.json.history[0].views, 120);

  // Ana sees neither the owner's post nor its numbers.
  const anas = await api('/api/analytics', { cookie: ana });
  assert.equal(anas.json.totals.videos, 0);
  assert.ok(!anas.json.accounts.some((a) => a.id === 'x1'));
  assert.equal((await api(`/api/analytics/videos/${postId}`, { cookie: ana })).status, 404);
  assert.deepEqual((await api('/api/batches', { cookie: ana })).json, []);
  const history = (await api('/api/batches', { cookie: owner })).json;
  assert.equal(history[0].userName, 'Owner');
  assert.equal((await api(`/api/batches/${posted.json.id}`, { cookie: ana })).status, 404);
});

test('changing a password signs that person out of other browsers', async () => {
  const other = cookieFrom((await api('/api/login', { method: 'POST', body: { password: 'first-password' } })).res);
  const wrong = await api('/api/settings/password', { method: 'PUT', cookie: owner, body: { current: 'nope', next: 'second-password' } });
  assert.equal(wrong.status, 400);
  const short = await api('/api/settings/password', { method: 'PUT', cookie: owner, body: { current: 'first-password', next: 'short' } });
  assert.equal(short.status, 400);
  const ok = await api('/api/settings/password', {
    method: 'PUT',
    cookie: owner,
    body: { current: 'first-password', next: 'second-password' },
  });
  assert.equal(ok.status, 200);
  owner = cookieFrom(ok.res);
  assert.equal((await api('/api/status', { cookie: other })).status, 401);
  assert.equal((await api('/api/status', { cookie: owner })).status, 200);
  assert.equal((await api('/api/status', { cookie: ana })).status, 200); // Ana isn't affected
  assert.equal((await api('/api/login', { method: 'POST', body: { password: 'first-password' } })).status, 401);
  assert.equal((await api('/api/login', { method: 'POST', body: { password: 'second-password' } })).status, 200);
});

test('the owner can reset a member password and remove members', async () => {
  const team = (await api('/api/team', { cookie: owner })).json;
  const anaId = team.users.find((u) => u.email === 'ana@example.com').id;
  const reset = await api(`/api/team/${anaId}/reset-password`, { method: 'POST', cookie: owner });
  assert.equal(reset.status, 200);
  assert.equal((await api('/api/status', { cookie: ana })).status, 401); // signed out
  const login = await api('/api/login', { method: 'POST', body: { email: 'ana@example.com', password: reset.json.password } });
  assert.equal(login.status, 200);
  assert.equal((await api(`/api/team/${anaId}`, { method: 'DELETE', cookie: owner })).status, 200);
  assert.equal((await api('/api/status', { cookie: cookieFrom(login.res) })).status, 401);
  // Her account now belongs to the owner.
  const all = (await api('/api/accounts', { cookie: owner })).json;
  assert.equal(all.find((a) => a.id === 'i2').ownerName, 'Owner');
});

test('once the owner adds an email, they sign in with it', async () => {
  const me = await api('/api/me', { method: 'PUT', cookie: owner, body: { name: 'Filip', email: 'filip@example.com' } });
  assert.equal(me.status, 200);
  assert.equal(me.json.ownerNeedsEmail, false);
  assert.equal((await api('/api/login', { method: 'POST', body: { password: 'second-password' } })).status, 400);
  const ok = await api('/api/login', { method: 'POST', body: { email: 'filip@example.com', password: 'second-password' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.name, 'Filip');
});
