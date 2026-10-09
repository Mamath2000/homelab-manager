import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validPackages } from '../src/jobs.js';

test('package names are validated before reaching apt', () => {
  assert.equal(validPackages(['libc6', 'g++-12', 'libstdc++6:amd64']), true);
  assert.equal(validPackages(['--purge']), false);
  assert.equal(validPackages(['foo; rm -rf /']), false);
  assert.equal(validPackages(['Foo']), false);
});
