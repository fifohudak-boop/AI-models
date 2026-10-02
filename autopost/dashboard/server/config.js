import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_PREFERENCES } from './platforms.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
export const UPLOAD_TMP_DIR = path.join(DATA_DIR, 'tmp');
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });

export const PORT = Number(process.env.PORT) || 3000;
export const POSTIZ_INTERNAL_URL = (process.env.POSTIZ_INTERNAL_URL || 'http://localhost:4007').replace(/\/+$/, '');
export const POSTIZ_PUBLIC_URL = (process.env.POSTIZ_PUBLIC_URL || process.env.POSTIZ_URL || POSTIZ_INTERNAL_URL).replace(
  /\/+$/,
  ''
);
export const DASHBOARD_URL = (process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
export const TEMPORAL_HTTP_URL = (process.env.TEMPORAL_HTTP_URL || '').replace(/\/+$/, '');
export const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';

// Writes go to a temp file first, then rename, so a crash never leaves a
// half-written JSON file behind.
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function loadSecret() {
  if (process.env.DASHBOARD_SECRET) return process.env.DASHBOARD_SECRET;
  const file = path.join(DATA_DIR, 'session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = randomBytes(32).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}
export const SESSION_SECRET = loadSecret();

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export function getSettings() {
  const stored = readJson(SETTINGS_FILE, {});
  return {
    postizApiKey: stored.postizApiKey || '',
    preferences: { ...DEFAULT_PREFERENCES, ...(stored.preferences || {}) },
  };
}

export function saveSettings(patch) {
  const current = readJson(SETTINGS_FILE, {});
  const next = { ...current, ...patch };
  if (patch.preferences) next.preferences = { ...(current.preferences || {}), ...patch.preferences };
  writeJsonAtomic(SETTINGS_FILE, next);
  return getSettings();
}

// A key in .env always wins over one saved from the setup screen.
export function getApiKey() {
  return (process.env.POSTIZ_API_KEY || '').trim() || getSettings().postizApiKey;
}

export function apiKeyFromEnv() {
  return !!(process.env.POSTIZ_API_KEY || '').trim();
}
