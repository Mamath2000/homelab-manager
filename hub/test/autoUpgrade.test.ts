import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoUpgradeDrift, cleanAutoReport } from '../src/autoUpgrade.js';
import type { AptReport } from '../src/types.js';

const report = (o: Partial<AptReport> = {}): AptReport => ({ checkedAt: 1, listsUpdatedAt: 1, upgradable: [], held: [], rebootRequired: false, rebootPkgs: [], ...o });
const caps = ['apt_update', 'apt_auto'];

test('automatic security updates: drift between the choice of the host and its report', () => {
  const managed = report({ auto: { package: true, enabled: true, managed: true } });
  const none = report({ auto: { package: false, enabled: false, managed: false } });
  assert.equal(autoUpgradeDrift({ autoSecurityUpdates: true, apt: none, capabilities: caps }), true);
  assert.equal(autoUpgradeDrift({ autoSecurityUpdates: true, apt: managed, capabilities: caps }), null);
  // unchecked: the managed file is removed
  assert.equal(autoUpgradeDrift({ apt: managed, capabilities: caps }), false);
  // enabled outside Homelab Manager (distribution default): left alone
  assert.equal(autoUpgradeDrift({ apt: report({ auto: { package: true, enabled: true, managed: false } }), capabilities: caps }), null);
  // older agent, or no report about it yet
  assert.equal(autoUpgradeDrift({ autoSecurityUpdates: true, apt: none, capabilities: ['apt_update'] }), null);
  assert.equal(autoUpgradeDrift({ autoSecurityUpdates: true, apt: report(), capabilities: caps }), null);
});

test('automatic security updates: report fields kept in their form only', () => {
  const raw = report({
    auto: { package: true, enabled: 'yes', managed: true, extra: 1 } as never,
    autoInstalled: [
      { name: 'libpng16-16t64', from: '1.6.48-1+deb13u5', to: '1.6.48-1+deb13u6', at: 10 },
      { name: 'linux-image-amd64', to: '6.12.57-1', at: 11 },
      { name: 'Bad Name', to: '1', at: 12 },
      { name: 'curl', to: '8', at: 'x' },
    ] as never,
  });
  const r = cleanAutoReport(raw);
  assert.deepEqual(r.auto, { package: true, enabled: false, managed: true });
  assert.deepEqual(r.autoInstalled, [
    { name: 'libpng16-16t64', from: '1.6.48-1+deb13u5', to: '1.6.48-1+deb13u6', at: 10 },
    { name: 'linux-image-amd64', to: '6.12.57-1', at: 11 },
  ]);
  // older agents: nothing added
  const old = cleanAutoReport(report());
  assert.equal('auto' in old, false);
  assert.equal('autoInstalled' in old, false);
});
