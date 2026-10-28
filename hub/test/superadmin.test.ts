import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasActiveSuperadminPassword, shouldResetSuperadminPassword } from '../src/superadmin.js';

test('superadmin reset is enabled only by the explicit true option', () => {
  assert.equal(shouldResetSuperadminPassword('true'), true);
  assert.equal(shouldResetSuperadminPassword('false'), false);
  assert.equal(shouldResetSuperadminPassword(undefined), false);
});

test('a superadmin password is kept across restarts only while set and not expired', () => {
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);
  assert.equal(hasActiveSuperadminPassword({ passwordHash: 'h', passwordExpiresAt: future }), true);
  assert.equal(hasActiveSuperadminPassword({ passwordHash: 'h', passwordExpiresAt: past }), false);
  assert.equal(hasActiveSuperadminPassword({ passwordHash: null, passwordExpiresAt: future }), false);
  assert.equal(hasActiveSuperadminPassword(null), false);
});
