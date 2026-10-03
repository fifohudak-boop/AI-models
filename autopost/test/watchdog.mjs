// Resilience test: breaks Postiz the way it breaks in the wild (its
// background worker stops picking up jobs while everything else looks fine),
// posts during the outage, and checks that the watchdog restarts Postiz and
// the post goes out by itself. Run after run-e2e.sh (needs its accounts).
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const DASHBOARD = process.env.DASHBOARD_URL || 'http://localhost:3000';
const PASSWORD = process.env.DASHBOARD_PASSWORD;
const COMPOSE = ['compose', '-f', 'docker-compose.yml', '-f', 'test/docker-compose.test.yml', ...(process.env.EXTRA_COMPOSE ?? '').split(' ').filter(Boolean)];
assert.ok(PASSWORD, 'set DASHBOARD_PASSWORD');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
const docker = (...args) => execFileSync('docker', [...COMPOSE, ...args], { cwd: '..', encoding: 'utf8' });

const login = await fetch(`${DASHBOARD}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
});
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = async (path, body) => {
  const res = await fetch(`${DASHBOARD}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
};

const containerId = docker('ps', '-q', 'postiz').trim();
const startedAt = () => execFileSync('docker', ['inspect', '-f', '{{.State.StartedAt}}', containerId], { encoding: 'utf8' }).trim();
const before = startedAt();

// Freeze the worker process: exactly the state seen in the wild, where it
// hangs without crashing (so pm2 and Docker both think it's fine).
log('Freezing the Postiz worker (simulating the silent-worker bug)…');
docker(
  'exec',
  '-T',
  'postiz',
  'sh',
  '-c',
  'for p in /proc/[0-9]*; do case "$(tr "\\0" " " < $p/cmdline 2>/dev/null)" in "node --experimental-require-module ./dist/apps/orchestrator/"*) kill -STOP ${p#/proc/};; esac; done'
);

log('Posting while the worker is down…');
const [account] = (await api('/api/accounts')).filter((a) => a.identifier === 'mastodon');
assert.ok(account, 'run run-e2e.sh first so a Mastodon account exists');
const batch = await api('/api/posts', { caption: 'Posted during an outage', accountIds: [account.id], mediaId: null });
assert.equal(batch.items[0].state, 'posting');

let sawDown = false;
let restarted = false;
const deadline = Date.now() + 15 * 60 * 1000;
while (Date.now() < deadline) {
  await sleep(15_000);
  const status = await api('/api/status').catch(() => ({}));
  if (status.worker === 'down' && !sawDown) {
    sawDown = true;
    log('Dashboard reports the engine is down (banner shown).');
  }
  if (!restarted && startedAt() !== before) {
    restarted = true;
    log('Watchdog restarted Postiz.');
  }
  const current = await api(`/api/batches/${batch.id}`).catch(() => null);
  if (current?.items?.[0]?.state === 'published') {
    log('The post went out by itself after recovery.');
    break;
  }
}
assert.ok(sawDown, 'dashboard noticed the outage');
assert.ok(restarted, 'watchdog restarted Postiz');
const final = await api(`/api/batches/${batch.id}`);
assert.equal(final.items[0].state, 'published', 'queued post published after recovery');
console.log('\n✅ Watchdog test passed');
