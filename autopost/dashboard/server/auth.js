// One password protects the dashboard (shared by you and your team). Sessions
// are signed cookies, so there is nothing to store and nothing to clean up.
// Changing the password in Settings signs out every other browser.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DASHBOARD_PASSWORD, DASHBOARD_URL, SESSION_SECRET, getSettings, saveSettings } from './config.js';

// Internal cookie name, kept from the AutoPost days so nobody gets logged out.
const COOKIE = 'autopost_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1 };
export const MIN_PASSWORD_LENGTH = 8;

const failures = new Map();

function sign(value) {
  return createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    try {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      // ignore malformed cookies from other sites on the same domain
    }
  }
  return out;
}

function passwordVersion() {
  return getSettings().passwordVersion;
}

// Token: "<expires>.<passwordVersion>.<mac>". Tokens from before password
// versions existed ("<expires>.<mac>") count as version 0.
export function isLoggedIn(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return false;
  const parts = token.split('.');
  let payload;
  let version;
  if (parts.length === 2) {
    payload = parts[0];
    version = 0;
  } else if (parts.length === 3) {
    payload = `${parts[0]}.${parts[1]}`;
    version = Number(parts[1]);
  } else {
    return false;
  }
  const mac = parts[parts.length - 1];
  if (!parts[0] || !mac || !safeEqual(mac, sign(payload))) return false;
  if (version !== passwordVersion()) return false;
  return Number(parts[0]) > Date.now() / 1000;
}

function cookieFlags() {
  const secure = DASHBOARD_URL.startsWith('https://') ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export function sessionCookie() {
  const expires = String(Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS);
  const payload = `${expires}.${passwordVersion()}`;
  return `${COOKIE}=${payload}.${sign(payload)}; Max-Age=${SESSION_MAX_AGE_SECONDS}; ${cookieFlags()}`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Max-Age=0; ${cookieFlags()}`;
}

export function hashPassword(password, salt = randomBytes(16)) {
  const hash = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPasswordHash(password, stored) {
  const [alg, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function passwordMatches(password) {
  if (typeof password !== 'string' || password === '') return false;
  const { passwordHash } = getSettings();
  if (passwordHash) return verifyPasswordHash(password, passwordHash);
  return DASHBOARD_PASSWORD !== '' && safeEqual(sign(`pw:${password}`), sign(`pw:${DASHBOARD_PASSWORD}`));
}

export function tooManyFailures(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first > FAILURE_WINDOW_MS) return false;
  return entry.count >= MAX_FAILURES;
}

function recordFailure(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first > FAILURE_WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
  else entry.count += 1;
}

export function checkPassword(ip, password) {
  if (passwordMatches(password)) {
    failures.delete(ip);
    return true;
  }
  recordFailure(ip);
  return false;
}

export function changePassword(ip, current, next) {
  if (tooManyFailures(ip)) return { status: 429, error: 'Too many wrong passwords. Wait 15 minutes and try again.' };
  if (!passwordMatches(current)) {
    recordFailure(ip);
    return { status: 400, error: 'Your current password is not correct.' };
  }
  if (typeof next !== 'string' || next.length < MIN_PASSWORD_LENGTH) {
    return { status: 400, error: `The new password needs at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (next.length > 200) return { status: 400, error: 'That password is too long.' };
  saveSettings({ passwordHash: hashPassword(next), passwordVersion: passwordVersion() + 1 });
  return { ok: true };
}

export function requireLogin(req, res, next) {
  if (!isLoggedIn(req)) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

// Browsers send Origin on cross-site POSTs; refuse those so another website
// can't make your dashboard post on your behalf.
export function sameOriginOnly(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.headers.host) return next();
  } catch {
    // fall through
  }
  return res.status(403).json({ error: 'Cross-site request blocked.' });
}
