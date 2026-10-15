import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSites } from '../src/routes/sites.js';
import { securityPackages } from '../src/jobs.js';

test('sites: names trimmed, empty ones dropped, a name given twice refused', () => {
  assert.deepEqual(
    normalizeSites([
      { name: ' Vouille ', kind: 'main' },
      { name: '', kind: 'vpn' },
      { name: 'Jarsay', kind: 'vpn' },
    ]),
    [
      { name: 'Vouille', kind: 'main' },
      { name: 'Jarsay', kind: 'vpn' },
    ],
  );
  assert.equal(normalizeSites([{ name: 'Jarsay', kind: 'vpn' }, { name: 'Jarsay ', kind: 'external' }]), null);
});

test('security packages of the last APT report', () => {
  const pkg = (name: string, security: boolean) => ({ name, current: '1', candidate: '2', repo: 'trixie', security });
  assert.deepEqual(securityPackages({}), []);
  assert.deepEqual(
    securityPackages({ apt: { checkedAt: 0, listsUpdatedAt: 0, upgradable: [pkg('curl', true), pkg('vim', false), pkg('libc6', true)], held: [], rebootRequired: false, rebootPkgs: [] } }),
    ['curl', 'libc6'],
  );
});
