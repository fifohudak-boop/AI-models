// The people who use Fifofarm. The person who installed it is the owner (sees
// and manages everything); everyone else signs up as a member and sees only
// the social accounts they connected themselves.
import { randomUUID } from 'node:crypto';
import { db, kvGet, kvSet, tx } from './db.js';
import { DASHBOARD_PASSWORD, getSettings } from './config.js';
import { hashPassword } from './passwords.js';

export const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  };
}

export function ownerUser() {
  return db.prepare("SELECT * FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() ?? null;
}

export function getUser(id) {
  if (typeof id !== 'string' || !id) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
}

export function findUserByEmail(email) {
  if (typeof email !== 'string' || !email.trim()) return null;
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) ?? null;
}

export function listUsers() {
  return db.prepare("SELECT * FROM users ORDER BY role = 'member', created_at").all();
}

// First start after the team-accounts update (or of a fresh install): the
// person who installed Fifofarm becomes the owner and keeps the password they
// already use (and stays signed in).
export function ensureOwner() {
  const settings = getSettings();
  const existing = ownerUser();
  if (existing) {
    // A version from before team accounts ran meanwhile (e.g. an update was
    // rolled back) and the password was changed there: take that one, as long
    // as the owner hasn't changed it here since.
    const imported = Number(kvGet('owner_imported_version', '-1'));
    if (settings.passwordHash && settings.passwordVersion > imported && existing.session_version === imported) {
      db.prepare('UPDATE users SET password_hash = ?, session_version = ? WHERE id = ?').run(
        settings.passwordHash,
        settings.passwordVersion,
        existing.id
      );
      kvSet('owner_imported_version', settings.passwordVersion);
    }
    return ownerUser();
  }
  const hash = settings.passwordHash || (DASHBOARD_PASSWORD ? hashPassword(DASHBOARD_PASSWORD) : '');
  if (!hash) return null;
  db.prepare(
    `INSERT INTO users (id, email, name, role, password_hash, session_version, created_at)
     VALUES (?, NULL, 'Owner', 'owner', ?, ?, ?)`
  ).run(randomUUID(), hash, settings.passwordVersion, new Date().toISOString());
  kvSet('owner_imported_version', settings.passwordVersion);
  return ownerUser();
}

export function checkEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 200) return { error: 'Enter a valid email address.' };
  return { email };
}

export function checkName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name) return { error: 'Enter your name.' };
  if (name.length > 60) return { error: 'That name is too long (60 characters max).' };
  return { name };
}

export function checkPassword(value) {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) {
    return { error: `The password needs at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (value.length > 200) return { error: 'That password is too long.' };
  return { password: value };
}

export function createUser({ email, name, password, role = 'member' }) {
  const e = checkEmail(email);
  if (e.error) return { error: e.error };
  const n = checkName(name);
  if (n.error) return { error: n.error };
  const p = checkPassword(password);
  if (p.error) return { error: p.error };
  if (findUserByEmail(e.email)) return { error: 'There is already an account with that email. Sign in instead.' };
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, email, name, role, password_hash, session_version, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  ).run(id, e.email, n.name, role, hashPassword(p.password), new Date().toISOString());
  return { user: getUser(id) };
}

export function updateProfile(id, { name, email }) {
  const user = getUser(id);
  if (!user) return { error: 'Account not found.' };
  const changes = {};
  if (name !== undefined) {
    const n = checkName(name);
    if (n.error) return { error: n.error };
    changes.name = n.name;
  }
  if (email !== undefined) {
    const e = checkEmail(email);
    if (e.error) return { error: e.error };
    const other = findUserByEmail(e.email);
    if (other && other.id !== id) return { error: 'Someone else already uses that email.' };
    changes.email = e.email;
  }
  db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(
    changes.name ?? user.name,
    changes.email ?? user.email,
    id
  );
  return { user: getUser(id) };
}

// Also signs that person out everywhere else.
export function setPassword(id, password) {
  const p = checkPassword(password);
  if (p.error) return { error: p.error };
  db.prepare('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?').run(
    hashPassword(p.password),
    id
  );
  return { user: getUser(id) };
}

export function touchLogin(id) {
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

// Their connected accounts move to the owner, so nothing is lost or orphaned.
export function removeUser(id) {
  const user = getUser(id);
  const owner = ownerUser();
  if (!user) return { error: 'Account not found.' };
  if (user.role === 'owner') return { error: "The owner's account can't be removed." };
  tx(() => {
    db.prepare('UPDATE account_owners SET user_id = ? WHERE user_id = ?').run(owner.id, id);
    db.prepare('DELETE FROM pending_connects WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
  return { ok: true };
}

export function signupsOpen() {
  return kvGet('signups_open', '1') === '1';
}

export function setSignupsOpen(open) {
  kvSet('signups_open', open ? '1' : '0');
}
