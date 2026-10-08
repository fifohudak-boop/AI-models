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
const NOW = Date.parse('2026-10-08T12:00:00Z');

test('accounts from before team accounts belong to the owner', () => {
  claimNewAccounts([ig('old1'), ig('old2')], NOW);
  assert.equal(ownerMap().get('old1'), owner.id);
  assert.equal(ownerMap().get('old2'), owner.id);
});

test('a new account goes to the person who most recently started connecting that network', () => {
  const known = ['old1', 'old2'];
  recordPendingConnect(ana.id, 'instagram-standalone', known, NOW - 10 * 60_000);
  recordPendingConnect(bo.id, 'instagram-standalone', known, NOW - 60_000);
  recordPendingConnect(ana.id, 'tiktok', known, NOW);
  claimNewAccounts([ig('old1'), ig('old2'), ig('new1'), { id: 't1', identifier: 'tiktok', name: 't1' }], NOW);
  assert.equal(ownerMap().get('new1'), bo.id);
  assert.equal(ownerMap().get('t1'), ana.id);
});

test("accounts that existed when someone started connecting aren't theirs; expired connects don't count", () => {
  recordPendingConnect(ana.id, 'youtube', ['y1'], NOW - 2 * 3600_000); // expired after an hour
  claimNewAccounts([{ id: 'y2', identifier: 'youtube', name: 'y2' }], NOW);
  assert.equal(ownerMap().get('y2'), owner.id);
});

test('members see and use only their own accounts; the owner sees all with labels', () => {
  const all = [ig('old1'), ig('new1'), { id: 't1', identifier: 'tiktok' }];
  assert.deepEqual(
    visibleAccounts(ana, all).map((a) => a.id),
    ['t1']
  );
  assert.deepEqual(
    visibleAccounts(owner, all).map((a) => [a.id, a.ownerId]),
    [
      ['old1', owner.id],
      ['new1', bo.id],
      ['t1', ana.id],
    ]
  );
  assert.equal(canUseAccount(ana, 'new1'), false);
  assert.equal(canUseAccount(bo, 'new1'), true);
  assert.equal(canUseAccount(owner, 'new1'), true);
  assignAccount('new1', ana.id);
  assert.equal(canUseAccount(ana, 'new1'), true);
});

test("removing someone hands their accounts to the owner", () => {
  assert.equal(removeUser(ana.id).ok, true);
  assert.equal(ownerMap().get('t1'), owner.id);
  assert.equal(ownerMap().get('new1'), owner.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_connects WHERE user_id = ?').get(ana.id).n, 0);
  assert.equal(removeUser(owner.id).error, "The owner's account can't be removed.");
});
