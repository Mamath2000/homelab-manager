import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, safeEqualHex, sha256, verifyPassword } from '../src/crypto.js';

test('password hashes verify only with the right password', async () => {
  const hash = await hashPassword('correct horse');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(await verifyPassword('correct horse', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('token hashes compare in constant time', () => {
  assert.equal(safeEqualHex(sha256('a'), sha256('a')), true);
  assert.equal(safeEqualHex(sha256('a'), sha256('b')), false);
  assert.equal(safeEqualHex(sha256('a'), 'abcd'), false);
});
