// Sign-in for the owner and the team. Sessions are signed cookies that name
// the person and their "session version": changing a password bumps the
// version, which signs that person out of every other browser.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DASHBOARD_URL, SESSION_SECRET } from './config.js';
import { burnPasswordCheck, verifyPasswordHash } from './passwords.js';
import {
  createUser,
  findUserByEmail,
  getUser,
  ownerUser,
  setPassword,
  signupsOpen,
  touchLogin,
} from './users.js';

// Internal cookie name, kept from the AutoPost days so nobody gets logged out.
const COOKIE = 'autopost_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_SIGNUP_ATTEMPTS_PER_HOUR = 10;
const TOO_MANY = 'Too many wrong passwords. Wait 15 minutes and try again.';

const failures = new Map();
const signups = new Map();

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

// Token: "u.<userId>.<expires>.<sessionVersion>.<mac>". Tokens from before
// team accounts ("<expires>.<mac>" or "<expires>.<version>.<mac>") belong to
// the owner, so the owner stays signed in through the update.
export function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const parts = token.split('.');
  const now = Date.now() / 1000;
  if (parts[0] === 'u') {
    if (parts.length !== 5) return null;
    const [, id, expires, version, mac] = parts;
    if (!mac || !safeEqual(mac, sign(`u.${id}.${expires}.${version}`))) return null;
    if (!(Number(expires) > now)) return null;
    const user = getUser(id);
    return user && user.session_version === Number(version) ? user : null;
  }
  let payload;
  let version;
  if (parts.length === 2) {
    payload = parts[0];
    version = 0;
  } else if (parts.length === 3) {
    payload = `${parts[0]}.${parts[1]}`;
    version = Number(parts[1]);
  } else {
    return null;
  }
  const mac = parts[parts.length - 1];
  if (!parts[0] || !mac || !safeEqual(mac, sign(payload))) return null;
  if (!(Number(parts[0]) > now)) return null;
  const owner = ownerUser();
  return owner && owner.session_version === version ? owner : null;
}

function cookieFlags() {
  const secure = DASHBOARD_URL.startsWith('https://') ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export function sessionCookie(user) {
  const expires = String(Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS);
  const payload = `u.${user.id}.${expires}.${user.session_version}`;
  return `${COOKIE}=${payload}.${sign(payload)}; Max-Age=${SESSION_MAX_AGE_SECONDS}; ${cookieFlags()}`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Max-Age=0; ${cookieFlags()}`;
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

// The owner may sign in with just the password until they've added an email.
export function ownerNeedsEmail() {
  const owner = ownerUser();
  return !!owner && !owner.email;
}

export function login(ip, email, password) {
  if (tooManyFailures(ip)) return { status: 429, error: TOO_MANY };
  const typed = typeof email === 'string' ? email.trim() : '';
  const user = typed ? findUserByEmail(typed) : ownerNeedsEmail() ? ownerUser() : null;
  const pw = typeof password === 'string' ? password : '';
  const ok = user && pw !== '' ? verifyPasswordHash(pw, user.password_hash) : burnPasswordCheck(pw);
  if (!ok) {
    recordFailure(ip);
    if (!typed && !ownerNeedsEmail()) return { status: 400, error: 'Enter your email and password.' };
    return { status: 401, error: typed ? 'Wrong email or password.' : 'Wrong password.' };
  }
  failures.delete(ip);
  touchLogin(user.id);
  return { user: getUser(user.id) };
}

// Every attempt counts toward the hourly limit (so nobody can test which
// emails already have an account, or fill the team with fake people).
export function signup(ip, { name, email, password }) {
  if (!signupsOpen()) return { status: 403, error: 'Sign-up is closed. Ask the owner of this Fifofarm to open it.' };
  const entry = signups.get(ip);
  const recent = entry && Date.now() - entry.first < 60 * 60 * 1000 ? entry : null;
  if (recent && recent.count >= MAX_SIGNUP_ATTEMPTS_PER_HOUR) {
    return { status: 429, error: 'Too many sign-up attempts from here. Try again in an hour.' };
  }
  if (recent) recent.count += 1;
  else signups.set(ip, { first: Date.now(), count: 1 });
  const result = createUser({ name, email, password, role: 'member' });
  if (result.error) return { status: 400, error: result.error };
  touchLogin(result.user.id);
  return { user: getUser(result.user.id) };
}

export function changePassword(ip, user, current, next) {
  if (tooManyFailures(ip)) return { status: 429, error: TOO_MANY };
  if (typeof current !== 'string' || !current || !verifyPasswordHash(current, user.password_hash)) {
    recordFailure(ip);
    return { status: 400, error: 'Your current password is not correct.' };
  }
  const result = setPassword(user.id, next);
  if (result.error) return { status: 400, error: result.error };
  return { user: result.user };
}

export function requireLogin(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  req.user = user;
  next();
}

export function requireOwner(req, res, next) {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Only the owner of this Fifofarm can do that.' });
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
