import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_HEALTH_SETTINGS, healthMetricLevel, isContainerHealthHost, isHealthDisks, isHealthRaid, isHealthSmart, isHealthSystem, isVirtualizedHealthHost, hasNoHealthDisks, keepStandbyDisks, raidAlerts, unraidAlerts, cephAlerts, applySilence, isCephClusterKey, nextRearm, reportAlerts, resolveHealthSettings, thresholdsInvalid } from '../src/health.js';
import type { HealthSettings, HostDoc, HostInfo } from '../src/types.js';
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
  assert.equal(isHealthSystem({ ...report, cpuCount: 1.5 }), true);
  assert.equal(isHealthSystem({ ...report, cpuCount: 0 }), false);
  assert.equal(isHealthSystem({ ...report, cpuCount: Number.NaN }), false);
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
  assert.equal(healthMetricLevel(97, samples, 75, 90, 2, 60, now), 'alert');
  assert.equal(healthMetricLevel(85, samples.map((sample) => ({ ...sample, value: 85 })), 75, 90, 2, 60, now), 'warn');
  assert.equal(healthMetricLevel(95, [{ checkedAt: now, value: 95 }], 75, 90, 2, 60, now), undefined);
  assert.equal(healthMetricLevel(95, [], 75, 90, 0, 60, now), 'alert');
  assert.equal(healthMetricLevel(87, [], 75, 90, 0, 60, now), 'warn');
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

const unraid = {
  state: 'STARTED', lastCheck: { startedAt: 1792720727000, finishedAt: 1792761028000, errors: 0, exit: 0 },
  disks: [{ name: 'parity', type: 'Parity', device: 'sdg', status: 'DISK_OK', errors: 0 }, { name: 'disk1', type: 'Data', device: 'sdc', status: 'DISK_OK', errors: 0 }],
  pools: [{ name: 'speed', fsType: 'btrfs', profile: 'raid1', devices: 2, devicesExpected: 2, disks: [
    { name: 'speed', type: 'Cache', device: 'nvme0n1', status: 'DISK_OK', errors: 0, fsErrors: 0 },
    { name: 'speed2', type: 'Cache', device: 'nvme1n1', status: 'DISK_OK', errors: 0, fsErrors: 0 },
  ] }],
};

const ceph = {
  fsid: 'f1', status: 'HEALTH_OK', checks: [], osdsTotal: 3, osdsUp: 3, osdsIn: 3, pgs: 33, pgsClean: 33, usedBytes: 1, totalBytes: 2,
  osds: [{ id: 2, name: 'osd.2', up: true, in: true }],
};

test('RAID reports carry an Unraid array and a Ceph cluster', () => {
  assert.equal(isHealthRaid({ checkedAt: now, arrays: [], unraid, ceph }), true);
  assert.equal(isHealthRaid({ checkedAt: now, arrays: [], ceph: { ...ceph, fsid: undefined, status: undefined, error: 'timeout' } }), true);
  assert.equal(isHealthRaid({ checkedAt: now, arrays: [], unraid: { ...unraid, disks: [{ name: 'disk1', status: 'DISK_OK' }] } }), false);
  assert.equal(isHealthRaid({ checkedAt: now, arrays: [], ceph: { ...ceph, checks: [{ code: 'X', severity: 'HEALTH_WARN', message: 'm', detail: [] }] } }), false);
});

test('Unraid alerts: disabled disk, missing pool device and parity errors alert, rebuild and errors warn, check silent', () => {
  const keys = (u: object) => unraidAlerts({ ...unraid, ...u }).map((x) => `${x.key}=${x.level}`);
  assert.deepEqual(keys({}), []);
  assert.deepEqual(keys({ syncAction: 'check P', syncPercent: 40 }), []);
  assert.deepEqual(keys({ state: 'STOPPED' }), ['raid:unraid:state=alert']);
  assert.deepEqual(
    keys({ disks: [{ name: 'disk1', type: 'Data', status: 'DISK_DSBL', errors: 12 }], syncAction: 'recon D1', syncPercent: 10 }),
    ['raid:unraid:disk:disk1:status=alert', 'raid:unraid:disk:disk1:errors:12=warn', 'raid:unraid:sync=warn'],
  );
  assert.deepEqual(
    keys({ pools: [{ ...unraid.pools[0], devices: 1, disks: [{ ...unraid.pools[0].disks[0], fsErrors: 3 }] }] }),
    ['raid:unraid:pool:speed:missing=alert', 'raid:unraid:disk:speed:fserrors:3=warn'],
  );
  assert.deepEqual(keys({ lastCheck: { ...unraid.lastCheck, errors: 5 } }), ['raid:unraid:lastcheck:1792720727000:errors=alert']);
  assert.deepEqual(keys({ lastCheck: { ...unraid.lastCheck, exit: -4 } }), ['raid:unraid:lastcheck:1792720727000:exit=warn']);
});

test('Ceph alerts: checks by severity (muted ones left out), OSDs of the node, no answer', () => {
  const keys = (c: object) => cephAlerts({ ...ceph, ...c }).map((x) => `${x.key}=${x.level}`);
  assert.deepEqual(keys({}), []);
  assert.deepEqual(keys({ status: 'HEALTH_WARN', checks: [
    { code: 'BLUESTORE_SLOW_OP_ALERT', severity: 'HEALTH_WARN', message: '2 OSD(s)', detail: ['osd.2', 'osd.3'], muted: false },
    { code: 'PG_DEGRADED', severity: 'HEALTH_ERR', message: 'pgs', detail: [], muted: false },
    { code: 'MON_CLOCK_SKEW', severity: 'HEALTH_WARN', message: 'skew', detail: [], muted: true },
  ] }), ['raid:ceph:check:BLUESTORE_SLOW_OP_ALERT=warn', 'raid:ceph:check:PG_DEGRADED=alert']);
  assert.deepEqual(keys({ osds: [{ id: 2, name: 'osd.2', up: false, in: true }, { id: 3, name: 'osd.3', up: true, in: false }] }), ['raid:ceph:osd.2:down=alert', 'raid:ceph:osd.3:out=warn']);
  assert.deepEqual(keys({ error: 'timeout' }), ['raid:ceph:unreachable=alert']);
  assert.equal(isCephClusterKey('raid:ceph:check:PG_DEGRADED'), true);
  assert.equal(isCephClusterKey('raid:ceph:unreachable'), true);
  assert.equal(isCephClusterKey('raid:ceph:osd.2:down'), false);
});

test('a shared acceptance only covers the active alerts of each node', () => {
  const alerts = [{ key: 'raid:ceph:check:A', label: 'Ceph', level: 'warn' as const, reason: '' }];
  const kept = [{ key: 'volume:/', level: 'warn' as const }];
  assert.deepEqual(applySilence(kept, alerts, ['raid:ceph:check:A', 'raid:ceph:check:B'], true), [...kept, { key: 'raid:ceph:check:A', level: 'warn' }]);
  assert.deepEqual(applySilence([...kept, { key: 'raid:ceph:check:A', level: 'warn' }], alerts, ['raid:ceph:check:A'], false), kept);
});

test('health alerts have no hysteresis: a level is lifted as soon as the value is back under its threshold', () => {
  assert.equal(healthMetricLevel(1.19, [], 0.95, 1.2, 0, 60, 1_000_000), 'warn');
  assert.equal(healthMetricLevel(0.94, [], 0.95, 1.2, 0, 60, 1_000_000), undefined);
  assert.equal(healthMetricLevel(79.9, [], 80, 90, 0, 30, 1_000_000), undefined);
});

test('a lifted volume alert is not raised again during the rearm delay, except when it gets worse', () => {
  const total = 4 * 1024 ** 4;
  const t0 = Date.now();
  const report = (percent: number, checkedAt: number) => ({
    checkedAt,
    volumes: [{ device: '/dev/sda1', mountpoint: '/data', fstype: 'ext4', total, used: total * percent / 100, percent }],
  });
  const settings = resolveHealthSettings({ ...DEFAULT_HEALTH_SETTINGS, diskRearmMinutes: 60 });
  const key = 'disks:volume:/data';
  const host = (alerts: { key: string; label: string; level: 'warn' | 'alert'; reason: string }[], rearm?: { key: string; level: 'warn' | 'alert'; at: number }[]) => ({ health: { alerts, rearm } }) as HostDoc;
  const active = (level: 'warn' | 'alert') => [{ key, label: '/data', level, reason: '' }];

  // lifted right away, with no margin under the threshold
  assert.equal(reportAlerts(host(active('warn')), 'disks', report(74.9, t0), settings).length, 0);
  assert.deepEqual(nextRearm(undefined, active('warn'), [], 60, t0), [{ key, level: 'warn', at: t0 }]);

  // within the delay: same level silenced, higher level raised
  const rearm = [{ key, level: 'warn' as const, at: t0 }];
  assert.equal(reportAlerts(host([], rearm), 'disks', report(76, t0 + 10 * 60_000), settings).length, 0);
  assert.equal(reportAlerts(host([], rearm), 'disks', report(91, t0 + 10 * 60_000), settings)[0]?.level, 'alert');
  // an alert lifted from the alert level also silences the warning level
  assert.equal(reportAlerts(host([], [{ key, level: 'alert', at: t0 }]), 'disks', report(80, t0 + 10 * 60_000), settings).length, 0);
  // after the delay, or without any record: raised normally
  assert.equal(reportAlerts(host([], rearm), 'disks', report(76, t0 + 61 * 60_000), settings)[0]?.level, 'warn');
  assert.equal(reportAlerts(host([]), 'disks', report(76, t0), settings)[0]?.level, 'warn');
  // an alert still active is never delayed
  assert.equal(reportAlerts(host(active('warn'), rearm), 'disks', report(76, t0 + 10 * 60_000), settings)[0]?.level, 'warn');
  // 0 disables the delay
  assert.equal(reportAlerts(host([], rearm), 'disks', report(76, t0 + 60_000), { ...settings, diskRearmMinutes: 0 })[0]?.level, 'warn');

  // records: kept while silenced, dropped when raised again or expired
  assert.deepEqual(nextRearm(rearm, [], [], 60, t0 + 10 * 60_000), rearm);
  assert.deepEqual(nextRearm(rearm, [], active('warn'), 60, t0 + 10 * 60_000), []);
  assert.deepEqual(nextRearm(rearm, [], [], 60, t0 + 61 * 60_000), []);
  assert.deepEqual(nextRearm(rearm, active('warn'), [], 0, t0), []);
});

test('load alerts compare load5 to the CPU count, and skip containers and agents without cpuCount', () => {
  const host = (virt: string): HostDoc => ({ info: { hostname: 'h', osId: 'linux', osName: 'Linux', kernel: '6', arch: 'amd64', uptime: 1, ips: [], virt } }) as HostDoc;
  const settings: HealthSettings = { ...DEFAULT_HEALTH_SETTINGS, loadSustainedMinutes: 0 };
  const report = { checkedAt: Date.now(), cpuPercent: 10, memPercent: 10, memUsed: 1, memTotal: 10, load1: 5, load5: 4, load15: 3, cpuCount: 4 };
  const load = (h: HostDoc, r: typeof report | Omit<typeof report, 'cpuCount'>) => reportAlerts(h, 'system', r, settings).find((a) => a.key === 'system:load');
  assert.equal(load(host('none'), report)?.level, 'warn');
  assert.equal(load(host('none'), { ...report, load5: 5 })?.level, 'alert');
  assert.equal(load(host('none'), { ...report, load5: 3 }), undefined);
  assert.equal(load(host('lxc'), report), undefined);
  const { cpuCount: _cpuCount, ...old } = report;
  assert.equal(load(host('none'), old), undefined);
});

test('resolveHealthSettings merges the overrides field by field and enables every indicator by default', () => {
  const effective = resolveHealthSettings(DEFAULT_HEALTH_SETTINGS, { cpuAlertThreshold: 95, memoryEnabled: false });
  assert.equal(effective.cpuAlertThreshold, 95);
  assert.equal(effective.cpuWarningThreshold, DEFAULT_HEALTH_SETTINGS.cpuWarningThreshold);
  assert.equal(effective.memoryEnabled, false);
  assert.equal(effective.cpuEnabled, true);
  assert.equal(resolveHealthSettings(DEFAULT_HEALTH_SETTINGS).diskEnabled, true);
});

test('thresholdsInvalid checks warning < alert on the effective values', () => {
  assert.equal(thresholdsInvalid(DEFAULT_HEALTH_SETTINGS), false);
  // alert lowered under the inherited warning (75)
  assert.equal(thresholdsInvalid(resolveHealthSettings(DEFAULT_HEALTH_SETTINGS, { cpuAlertThreshold: 60 })), true);
  assert.equal(thresholdsInvalid(resolveHealthSettings(DEFAULT_HEALTH_SETTINGS, { cpuWarningThreshold: 50, cpuAlertThreshold: 60 })), false);
});

test('a disabled indicator raises no alert, the others still do', () => {
  const host = { info: { hostname: 'h', osId: 'linux', osName: 'Linux', kernel: '6', arch: 'amd64', uptime: 1, ips: [], virt: 'none' } } as HostDoc;
  const system = { checkedAt: Date.now(), cpuPercent: 99, memPercent: 99, memUsed: 1, memTotal: 10, load1: 9, load5: 9, load15: 9, cpuCount: 4 };
  const base = { ...DEFAULT_HEALTH_SETTINGS, systemSustainedMinutes: 0, loadSustainedMinutes: 0 };
  const keys = (o: Parameters<typeof resolveHealthSettings>[1]) => reportAlerts(host, 'system', system, resolveHealthSettings(base, o)).map((a) => a.key).sort();
  assert.deepEqual(keys({}), ['system:cpu', 'system:load', 'system:memory']);
  assert.deepEqual(keys({ cpuEnabled: false, loadEnabled: false }), ['system:memory']);

  const disks = { checkedAt: Date.now(), volumes: [{ device: '/dev/sda1', mountpoint: '/', fstype: 'ext4', total: 10, used: 10, percent: 99 }] };
  assert.equal(reportAlerts(host, 'disks', disks, resolveHealthSettings(base)).length, 1);
  assert.equal(reportAlerts(host, 'disks', disks, resolveHealthSettings(base, { diskEnabled: false })).length, 0);

  const smart = { checkedAt: Date.now(), disks: [{ device: '/dev/nvme0', temperatureC: 90, nvmeWearPercent: 99 }] };
  const smartKeys = (o: Parameters<typeof resolveHealthSettings>[1]) => reportAlerts(host, 'smart', smart as never, resolveHealthSettings(base, o)).map((a) => a.key).sort();
  assert.equal(smartKeys({}).length, 2);
  assert.deepEqual(smartKeys({ smartWearEnabled: false }), ['smart:smart:/dev/nvme0:temperature']);
});
