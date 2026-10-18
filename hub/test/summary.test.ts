import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { dayOf, systemStatus } from '../src/monitoring.js';
import { summarize } from '../src/summary.js';
import type { AptReport, HostDoc } from '../src/types.js';

const apt = (over: Partial<AptReport>): AptReport =>
  ({ upgradable: [], held: [], rebootRequired: false, autoremovable: [], listsUpdatedAt: Date.now(), ...over }) as AptReport;
const host = (name: string, over: Partial<HostDoc> = {}): HostDoc =>
  ({ _id: new ObjectId(), name, createdAt: new Date(), enrolledAt: new Date(), ...over }) as HostDoc;

test('counts hosts, updates and reboots; hosts excluded from HA are left out', () => {
  const s = summarize([
    host('a', { apt: apt({ upgradable: [{ name: 'libc6', security: true }, { name: 'vim', security: false }] as never, rebootRequired: true }) }),
    host('b', { apt: apt({}) }),
    host('c', { haExcluded: true, apt: apt({ upgradable: [{ name: 'x', security: true }] as never }) }),
  ]);
  assert.equal(s.hosts, 2);
  assert.equal(s.updates, 2);
  assert.equal(s.security, 1);
  assert.equal(s.hostsToUpdate, 1);
  assert.equal(s.hostsToReboot, 1);
});

test('offline hosts raise a warning by default, a critical alert when flagged, and no alert when roaming', () => {
  const offline = host('down');
  const critical = host('critical-down', { critical: true });
  const roaming = host('laptop', { roaming: true });
  const s = summarize([offline, critical, roaming]);
  assert.equal(s.hostsOffline, 2);
  assert.equal(s.critical, 1);
  assert.equal(s.alerts, 2);
  assert.deepEqual(dayOf(systemStatus(offline, { online: false })), { level: 'warn', reasons: ['Agent hors ligne'] });
  assert.deepEqual(dayOf(systemStatus(critical, { online: false })), { level: 'alert', reasons: ['Agent hors ligne'] });
  // roaming and away: not an alert, not known either
  assert.equal(dayOf(systemStatus(roaming, { online: false })), null);
});
