// Talks to the server's maintenance helper (scripts/maintain.sh, run every
// minute by cron) through a shared folder (/runtime in this container,
// autopost/runtime on the server):
//
//   pending.env     written here  → the helper merges it into .env and runs
//                                   `docker compose up -d` (applies new keys,
//                                   a new domain, ...)
//   update-request  written here  → the helper checks GitHub for updates now
//   apply.json      written there → result of the last apply
//   update.json     written there → installed version + last update check
//
// The dashboard never edits .env or touches Docker itself.
import fs from 'node:fs';
import path from 'node:path';
import { KEY_VALUE_PATTERN, SETUP_ENV_KEYS } from './networks.js';

export const RUNTIME_DIR = process.env.RUNTIME_DIR ? path.resolve(process.env.RUNTIME_DIR) : '';

const DOMAIN_KEYS = new Set(['DASHBOARD_DOMAIN', 'POSTIZ_DOMAIN', 'DASHBOARD_URL', 'POSTIZ_URL']);
// Must match allowed_key() in scripts/maintain.sh.
export const APPLY_ENV_KEYS = new Set([...SETUP_ENV_KEYS, ...DOMAIN_KEYS]);

export function runtimeAvailable(dir = RUNTIME_DIR) {
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function parseEnvLines(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

// Queues .env changes for the helper. Changes not yet applied are merged, so
// saving two networks within a minute applies both.
export function requestEnvChanges(changes, dir = RUNTIME_DIR) {
  if (!runtimeAvailable(dir)) throw new Error('Automatic apply is not available on this installation.');
  const entries = Object.entries(changes);
  if (entries.length === 0) throw new Error('Nothing to change.');
  for (const [key, value] of entries) {
    if (!APPLY_ENV_KEYS.has(key)) throw new Error(`Not allowed: ${key}`);
    if (typeof value !== 'string' || !KEY_VALUE_PATTERN.test(value)) throw new Error(`Invalid value for ${key}`);
  }
  const file = path.join(dir, 'pending.env');
  let existing = {};
  try {
    existing = parseEnvLines(fs.readFileSync(file, 'utf8'));
  } catch {
    // nothing pending
  }
  const merged = { ...existing, ...changes };
  const body = Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const tmp = `${file}.${process.pid}.tmp`;
  // Readable by the server's own user (this container writes as root); the
  // runtime folder itself is private (chmod 700) on the server.
  fs.writeFileSync(tmp, `${body}\n`, { mode: 0o644 });
  fs.renameSync(tmp, file);
  return { queuedAt: new Date().toISOString(), keys: Object.keys(merged) };
}

export function requestUpdateCheck(dir = RUNTIME_DIR) {
  if (!runtimeAvailable(dir)) throw new Error('Automatic updates are not set up on this installation.');
  fs.writeFileSync(path.join(dir, 'update-request'), new Date().toISOString());
}

// Everything the Settings page shows about updates and applying changes.
export function hostStatus(dir = RUNTIME_DIR, now = Date.now()) {
  if (!runtimeAvailable(dir)) return { available: false, helperActive: false, pending: false, apply: null, update: null };
  const update = readJsonFile(path.join(dir, 'update.json'));
  const apply = readJsonFile(path.join(dir, 'apply.json'));
  const pending = fs.existsSync(path.join(dir, 'pending.env')) || fs.existsSync(path.join(dir, 'applying.env'));
  const heartbeat = Date.parse(update?.heartbeatAt ?? '') || 0;
  return {
    available: true,
    // The helper runs every minute; allow a few missed runs before warning.
    helperActive: now - heartbeat < 5 * 60 * 1000,
    pending,
    apply,
    update,
  };
}
