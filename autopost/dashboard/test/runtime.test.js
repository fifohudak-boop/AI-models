import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APPLY_ENV_KEYS, hostStatus, requestEnvChanges, requestUpdateCheck } from '../server/runtime.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fifofarm-runtime-'));
}

test('requestEnvChanges writes pending.env and merges unapplied changes', () => {
  const dir = tempDir();
  requestEnvChanges({ INSTAGRAM_APP_ID: '123' }, dir);
  requestEnvChanges({ INSTAGRAM_APP_SECRET: 'abc', INSTAGRAM_APP_ID: '456' }, dir);
  const text = fs.readFileSync(path.join(dir, 'pending.env'), 'utf8');
  assert.equal(text, 'INSTAGRAM_APP_ID=456\nINSTAGRAM_APP_SECRET=abc\n');
});

test('requestEnvChanges refuses keys outside the allow-list and bad values', () => {
  const dir = tempDir();
  assert.throws(() => requestEnvChanges({ JWT_SECRET: 'x' }, dir), /Not allowed/);
  assert.throws(() => requestEnvChanges({ DASHBOARD_PASSWORD: 'x' }, dir), /Not allowed/);
  assert.throws(() => requestEnvChanges({ X_API_KEY: 'a\nJWT_SECRET=x' }, dir), /Invalid/);
  assert.throws(() => requestEnvChanges({ X_API_KEY: 'a b' }, dir), /Invalid/);
  assert.ok(!fs.existsSync(path.join(dir, 'pending.env')));
});

test('requestEnvChanges needs the runtime folder', () => {
  assert.throws(() => requestEnvChanges({ X_API_KEY: 'a' }, ''), /not available/);
  assert.throws(() => requestEnvChanges({ X_API_KEY: 'a' }, '/nonexistent/fifofarm'), /not available/);
});

test('allow-list matches scripts/maintain.sh', () => {
  const script = fs.readFileSync(new URL('../../scripts/maintain.sh', import.meta.url), 'utf8');
  const block = script.slice(script.indexOf('allowed_key() {'), script.indexOf('return 1', script.indexOf('allowed_key() {')));
  const shellKeys = new Set(block.match(/[A-Z][A-Z0-9_]+/g).filter((k) => k.includes('_')));
  const dir = tempDir();
  for (const key of shellKeys) assert.doesNotThrow(() => requestEnvChanges({ [key]: 'v1' }, dir), key);
  // and nothing the dashboard may send is missing from the script
  for (const key of APPLY_ENV_KEYS) assert.ok(shellKeys.has(key), `maintain.sh does not allow ${key}`);
});

test('hostStatus reports the helper heartbeat, pending changes and update state', () => {
  const dir = tempDir();
  assert.equal(hostStatus(dir).helperActive, false);
  const now = Date.parse('2026-10-03T12:00:00Z');
  fs.writeFileSync(
    path.join(dir, 'update.json'),
    JSON.stringify({ state: 'ok', commit: 'abc1234', heartbeatAt: '2026-10-03T11:58:30Z', autoUpdate: true })
  );
  fs.writeFileSync(path.join(dir, 'pending.env'), 'X_API_KEY=a\n');
  const status = hostStatus(dir, now);
  assert.equal(status.available, true);
  assert.equal(status.helperActive, true);
  assert.equal(status.pending, true);
  assert.equal(status.update.commit, 'abc1234');
  assert.equal(hostStatus(dir, now + 10 * 60 * 1000).helperActive, false);
  assert.equal(hostStatus('').available, false);
});

test('requestUpdateCheck drops a request file', () => {
  const dir = tempDir();
  requestUpdateCheck(dir);
  assert.ok(fs.existsSync(path.join(dir, 'update-request')));
});
