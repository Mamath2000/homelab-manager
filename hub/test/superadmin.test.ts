import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldResetSuperadminPassword } from '../src/superadmin.js';

test('superadmin reset is enabled only by the explicit true option', () => {
  assert.equal(shouldResetSuperadminPassword('true'), true);
  assert.equal(shouldResetSuperadminPassword('false'), false);
  assert.equal(shouldResetSuperadminPassword(undefined), false);
});
