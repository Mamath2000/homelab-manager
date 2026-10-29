import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoColor, normalizeSites, planGroupMigration } from '../src/catalog.js';
import { securityPackages } from '../src/jobs.js';

test('sites: names trimmed, empty ones dropped, ids kept or given, a name given twice refused', () => {
  const out = normalizeSites([
    { id: 'a1', name: ' Vouille ', kind: 'main', color: 'blue' },
    { name: '', kind: 'vpn' },
    { name: 'Jarsay', kind: 'vpn' },
  ])!;
  assert.deepEqual(out.map((s) => [s.name, s.kind]), [['Vouille', 'main'], ['Jarsay', 'vpn']]);
  assert.deepEqual(out.map((s) => s.color), ['blue', 'zinc']);
  // format: the one given, else the one of the kind
  assert.deepEqual(out.map((s) => s.format), ['large', 'medium']);
  assert.equal(normalizeSites([{ name: 'Freddy', kind: 'external' }])![0].format, 'small');
  assert.equal(normalizeSites([{ name: 'Freddy', kind: 'external', format: 'medium' }])![0].format, 'medium');
  assert.equal(out[0].id, 'a1');
  assert.match(out[1].id, /^[0-9a-f]{24}$/);
  assert.equal(normalizeSites([{ name: 'Jarsay', kind: 'vpn' }, { name: 'jarsay ', kind: 'external' }]), null);
});

test('groups of the first versions: one tag per name, the site of the same name', () => {
  const sites = [{ id: 's1', name: 'Vouille', kind: 'main' as const }];
  const tags = [{ id: 't1', name: 'media', color: 'blue' as const }];
  const plan = planGroupMigration(
    [
      { id: 'h1', group: 'Media' },
      { id: 'h2', group: 'vouille', tags: ['t1'] },
      { id: 'h3', group: 'vouille ', siteId: 's9' },
    ],
    sites,
    tags,
  );
  const vouille = plan.tags.find((t) => t.name === 'vouille')!;
  assert.equal(plan.tags.length, 2);
  assert.equal(vouille.color, autoColor(1));
  assert.deepEqual(plan.updates, [
    { id: 'h1', tags: ['t1'], siteId: undefined },
    { id: 'h2', tags: ['t1', vouille.id], siteId: 's1' },
    // a site already chosen is kept
    { id: 'h3', tags: [vouille.id], siteId: 's9' },
  ]);
  assert.notEqual(autoColor(0), 'zinc');
});

test('security packages of the last APT report', () => {
  const pkg = (name: string, security: boolean) => ({ name, current: '1', candidate: '2', repo: 'trixie', security });
  assert.deepEqual(securityPackages({}), []);
  assert.deepEqual(
    securityPackages({ apt: { checkedAt: 0, listsUpdatedAt: 0, upgradable: [pkg('curl', true), pkg('vim', false), pkg('libc6', true)], held: [], rebootRequired: false, rebootPkgs: [] } }),
    ['curl', 'libc6'],
  );
});
