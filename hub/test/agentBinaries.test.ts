import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import type { HostDoc } from '../src/types.js';

// binaries of a release hub: agent 1.0.13, floor 1.0.12, signed v1 and v2
const dir = mkdtempSync(join(tmpdir(), 'hm-agent-bin-'));
process.env.AGENT_BIN_DIR = dir;
writeFileSync(join(dir, 'homelab-agent-linux-amd64'), 'agent 1.0.13');
writeFileSync(join(dir, 'VERSION'), '1.0.13\n');
writeFileSync(join(dir, 'MIN_VERSION'), '1.0.12\n');
const { agentAhead, agentBinary, agentOutdated, compareVersions } = await import('../src/agentBinaries.js');
const hash = agentBinary('amd64')!.sha256;

const host = (over: Partial<HostDoc>): HostDoc =>
  ({
    _id: new ObjectId(),
    name: 'h',
    createdAt: new Date(),
    enrolledAt: new Date(),
    certFingerprint: 'fp',
    info: { arch: 'amd64', osId: 'debian' },
    agentHash: 'other',
    ...over,
  }) as HostDoc;

test('compareVersions: numeric X.Y.Z only', () => {
  assert.equal(compareVersions('1.0.9', '1.0.10'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.12', '1.0.12'), 0);
  assert.equal(compareVersions('1.0.12-dev', '1.0.12'), null);
  assert.equal(compareVersions(undefined, '1.0.12'), null);
  assert.equal(compareVersions('', '1.0.12'), null);
});

test('binary of a release hub: signed only with both signatures, floor read next to it', () => {
  assert.equal(agentBinary('amd64')!.floor, '1.0.12');
  assert.equal(agentBinary('amd64')!.signed, false);
  writeFileSync(join(dir, 'homelab-agent-linux-amd64.sig'), 'v1');
  assert.equal(agentBinary('amd64')!.signed, false);
  writeFileSync(join(dir, 'homelab-agent-linux-amd64.sig2'), 'v2 1.0.13 x');
  assert.equal(agentBinary('amd64')!.signed, true);
});

test('agentOutdated: older agent or same version with another binary; never an agent ahead of the hub', () => {
  assert.equal(agentOutdated(host({ agentVersion: '1.0.10' })), true);
  // same version, other build (toolchain, client image): an update, accepted by the agent
  assert.equal(agentOutdated(host({ agentVersion: '1.0.13' })), true);
  assert.equal(agentOutdated(host({ agentVersion: '1.0.13', agentHash: hash })), false);
  // hub rolled back: the agent would refuse its binary
  const ahead = host({ agentVersion: '1.0.14', agentMinVersion: '1.0.12' });
  assert.equal(agentOutdated(ahead), false);
  assert.equal(agentAhead(ahead), true);
  // floor of the agent above the binary of the hub
  const floored = host({ agentVersion: '1.0.13', agentMinVersion: '1.0.14' });
  assert.equal(agentOutdated(floored), false);
  assert.equal(agentAhead(floored), true);
  // development agent: version not comparable, the hash decides as before
  assert.equal(agentOutdated(host({ agentVersion: '1.0.14-dev' })), true);
  assert.equal(agentAhead(host({ agentVersion: '1.0.14-dev' })), false);
});
