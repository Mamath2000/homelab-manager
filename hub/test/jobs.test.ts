import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { interruptedByRestart, validPackages } from '../src/jobs.js';

test('package names are validated before reaching apt', () => {
  assert.equal(validPackages(['libc6', 'g++-12', 'libstdc++6:amd64']), true);
  assert.equal(validPackages(['--purge']), false);
  assert.equal(validPackages(['foo; rm -rf /']), false);
  assert.equal(validPackages(['Foo']), false);
});

test('a hub restart is traced back to the hosts whose agent update or registry check it cut', () => {
  const a = new ObjectId();
  const b = new ObjectId();
  const c = new ObjectId();
  const out = interruptedByRestart([
    { action: 'agent_update', hostId: a },
    { action: 'docker_check', hostId: b },
    { action: 'apt_upgrade', hostId: c },
  ]);
  assert.deepEqual(out, { agentUpdate: [a], dockerCheck: [b] });
});
