import './helpers/tempdata.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/db.js';
import { createUser, ensureOwner, removeUser } from '../server/users.js';
import {
  assignAccount,
  canUseAccount,
  claimNewAccounts,
  ownerMap,
  recordPendingConnect,
  visibleAccounts,
} from '../server/ownership.js';

const owner = ensureOwner();
const ana = createUser({ email: 'ana@example.com', name: 'Ana', password: 'ana-password' }).user;
const bo = createUser({ email: 'bo@example.com', name: 'Bo', password: 'bo-password' }).user;
const ig = (id) => ({ id, identifier: 'instagram-standalone', name: id });
const tt = (id) => ({ id, identifier: 'tiktok', name: id });
const MIN = 60_000;
const NOW = Date.parse('2026-10-08T12:00:00Z');
const pendingCount = () => db.prepare('SELECT COUNT(*) AS n FROM pending_connects').get().n;

test('accounts from before team accounts belong to the owner', () => {
  claimNewAccounts([ig('old1'), ig('old2')], NOW);
  assert.equal(ownerMap().get('old1'), owner.id);
  assert.equal(ownerMap().get('old2'), owner.id);
});

test("a new account goes to the person who started connecting that network, and uses up their connect", () => {
  recordPendingConnect(ana.id, 'tiktok', ['old1', 'old2'], NOW - 5 * MIN);
  claimNewAccounts([ig('old1'), tt('t1')], NOW);
  assert.equal(ownerMap().get('t1'), ana.id);
  assert.equal(pendingCount(), 0);
  // Without a new connect, the next TikTok account isn't hers.
  claimNewAccounts([tt('t1'), tt('t2')], NOW);
  assert.equal(ownerMap().get('t2'), owner.id);
});

test('two connects by the same person → both accounts are theirs', () => {
  recordPendingConnect(bo.id, 'tiktok', ['t1', 't2'], NOW - 3 * MIN);
  recordPendingConnect(bo.id, 'tiktok', ['t1', 't2'], NOW - 2 * MIN);
  claimNewAccounts([tt('t3')], NOW);
  claimNewAccounts([tt('t3'), tt('t4')], NOW);
  assert.equal(ownerMap().get('t3'), bo.id);
  assert.equal(ownerMap().get('t4'), bo.id);
});

test('when two people connect the same network at once, the owner gets it (and can move it)', () => {
  recordPendingConnect(ana.id, 'instagram-standalone', ['old1', 'old2'], NOW - 2 * MIN);
  recordPendingConnect(bo.id, 'instagram-standalone', ['old1', 'old2'], NOW - MIN);
  claimNewAccounts([ig('new1')], NOW);
  assert.equal(ownerMap().get('new1'), owner.id);
  db.exec('DELETE FROM pending_connects');
});

test("starting lots of connects doesn't let someone take other people's accounts", () => {
  for (let i = 0; i < 20; i += 1) recordPendingConnect(ana.id, 'youtube', [], NOW - i * 1000);
  assert.equal(pendingCount(), 5); // only the latest few are kept
  recordPendingConnect(owner.id, 'youtube', [], NOW);
  claimNewAccounts([{ id: 'y1', identifier: 'youtube', name: 'y1' }], NOW);
  assert.equal(ownerMap().get('y1'), owner.id);
  db.exec('DELETE FROM pending_connects');
});

test('a link approved after it expired still counts for a while, not forever', () => {
  recordPendingConnect(ana.id, 'youtube', [], NOW - 2 * 60 * MIN); // expired an hour ago
  claimNewAccounts([{ id: 'y2', identifier: 'youtube', name: 'y2' }], NOW);
  assert.equal(ownerMap().get('y2'), ana.id);
  recordPendingConnect(ana.id, 'youtube', [], NOW - 6 * 60 * MIN); // long gone
  claimNewAccounts([{ id: 'y3', identifier: 'youtube', name: 'y3' }], NOW);
  assert.equal(ownerMap().get('y3'), owner.id);
});

test('members see and use only their own accounts; the owner sees all with labels', () => {
  const all = [ig('old1'), tt('t1'), tt('t3')];
  assert.deepEqual(
    visibleAccounts(ana, all).map((a) => a.id),
    ['t1']
  );
  assert.deepEqual(
    visibleAccounts(owner, all).map((a) => [a.id, a.ownerId]),
    [
      ['old1', owner.id],
      ['t1', ana.id],
      ['t3', bo.id],
    ]
  );
  assert.equal(canUseAccount(ana, 't3'), false);
  assert.equal(canUseAccount(bo, 't3'), true);
  assert.equal(canUseAccount(owner, 't3'), true);
  assignAccount('t3', ana.id);
  assert.equal(canUseAccount(ana, 't3'), true);
});

test('removing someone hands their accounts to the owner', () => {
  assert.equal(removeUser(ana.id).ok, true);
  assert.equal(ownerMap().get('t1'), owner.id);
  assert.equal(ownerMap().get('t3'), owner.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_connects WHERE user_id = ?').get(ana.id).n, 0);
  assert.equal(removeUser(owner.id).error, "The owner's account can't be removed.");
});
