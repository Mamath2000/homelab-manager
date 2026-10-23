import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_HEALTH_SETTINGS, healthMetricLevel, isContainerHealthHost, isHealthDisks, isHealthRaid, isHealthSmart, isHealthSystem, isVirtualizedHealthHost, hasNoHealthDisks, keepStandbyDisks, raidAlerts } from '../src/health.js';
import type { HostInfo } from '../src/types.js';
import { isHealthAlertSilenced } from '../src/healthSilence.js';

const now = Date.now();

test('health defaults use distinct system, volume, and SMART frequencies with short retention', () => {
  assert.deepEqual(
    [
      DEFAULT_HEALTH_SETTINGS.systemIntervalSeconds,
      DEFAULT_HEALTH_SETTINGS.diskIntervalSeconds,
      DEFAULT_HEALTH_SETTINGS.smartIntervalSeconds,
      DEFAULT_HEALTH_SETTINGS.retentionHours,
    ],
    [30, 300, 600, 48],
  );
  assert.deepEqual(
    [
      DEFAULT_HEALTH_SETTINGS.cpuWarningThreshold,
      DEFAULT_HEALTH_SETTINGS.cpuAlertThreshold,
      DEFAULT_HEALTH_SETTINGS.systemSustainedMinutes,
      DEFAULT_HEALTH_SETTINGS.smartSustainedMinutes,
    ],
    [75, 90, 5, 0],
  );
});

test('system measurements validate finite percentages, bytes, and optional Unix load', () => {
  const report = { checkedAt: now, cpuPercent: 34.5, memPercent: 61, memUsed: 610, memTotal: 1000, load1: 1, load5: 0.8, load15: 0.4 };
  assert.equal(isHealthSystem(report), true);
  assert.equal(isHealthSystem({ ...report, cpuPercent: 101 }), false);
  assert.equal(isHealthSystem({ ...report, load5: Number.NaN }), false);
  assert.equal(isHealthSystem({ ...report, checkedAt: now - 11 * 60_000 }), false);
});

test('volume reports reject invalid or virtual percentages outside the report shape', () => {
  assert.equal(isHealthDisks({ checkedAt: now, volumes: [{ device: '/dev/sda', mountpoint: '/', fstype: 'ext4', used: 80, total: 100, percent: 80 }] }), true);
  assert.equal(isHealthDisks({ checkedAt: now, volumes: [{ device: '/dev/sda', mountpoint: '/', fstype: 'ext4', used: 80, total: 100, percent: 101 }] }), false);
});

test('SMART reports validate optional measurements and bounded error text', () => {
  assert.equal(isHealthSmart({ checkedAt: now, disks: [{ device: '/dev/sda', healthy: true, temperatureC: 40, reallocated: 0 }] }), true);
  assert.equal(isHealthSmart({ checkedAt: now, disks: [{ device: '/dev/sda', temperatureC: 300 }] }), false);
});

test('health metrics distinguish warning and alert levels after their configured duration', () => {
  const now = 1_000_000;
  const samples = [
    { checkedAt: now - 120_000, value: 95 },
    { checkedAt: now - 60_000, value: 96 },
    { checkedAt: now, value: 97 },
  ];
  assert.equal(healthMetricLevel(97, samples, 75, 90, 2, 60, undefined, now), 'alert');
  assert.equal(healthMetricLevel(85, samples.map((sample) => ({ ...sample, value: 85 })), 75, 90, 2, 60, undefined, now), 'warn');
  assert.equal(healthMetricLevel(95, [{ checkedAt: now, value: 95 }], 75, 90, 2, 60, undefined, now), undefined);
  assert.equal(healthMetricLevel(95, [], 75, 90, 0, 60, undefined, now), 'alert');
  assert.equal(healthMetricLevel(87, [], 75, 90, 0, 60, 'alert', now), 'alert');
});

test('virtualized hosts are identified from agent virtualization information', () => {
  const info = (virt: string): HostInfo => ({ hostname: 'host', osId: 'linux', osName: 'Linux', kernel: '6', arch: 'amd64', uptime: 1, ips: [], virt });
  assert.equal(isVirtualizedHealthHost({ info: info('kvm') }), true);
  assert.equal(isVirtualizedHealthHost({ info: info('none') }), false);
  assert.equal(isVirtualizedHealthHost({}), false);
});

test('WSL hosts have no health disks', () => {
  const info = (virt: string): HostInfo => ({ hostname: 'host', osId: 'linux', osName: 'Linux', kernel: '6', arch: 'amd64', uptime: 1, ips: [], virt });
  assert.equal(hasNoHealthDisks({ info: info('wsl') }), true);
  assert.equal(hasNoHealthDisks({ info: info('kvm') }), false);
  assert.equal(hasNoHealthDisks({}), false);
});

test('a silenced alert is reported again when it gets worse', () => {
  const silenced = [{ key: 'disks:volume:/mnt/disk1', level: 'warn' as const }];
  assert.equal(isHealthAlertSilenced({ key: 'disks:volume:/mnt/disk1', level: 'warn' }, silenced), true);
  assert.equal(isHealthAlertSilenced({ key: 'disks:volume:/mnt/disk1', level: 'alert' }, silenced), false);
  assert.equal(isHealthAlertSilenced({ key: 'disks:volume:/mnt/disk2', level: 'warn' }, silenced), false);
  assert.equal(isHealthAlertSilenced({ key: 'disks:volume:/mnt/disk1', level: 'warn' }, undefined), false);
});

test('a disk asleep keeps its last known values', () => {
  const previous = { checkedAt: 1, disks: [{ device: '/dev/sde', model: 'WD', temperatureC: 34, healthy: true }, { device: '/dev/sdf', temperatureC: 31 }] };
  const report = { checkedAt: 2, disks: [{ device: '/dev/sde', standby: true }, { device: '/dev/sdf', temperatureC: 33 }, { device: '/dev/sdg', standby: true }] };
  const kept = keepStandbyDisks(report, previous);
  assert.deepEqual(kept.disks[0], { device: '/dev/sde', model: 'WD', temperatureC: 34, healthy: true, standby: true });
  assert.deepEqual(kept.disks[1], { device: '/dev/sdf', temperatureC: 33 });
  assert.deepEqual(kept.disks[2], { device: '/dev/sdg', standby: true });
});

const raidArray = {
  name: 'md0', level: 'raid5', state: 'clean', raidDisks: 4, degraded: 0, syncAction: 'idle', mismatchCount: 0,
  members: [{ device: 'sdb1', state: 'in_sync', slot: 0, errors: 0 }, { device: 'sdd1', state: 'in_sync', slot: 2, errors: 0 }],
};

test('RAID reports validate md arrays and their members', () => {
  assert.equal(isHealthRaid({ checkedAt: now, arrays: [raidArray] }), true);
  assert.equal(isHealthRaid({ checkedAt: now, arrays: [] }), true);
  assert.equal(isHealthRaid({ checkedAt: now, arrays: [{ ...raidArray, degraded: -1 }] }), false);
  assert.equal(isHealthRaid({ checkedAt: now, arrays: [{ ...raidArray, syncPercent: 101 }] }), false);
  assert.equal(isHealthRaid({ checkedAt: now, arrays: [{ ...raidArray, members: [{ device: 'sdb1', state: 'in_sync' }] }] }), false);
});

test('RAID alerts: degraded and failed member are alerts, rebuild and corrected errors warnings, scrub silent', () => {
  const keys = (a: object) => raidAlerts({ checkedAt: now, arrays: [{ ...raidArray, ...a }] }).map((x) => `${x.key}=${x.level}`);
  assert.deepEqual(keys({}), []);
  assert.deepEqual(keys({ syncAction: 'check', syncPercent: 40 }), []);
  assert.deepEqual(keys({ syncAction: 'check', mismatchCount: 8 }), []);
  assert.deepEqual(keys({ mismatchCount: 8 }), ['raid:md0:mismatch=warn']);
  assert.deepEqual(
    keys({ degraded: 1, syncAction: 'recover', syncPercent: 25, members: [{ device: 'sdb1', state: 'in_sync', slot: 0, errors: 0 }, { device: 'sdg1', state: 'faulty', errors: 0 }] }),
    ['raid:md0:degraded=alert', 'raid:md0:member:sdg1:faulty=alert', 'raid:md0:sync=warn'],
  );
  assert.deepEqual(keys({ state: 'inactive' }), ['raid:md0:state=alert']);
  assert.deepEqual(keys({ state: 'read-auto' }), ['raid:md0:state=warn']);
  // the count is in the key: an accepted warning comes back when the count changes
  assert.deepEqual(keys({ members: [{ device: 'sdd1', state: 'in_sync', slot: 2, errors: 8 }] }), ['raid:md0:member:sdd1:errors:8=warn']);
  assert.equal(isHealthAlertSilenced({ key: 'raid:md0:member:sdd1:errors:9', level: 'warn' }, [{ key: 'raid:md0:member:sdd1:errors:8', level: 'warn' }]), false);
});

test('RAID arrays of a container are its host\'s', () => {
  const host = (virt: string) => ({ info: { virt } as HostInfo });
  assert.equal(isContainerHealthHost(host('lxc')), true);
  assert.equal(isContainerHealthHost(host('kvm')), false);
  assert.equal(isContainerHealthHost(host('none')), false);
});
