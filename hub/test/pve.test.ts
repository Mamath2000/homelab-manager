import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { alertsOf } from '../src/homeassistant/alerts.js';
import { backupStatus } from '../src/monitoring.js';
import { backupState, effectiveThreshold } from '../src/pbs.js';
import { configMacs, followedStorages, guestResult, jobCovers, matchGuests, parseVzdumpLog, type ApiJob } from '../src/pve.js';
import { authorize } from '../src/roles.js';
import type { BackupDoc, PveJobRef } from '../src/types.js';

// shapes of /cluster/backup, /storage and a task log of PVE 9 (vouille, 2026-10-11)
const jobs: ApiJob[] = [
  { id: 'backup-1f3fe48d-802e', type: 'vzdump', enabled: 1, schedule: '6:00', storage: 'pbs-ds0', vmid: '191,179,180', 'next-run': 1791777600 },
  { id: 'backup-b567342e-2986', type: 'vzdump', enabled: 1, all: 1, exclude: '100,191,179,174,180', schedule: 'sun 01:00', storage: 'pbs-ds1' },
  { id: 'backup-4d360e71-b3b4', type: 'vzdump', enabled: 1, schedule: '04:00', storage: 'pbs-ds2', vmid: '100' },
];
const FP = 'AB:'.repeat(31) + 'AB';
const storages = [
  { storage: 'pbs-ds0', type: 'pbs', datastore: 'ds0', namespace: 'Vouille', server: '192.168.100.8', fingerprint: FP.toLowerCase() },
  { storage: 'pbs-ds1', type: 'pbs', datastore: 'ds1', namespace: 'Vouille', server: '192.168.100.8', fingerprint: FP },
  { storage: 'other', type: 'pbs', datastore: 'ds0', server: '10.0.0.1', fingerprint: 'CD:'.repeat(31) + 'CD' },
  { storage: 'local', type: 'dir' },
];

test('jobs cover listed guests, all but excluded ones, a pool, and only their node', () => {
  const pools = new Map([['web', new Set([150])]]);
  assert.ok(jobCovers(jobs[0], { vmid: 180, node: 'pve1' }, pools));
  assert.ok(!jobCovers(jobs[0], { vmid: 171, node: 'pve1' }, pools));
  assert.ok(jobCovers(jobs[1], { vmid: 171, node: 'pve1' }, pools));
  assert.ok(!jobCovers(jobs[1], { vmid: 180, node: 'pve1' }, pools));
  assert.ok(jobCovers({ id: 'p', pool: 'web' }, { vmid: 150, node: 'pve2' }, pools));
  assert.ok(!jobCovers({ id: 'n', all: 1, node: 'pve2' }, { vmid: 150, node: 'pve1' }, pools));
});

test('storages on the followed PBS: same fingerprint, else same server', () => {
  const m = followedStorages(storages, { url: 'https://192.168.100.8:8007', fingerprint: FP });
  assert.deepEqual([...m.keys()], ['pbs-ds0', 'pbs-ds1']);
  assert.deepEqual(m.get('pbs-ds0'), { store: 'ds0', ns: 'Vouille' });
  const byHost = followedStorages(storages, { url: 'https://10.0.0.1:8007', fingerprint: '' });
  assert.deepEqual([...byHost.keys()], ['other']);
  assert.equal(followedStorages(storages, { url: '', fingerprint: '' }).size, 0);
});

test('MAC addresses of LXC and QEMU configs', () => {
  assert.deepEqual(configMacs({ net0: 'name=eth0,bridge=vmbr1,gw=192.168.100.1,hwaddr=BC:24:11:CA:D1:43,ip=192.168.100.171/24,type=veth', hostname: 'x' }), ['bc:24:11:ca:d1:43']);
  assert.deepEqual(configMacs({ net0: null, net1: 'virtio=BC:24:11:07:97:17,bridge=vmbr1,firewall=1', net2: 'e1000=02:00:00:00:00:01,bridge=vmbr0' }), ['bc:24:11:07:97:17', '02:00:00:00:00:01']);
});

test('result of a guest in single and multi-guest vzdump tasks', () => {
  const single = { upid: 'UPID:pve1:1', id: '180', node: 'pve1', status: 'OK', starttime: 1, endtime: 2 };
  assert.deepEqual(guestResult(single, 180), { upid: 'UPID:pve1:1', at: 2000, ok: true });
  assert.equal(guestResult(single, 179), undefined);
  assert.equal(guestResult({ ...single, endtime: undefined, status: undefined }, 180), undefined);
  assert.deepEqual(guestResult({ ...single, status: 'unexpected status' }, 180), { upid: 'UPID:pve1:1', at: 2000, ok: false, error: 'unexpected status' });

  const log = parseVzdumpLog([
    'INFO: starting new backup job: vzdump 191 179 180 --storage pbs-ds0',
    'INFO: Starting Backup of VM 191 (lxc)',
    'INFO: Finished Backup of VM 191 (00:00:12)',
    'INFO: Starting Backup of VM 179 (lxc)',
    'ERROR: Backup of VM 179 failed - unable to open file',
    'INFO: Starting Backup of VM 180 (lxc)',
    'INFO: Backup job finished with errors',
  ]);
  const multi = { upid: 'UPID:pve1:2', id: '', node: 'pve1', status: 'job errors', starttime: 1, endtime: 5 };
  assert.equal(guestResult(multi, 191, log)?.ok, true);
  assert.deepEqual(guestResult(multi, 179, log), { upid: 'UPID:pve1:2', at: 5000, ok: false, error: 'unable to open file' });
  assert.deepEqual(guestResult(multi, 180, log), { upid: 'UPID:pve1:2', at: 5000, ok: false, error: 'job errors' });
  assert.equal(guestResult(multi, 100, log), undefined);
  assert.equal(guestResult({ ...multi, status: 'WARNINGS: 1' }, 191, log)?.ok, true);
});

test('a host is linked to the single guest that has one of its MAC addresses', () => {
  const [a, b, c, d] = [new ObjectId(), new ObjectId(), new ObjectId(), new ObjectId()];
  const all = [
    { _id: 'vouille/171', macs: ['bc:24:11:ca:d1:43'] },
    { _id: 'vouille/172', macs: ['bc:24:11:00:00:01', 'bc:24:11:00:00:02'] },
    { _id: 'jarsay/102', macs: ['bc:24:11:00:00:01'] },
  ];
  const m = matchGuests(
    [
      { _id: a, macs: ['BC-24-11-CA-D1-43', '02:42:ac:11:00:01'] }, // docker bridge MAC: ignored, unknown
      { _id: b, macs: ['bc:24:11:00:00:01'] }, // in two guests
      { _id: c, macs: [] },
      { _id: d, macs: ['bc:24:11:ca:d1:43', 'bc:24:11:00:00:02'] }, // two guests
    ],
    all,
  );
  assert.equal(m.get(a.toHexString()), 'vouille/171');
  assert.equal(m.get(b.toHexString()), null);
  assert.equal(m.get(c.toHexString()), null);
  assert.equal(m.get(d.toHexString()), null);
});

const H = 3600_000;
const job = (o: Partial<PveJobRef> = {}): PveJobRef => ({ id: 'j', schedule: '6:00', enabled: true, nextRun: null, storage: 's', store: 'ds0', ns: 'Vouille', ...o });
const group = (o: Partial<BackupDoc> = {}) =>
  ({ lastBackup: 0, verify: null, staleHours: null, gone: false, times: [], retention: null, pve: { cluster: 'vouille', vmid: 180, tz: 'Europe/Paris', jobs: [job()] }, ...o }) as BackupDoc;

test('state of a group written by a PVE job follows its schedule', () => {
  // sunday 2026-10-11, 6:00 Paris = 04:00 UTC
  const run = Date.UTC(2026, 9, 11, 4);
  // before the grace period: the previous day's run is expected
  assert.equal(backupState(group({ lastBackup: run - 24 * H + 60_000 }), run + H), 'ok');
  // after it: today's run must be there
  assert.equal(backupState(group({ lastBackup: run - 24 * H + 60_000 }), run + 3 * H), 'stale');
  assert.equal(backupState(group({ lastBackup: run + 5 * 60_000 }), run + 3 * H), 'ok');
  // never backed up (placeholder)
  assert.equal(backupState(group(), run + 3 * H), 'stale');
  // last task failed after the last snapshot
  const failed = group({ lastBackup: run - 24 * H, pve: { cluster: 'vouille', vmid: 180, tz: 'Europe/Paris', jobs: [job()], lastTask: { upid: 'u', at: run + 600_000, ok: false, error: 'x' } } });
  assert.equal(backupState(failed, run + H), 'task_failed');
  // every job disabled
  assert.equal(backupState(group({ lastBackup: run, pve: { cluster: 'vouille', vmid: 180, tz: 'Europe/Paris', jobs: [job({ enabled: false })] } }), run + H), 'disabled');
  // a schedule this hub does not understand, no history: no threshold
  const odd = group({ lastBackup: run, pve: { cluster: 'vouille', vmid: 180, tz: 'Europe/Paris', jobs: [job({ schedule: '2026-10-11 06:00' })] } });
  assert.equal(effectiveThreshold(odd, run).source, 'none');
  // threshold shown: one period + the grace
  assert.deepEqual(effectiveThreshold(group(), run + 3 * H), { hours: 26, source: 'schedule', interval: 24 * H });
  // own threshold wins
  assert.equal(effectiveThreshold(group({ staleHours: 72 }), run).source, 'manual');
});

test('alerts of PVE groups and of a guest no job covers', () => {
  const now = Date.now();
  const pve = (jobs: PveJobRef[]) => ({ cluster: 'vouille', vmid: 180, tz: 'Europe/Paris', jobs });
  const msgs = alertsOf(
    backupStatus({}, {
      online: true,
      now,
      groups: [
        group({ backupId: '180', lastBackup: now, pve: { ...pve([job()]), lastTask: { upid: 'u', at: now + 1, ok: false, error: 'x' } } }),
        group({ backupId: '181', lastBackup: now, pve: pve([job({ enabled: false })]) }),
      ],
    })!,
    'backup',
  ).map((a) => a.message);
  assert.deepEqual(msgs, ['180 : dernière exécution en échec', '181 : job désactivé']);
  const guest = (covered: boolean) => ({ pve: { cluster: 'v', vmid: 171, type: 'lxc' as const, node: 'pve1', name: 'x', covered } });
  const ctx = { online: true, groups: [], now };
  assert.equal(alertsOf(backupStatus(guest(false), ctx) ?? undefined, 'backup')[0].message, 'CT 171 couvert par aucun job de sauvegarde Proxmox');
  assert.equal(backupStatus(guest(true), ctx), null);
  assert.equal(backupStatus({}, ctx), null);
});

test('PVE settings are admin only', () => {
  assert.equal(authorize('operator', 'GET', '/api/settings/pve'), false);
  assert.equal(authorize('operator', 'PUT', '/api/settings/pve/clusters/:id'), false);
  assert.equal(authorize('admin', 'PUT', '/api/settings/pve/clusters/:id'), true);
});
