// Password hashing (scrypt, built into Node). Only hashes are ever stored.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1 };

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

// Checked when an email doesn't exist, so a wrong email takes as long as a
// wrong password (nobody can find out who has an account by timing it).
const DUMMY_HASH = hashPassword('fifofarm-dummy-password');
export function burnPasswordCheck(password) {
  verifyPasswordHash(String(password || 'x'), DUMMY_HASH);
  return false;
}
