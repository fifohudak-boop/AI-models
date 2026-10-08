// Who owns which connected social account. Members see and post to only their
// own accounts; the owner sees all of them and can move an account to someone.
//
// Accounts are connected through the network's sign-in window, so Fifofarm
// doesn't learn the new account's id directly. Instead, when someone starts
// connecting a network, we remember who it was and which accounts existed
// then; the next new account of that network that shows up is theirs.
import { db } from './db.js';
import { ownerUser } from './users.js';

const CONNECT_WINDOW_MS = 60 * 60 * 1000; // sign-in links are valid for an hour

export function recordPendingConnect(userId, provider, knownIds, now = Date.now()) {
  db.prepare(
    'INSERT INTO pending_connects (user_id, provider, known_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, provider, JSON.stringify(knownIds), now, now + CONNECT_WINDOW_MS);
}

export function ownerMap() {
  return new Map(db.prepare('SELECT account_id, user_id FROM account_owners').all().map((r) => [r.account_id, r.user_id]));
}

// Call with every fresh list of connected accounts (from Postiz). New accounts
// go to whoever most recently started connecting that network without the
// account existing yet; anything else (e.g. accounts from before team
// accounts existed) belongs to the owner.
export function claimNewAccounts(accounts, now = Date.now()) {
  const owners = ownerMap();
  const fresh = accounts.filter((a) => !owners.has(a.id));
  if (fresh.length === 0) return;
  db.prepare('DELETE FROM pending_connects WHERE expires_at < ?').run(now - 24 * 60 * 60 * 1000);
  const pending = db
    .prepare('SELECT * FROM pending_connects WHERE expires_at >= ? ORDER BY created_at DESC, id DESC')
    .all(now)
    .map((p) => ({ ...p, known: new Set(JSON.parse(p.known_ids)) }));
  const fallback = ownerUser()?.id;
  const insert = db.prepare('INSERT OR IGNORE INTO account_owners (account_id, user_id, assigned_at) VALUES (?, ?, ?)');
  for (const account of fresh) {
    const match = pending.find((p) => p.provider === account.identifier && !p.known.has(account.id));
    const userId = match?.user_id ?? fallback;
    if (userId) insert.run(account.id, userId, new Date(now).toISOString());
  }
}

export function assignAccount(accountId, userId) {
  db.prepare(
    `INSERT INTO account_owners (account_id, user_id, assigned_at) VALUES (?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET user_id = excluded.user_id, assigned_at = excluded.assigned_at`
  ).run(accountId, userId, new Date().toISOString());
}

export function forgetAccount(accountId) {
  db.prepare('DELETE FROM account_owners WHERE account_id = ?').run(accountId);
}

export function canUseAccount(user, accountId, owners = ownerMap()) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  return owners.get(accountId) === user.id;
}

// Accounts this person may see, each labelled with who owns it.
export function visibleAccounts(user, accounts) {
  const owners = ownerMap();
  const fallback = ownerUser()?.id ?? null;
  return accounts
    .map((a) => ({ ...a, ownerId: owners.get(a.id) ?? fallback }))
    .filter((a) => user.role === 'owner' || a.ownerId === user.id);
}
