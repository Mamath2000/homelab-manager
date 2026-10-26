import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { alertsOf } from '../src/homeassistant/alerts.js';
import { backupStatus, evaluate } from '../src/monitoring.js';
import { ROOT_ID, build } from '../src/homeassistant/discovery.js';
import { backupState, effectiveThreshold, learnedInterval, mergeGroups, normalizeFingerprint, retentionInterval, retentionMap } from '../src/pbs.js';
import { authorize } from '../src/roles.js';
import type { HostDoc } from '../src/types.js';

// shapes of /admin/datastore/{store}/groups and /snapshots (PBS 3.x)
const groups = [
  { 'backup-type': 'host', 'backup-id': 'pve-docker01', 'last-backup': 1760050800, 'backup-count': 14, owner: 'backup@pbs!hm', files: ['etc.pxar.didx'] },
  { 'backup-type': 'host', 'backup-id': 'pgsql_nextcloud', 'last-backup': 1759964400, 'backup-count': 7, owner: 'backup@pbs!hm' },
  { 'backup-type': 'ct', 'backup-id': '105', 'last-backup': 1760047200, 'backup-count': 3, comment: 'pihole' },
];
const snapshots = [
  { 'backup-type': 'host', 'backup-id': 'pve-docker01', 'backup-time': 1759964400, size: 100, verification: { state: 'ok', upid: 'x' } },
  { 'backup-type': 'host', 'backup-id': 'pve-docker01', 'backup-time': 1760050800, size: 120 },
  { 'backup-type': 'host', 'backup-id': 'pgsql_nextcloud', 'backup-time': 1759964400, size: 5000, verification: { state: 'failed', upid: 'y' } },
];

test('groups get the size and verification of their last snapshot', () => {
  const g = mergeGroups('ds3', 'Hosts', groups, snapshots);
  assert.equal(g.length, 3);
  assert.deepEqual(
    { id: g[0]._id, last: g[0].lastBackup, size: g[0].size, verify: g[0].verify, count: g[0].count },
    { id: 'ds3/Hosts/host/pve-docker01', last: 1760050800000, size: 120, verify: null, count: 14 },
  );
  assert.equal(g[1].verify, 'failed');
  assert.equal(g[2].size, null);
  assert.equal(g[2].comment, 'pihole');
  // history of the snapshots with their verification, size and comment, oldest first
  assert.deepEqual(g[0].times, [
    { t: 1759964400000, verify: 'ok', size: 100, note: null },
    { t: 1760050800000, verify: null, size: 120, note: null },
  ]);
});

test('without group notes, the comment is the one of the last snapshot (vzdump: guest name)', () => {
  const g = mergeGroups('ds1', 'Vouille', [{ 'backup-type': 'ct', 'backup-id': '183', 'last-backup': 1760050800, 'backup-count': 2 }], [
    { 'backup-type': 'ct', 'backup-id': '183', 'backup-time': 1759964400, comment: 'old-name' },
    { 'backup-type': 'ct', 'backup-id': '183', 'backup-time': 1760050800, comment: 'grafana' },
  ]);
  assert.equal(g[0].comment, 'grafana');
  // each snapshot keeps its own comment (the guest was renamed in between)
  assert.deepEqual(g[0].times.map((s) => s.note), ['old-name', 'grafana']);
});

const H = 3600_000;
const D = 24 * H;
// history of snapshots at these dates, not verified
const snaps = (ts: number[]) => ts.map((t) => ({ t, verify: null }));

test('rhythm learned from the history: median interval, at least 4 snapshots', () => {
  const now = Date.UTC(2026, 9, 11, 2);
  // daily at 02:00 with a missed day: still daily
  const daily = [10, 9, 8, 6, 5, 4, 3, 2, 1].map((d) => now - d * D);
  assert.equal(learnedInterval(daily), D);
  assert.equal(learnedInterval([now - 3 * D, now - 2 * D, now - D]), null);
  assert.equal(learnedInterval([0, H, 2 * H, 3 * H, 4 * H]), H);
});

test('retention: finest period kept, most specific namespace first', () => {
  assert.equal(retentionInterval({ 'keep-daily': 7, 'keep-weekly': 4 }), D);
  assert.equal(retentionInterval({ 'keep-weekly': 4, 'keep-monthly': 6 }), 7 * D);
  assert.equal(retentionInterval({}), null);
  const r = retentionMap(
    [
      { store: 'ds3', ns: 'Hosts', 'keep-daily': 7 },
      { store: 'ds3', ns: 'Hosts/archives', 'keep-monthly': 12 },
      { store: 'ds3', ns: 'Old', 'keep-hourly': 24, disable: true },
    ],
    [{ name: 'ds3', 'keep-weekly': 4 }],
  );
  assert.equal(r('ds3', 'Hosts'), D);
  assert.equal(r('ds3', 'Hosts/archives'), 31 * D);
  assert.equal(r('ds3', 'Hosts/other'), D);
  assert.equal(r('ds3', ''), 7 * D);
  assert.equal(r('ds3', 'Old'), 7 * D);
  assert.equal(r('ds9', ''), null);
});

test('threshold: own one, else 1.5 x the learned rhythm, else the retention, else the default', () => {
  const daily = snaps([5, 4, 3, 2, 1].map((d) => -d * D));
  const weekly = snaps([5, 4, 3, 2, 1].map((w) => -w * 7 * D));
  const hourly = snaps([5, 4, 3, 2, 1].map((h) => -h * H));
  assert.deepEqual(effectiveThreshold({ staleHours: 50, times: daily }), { hours: 50, source: 'manual', interval: D });
  assert.deepEqual(effectiveThreshold({ times: daily }), { hours: 36, source: 'learned', interval: D });
  assert.deepEqual(effectiveThreshold({ times: weekly }), { hours: 252, source: 'learned', interval: 7 * D });
  // hourly: 2 h of margin rather than 1.5 h
  assert.equal(effectiveThreshold({ times: hourly }).hours, 3);
  assert.deepEqual(effectiveThreshold({ times: [], retention: 7 * D }), { hours: 252, source: 'retention', interval: 7 * D });
  // no rhythm known: no threshold, never late
  assert.deepEqual(effectiveThreshold({ times: [] }), { hours: null, source: 'none', interval: null });
});

test('state: late after the effective threshold, failed verification, gone', () => {
  const now = Date.UTC(2026, 9, 11, 12);
  const weekly = snaps([5, 4, 3, 2, 1].map((w) => now - 3 * D - w * 7 * D));
  // weekly group, last backup 3 days ago: not late
  assert.equal(backupState({ lastBackup: now - 3 * D, verify: null, times: weekly }, now), 'ok');
  assert.equal(backupState({ lastBackup: now - 11 * D, verify: null, times: weekly }, now), 'stale');
  // no rhythm known: never late, however old
  assert.equal(backupState({ lastBackup: now - 30 * D, verify: null }, now), 'ok');
  assert.equal(backupState({ lastBackup: now, verify: 'failed' }, now), 'failed');
  assert.equal(backupState({ lastBackup: now, verify: null, gone: true }, now), 'gone');
});

test('alerts: late and failed groups, none for a roaming host away', () => {
  const now = Date.UTC(2026, 9, 11, 12);
  const doc = (backupId: string, o: Partial<BackupDoc>) => ({ backupId, lastBackup: now, verify: null, staleHours: 24, ...o }) as BackupDoc;
  const groups = [
    doc('a', { lastBackup: now - 3 * 86_400_000 }),
    doc('b', { verify: 'failed' }),
    doc('c', {}),
    doc('d', { gone: true }),
  ];
  const msgs = (roaming: boolean) =>
    alertsOf(backupStatus({ roaming }, { online: false, groups, now })!, 'backup').map((a) => [a.level, a.message]);
  assert.deepEqual(msgs(false), [['warning', 'a : en retard'], ['critical', 'b : vérification en échec'], ['warning', 'd : disparue du PBS']]);
  assert.deepEqual(msgs(true), [['critical', 'b : vérification en échec'], ['warning', 'd : disparue du PBS']]);
});

test('Home Assistant: one backup sub-device per host, root counts and datastore space', () => {
  const host = { _id: new ObjectId(), name: 'docker', createdAt: new Date() } as HostDoc;
  const hid = host._id.toHexString();
  const late = { _id: new ObjectId(), backupId: 'docker', hostId: host._id, lastBackup: Date.UTC(2026, 9, 8), verify: null, staleHours: 24 } as BackupDoc;
  const status = evaluate(host, { online: true, groups: [late], now: Date.UTC(2026, 9, 11) });
  const { devices } = build([{ host, online: true, busy: false, status }], {
    topic: 'hm',
    discoveryPrefix: 'homeassistant',
    version: '1',
    backups: {
      groups: [
        { id: '1', backupId: 'docker', hostId: hid, state: 'stale', lastBackup: Date.UTC(2026, 9, 8) },
        // orphan: not followed, no alert anywhere
        { id: '2', backupId: 'nextcloud', hostId: null, state: 'stale', lastBackup: Date.UTC(2026, 9, 8) },
      ],
      datastores: [{ store: 'ds3', total: 1000, used: 250 }],
    },
  });
  const sub = devices.find((d) => d.id === `hm_${hid}_backup`)!;
  assert.ok(sub);
  const state = (dev: typeof sub, key: string) => dev.states.find(([t]) => t === `hm/${dev.key}/${key}/state`)?.[1];
  assert.equal(state(sub, 'late'), '1');
  assert.equal(state(sub, 'last_backup'), new Date(Date.UTC(2026, 9, 8)).toISOString());
  // the host rolls up its backup alert
  const hostDev = devices.find((d) => d.id === `hm_${hid}`)!;
  assert.match(hostDev.states.find(([t]) => t === `hm/${hostDev.key}/alerts/attributes`)![1], /docker : en retard/);
  const root = devices.find((d) => d.id === ROOT_ID)!;
  assert.equal(state(root, 'backups_late'), '1');
  assert.equal(state(root, 'datastore_ds3'), '25');
  assert.doesNotMatch(root.states.find(([t]) => t === `hm/manager/alerts/attributes`)![1], /nextcloud/);
  // without PBS: nothing about backups
  const none = build([{ host, online: true, busy: false }], { topic: 'hm', discoveryPrefix: 'homeassistant', version: '1' });
  assert.ok(!none.devices.some((d) => d.id.endsWith('_backup')));
});

test('fingerprints are normalised to upper case with colons', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(normalizeFingerprint(hex), 'AB:'.repeat(31) + 'AB');
  assert.equal(normalizeFingerprint('ab:'.repeat(31) + 'ab'), 'AB:'.repeat(31) + 'AB');
});

test('roles: settings admin only, every role reads the backups, operators refresh', () => {
  assert.ok(!authorize('operator', 'GET', '/api/settings/pbs'));
  assert.ok(authorize('viewer', 'GET', '/api/backups'));
  assert.ok(authorize('operator', 'POST', '/api/backups/refresh'));
  assert.ok(!authorize('viewer', 'POST', '/api/backups/refresh'));
  assert.ok(!authorize('operator', 'PATCH', '/api/backups/:id'));
  assert.ok(!authorize('operator', 'PUT', '/api/hosts/:id/backups'));
  assert.ok(authorize('admin', 'PUT', '/api/hosts/:id/backups'));
  assert.ok(authorize('admin', 'PATCH', '/api/backups/:id'));
});

test('retention the PBS applies to a namespace, in words', async () => {
  const { keepText, policyFor, prunePolicies } = await import('../src/pbs.js');
  // shapes of /config/prune and /config/datastore (vouille, 2026-10-11)
  const list = prunePolicies(
    [
      { store: 'ds2', ns: 'Hosts', schedule: '21:00', 'keep-daily': 10, 'keep-monthly': 3, 'keep-yearly': 2 },
      { store: 'ds2', ns: 'database', schedule: '21:00', 'keep-daily': 10, disable: true },
    ],
    [{ name: 'ds2' }, { name: 'ds9', 'keep-last': 5, 'prune-schedule': 'daily' }],
  );
  const p = policyFor(list, 'ds2', 'Hosts')!;
  assert.equal(p.schedule, '21:00');
  assert.equal(keepText(p.keep), '10 quotidiennes · 3 mensuelles · 2 annuelles');
  // disabled job: nothing; options of the datastore cover every namespace
  assert.equal(policyFor(list, 'ds2', 'database'), null);
  assert.equal(keepText(policyFor(list, 'ds9', 'Hosts')!.keep), '5 dernières');
});
