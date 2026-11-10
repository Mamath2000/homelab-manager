import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCOUNT_RE, checkName, checkPassword, generatePassword } from '../src/mqttAccounts.js';

test('account names', () => {
  for (const ok of ['esphome', 'zigbee2mqtt', 'ha.vouille', 'a-b_c@d']) assert.ok(ACCOUNT_RE.test(ok), ok);
  for (const bad of ['', 'a b', 'é', 'a/b', '#', 'x'.repeat(65)]) assert.ok(!ACCOUNT_RE.test(bad), bad);
  assert.throws(() => checkName('hlm'), /celui du hub/);
  assert.throws(() => checkName('a b'), /nom de compte/);
});

test('passwords: generated when empty, bounded when typed', () => {
  assert.ok(generatePassword().length >= 20);
  assert.notEqual(generatePassword(), generatePassword());
  assert.ok(checkPassword(undefined).length >= 20);
  assert.equal(checkPassword('longenough1'), 'longenough1');
  assert.throws(() => checkPassword('short'), /8 à 128/);
});
