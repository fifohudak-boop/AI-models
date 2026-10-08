import './helpers/tempdata.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveSettings } from '../server/config.js';
import { hashPassword, verifyPasswordHash } from '../server/passwords.js';
import { checkEmail, createUser, ensureOwner, ownerUser, setPassword } from '../server/users.js';

test('the owner keeps the password they already had (from DASHBOARD_PASSWORD)', () => {
  const owner = ensureOwner();
  assert.equal(owner.role, 'owner');
  assert.equal(owner.email, null);
  assert.ok(verifyPasswordHash('unit-test-password', owner.password_hash));
  assert.equal(ensureOwner().id, owner.id); // only once
});

test('a password changed in an older version (e.g. after a rolled-back update) is picked up', () => {
  saveSettings({ passwordHash: hashPassword('changed-in-old-version'), passwordVersion: 3 });
  const owner = ensureOwner();
  assert.ok(verifyPasswordHash('changed-in-old-version', owner.password_hash));
  assert.equal(owner.session_version, 3); // browsers signed in there stay signed in
  // Once the owner changes it here, the old settings no longer win.
  setPassword(owner.id, 'changed-here-123');
  saveSettings({ passwordHash: hashPassword('older-again'), passwordVersion: 4 });
  assert.ok(verifyPasswordHash('changed-here-123', ensureOwner().password_hash));
});

test('sign-up details are checked', () => {
  assert.ok(checkEmail('not an email').error);
  assert.equal(checkEmail(' Ana@Example.COM ').email, 'ana@example.com');
  assert.ok(createUser({ email: 'a@b.co', name: '', password: 'long-enough' }).error);
  assert.ok(createUser({ email: 'a@b.co', name: 'A', password: 'short' }).error);
  const ok = createUser({ email: 'a@b.co', name: '  Ana   Maria ', password: 'long-enough' });
  assert.equal(ok.user.name, 'Ana Maria');
  assert.equal(ok.user.role, 'member');
  assert.ok(createUser({ email: 'A@B.CO', name: 'Copy', password: 'long-enough' }).error);
  assert.equal(ownerUser().role, 'owner');
});
