// One password protects the dashboard. Sessions are signed cookies, so there
// is nothing to store and nothing to clean up.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DASHBOARD_PASSWORD, DASHBOARD_URL, SESSION_SECRET } from './config.js';

const COOKIE = 'autopost_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

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
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function isLoggedIn(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return false;
  const [expires, mac] = token.split('.');
  if (!expires || !mac || !safeEqual(mac, sign(expires))) return false;
  return Number(expires) > Date.now() / 1000;
}

function cookieFlags() {
  const secure = DASHBOARD_URL.startsWith('https://') ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export function sessionCookie() {
  const expires = String(Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS);
  return `${COOKIE}=${expires}.${sign(expires)}; Max-Age=${SESSION_MAX_AGE_SECONDS}; ${cookieFlags()}`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Max-Age=0; ${cookieFlags()}`;
}

export function tooManyFailures(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first > FAILURE_WINDOW_MS) return false;
  return entry.count >= MAX_FAILURES;
}

export function checkPassword(ip, password) {
  const ok =
    DASHBOARD_PASSWORD !== '' &&
    typeof password === 'string' &&
    safeEqual(sign(`pw:${password}`), sign(`pw:${DASHBOARD_PASSWORD}`));
  if (ok) {
    failures.delete(ip);
    return true;
  }
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first > FAILURE_WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
  else entry.count += 1;
  return false;
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
