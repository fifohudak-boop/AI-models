import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { client } from './db.js';

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const candidate = scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

export function normalizeUsername(username) {
  return username.trim().toLowerCase();
}

export async function createUser(username, password) {
  const { salt, hash } = hashPassword(password);
  const id = randomUUID();
  await client.execute({
    sql: 'INSERT INTO users (id, username, passwordHash, salt, createdAt) VALUES (?, ?, ?, ?, ?)',
    args: [id, username, hash, salt, new Date().toISOString()],
  });
  return { id, username };
}

export async function findUserByUsername(username) {
  const { rows } = await client.execute({
    sql: 'SELECT * FROM users WHERE username = ?',
    args: [username],
  });
  return rows[0] ?? null;
}

export async function verifyLogin(username, password) {
  const user = await findUserByUsername(username);
  if (!user) return null;
  if (!verifyPassword(password, user.salt, user.passwordHash)) return null;
  return { id: user.id, username: user.username };
}

export async function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  await client.execute({
    sql: 'INSERT INTO sessions (token, userId, createdAt) VALUES (?, ?, ?)',
    args: [token, userId, new Date().toISOString()],
  });
  return token;
}

export async function deleteSession(token) {
  await client.execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [token] });
}

export async function getUserBySessionToken(token) {
  if (!token) return null;
  const { rows } = await client.execute({
    sql: 'SELECT users.id as id, users.username as username FROM sessions JOIN users ON users.id = sessions.userId WHERE sessions.token = ?',
    args: [token],
  });
  return rows[0] ?? null;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function isHttps(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

export function sessionCookie(token, req) {
  const parts = [`session=${encodeURIComponent(token)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${SESSION_MAX_AGE_SECONDS}`];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(req) {
  const parts = ['session=', 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}
