import assert from 'node:assert/strict';
import { test } from 'node:test';
import { passwordProblem } from '../src/passwordPolicy.js';

const list = () => new Set(['iloveyou1234', 'motdepasse123']);

test('a new password has 12 characters at least, counted as characters', () => {
  assert.equal(passwordProblem('short-pw', 'alice', list), 'password too short');
  assert.equal(passwordProblem('abcdefghijk', 'alice', list), 'password too short');
  // 12 characters, 24 UTF-16 units
  assert.equal(passwordProblem('🔑'.repeat(11), 'alice', list), 'password too short');
  assert.equal(passwordProblem('🔑'.repeat(12), 'alice', list), null);
  assert.equal(passwordProblem('correct horse battery', 'alice', list), null);
});

test('leaked passwords and the name of the account are refused, whatever the case', () => {
  assert.equal(passwordProblem('ILoveYou1234', 'alice', list), 'password too common');
  assert.equal(passwordProblem('MotDePasse123', 'alice', list), 'password too common');
  assert.equal(passwordProblem('Administrator', 'administrator', list), 'password same as username');
});

test('the shipped list loads and holds leaked passwords of 12 characters or more', () => {
  assert.equal(passwordProblem('qwertyuiop123', 'alice'), 'password too common');
  assert.equal(passwordProblem('Zr7#plume-de-hibou', 'alice'), null);
});
