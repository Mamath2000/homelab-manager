import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backupsAlert } from '../src/alerts.js';
import { copiedGroups, desiredJob, lastRunOf, notCopiable, offsiteState, planSync, remoteEntry, sameGroupElsewhere, syncJobId, updateBody, upidStart } from '../src/offsite.js';
import { authorize } from '../src/roles.js';
import type { BackupDoc, BackupOffsite } from '../src/types.js';

const remote = { store: 'ds9', tokenId: 'homelab@pbs!hub' };
const settingsOf = { schedule: '06:00', transferLast: 2, rateIn: null };
const group = (o: Partial<BackupDoc> = {}) => ({ _id: 'ds0/Hosts/host/nextcloud-config', store: 'ds0', ns: 'Hosts', type: 'host', backupId: 'nextcloud-config', ...o });

test('sync job of a group: one group, same namespace, never recursive nor removing', () => {
  const j = desiredJob(group(), settingsOf, remote);
  assert.deepEqual(j, {
    id: syncJobId('ds0/Hosts/host/nextcloud-config'),
    store: 'ds9',
    ns: 'Hosts',
    remote: 'hlm-main',
    'remote-store': 'ds0',
    'remote-ns': 'Hosts',
    'max-depth': 0,
    'group-filter': ['group:host/nextcloud-config'],
    'remove-vanished': false,
    owner: 'homelab@pbs!hub',
    schedule: '06:00',
    'transfer-last': 2,
    comment: 'Homelab Manager : ds0/Hosts/host/nextcloud-config',
  });
  assert.match(j.id, /^hlm-[0-9a-f]{12}$/);
  // root namespace: no ns at all; a limit of rate when set
  const root = desiredJob(group({ _id: 'ds1//ct/105', store: 'ds1', ns: '', type: 'ct', backupId: '105' }), { ...settingsOf, transferLast: null, rateIn: '10MiB' }, remote);
  assert.equal('ns' in root, false);
  assert.equal('remote-ns' in root, false);
  assert.equal('transfer-last' in root, false);
  assert.equal(root['rate-in'], '10MiB');
  // never an empty filter, which would copy everything
  assert.throws(() => desiredJob(group({ backupId: '' }), settingsOf, remote));
});

test('reconciliation: creates, updates and removes its own jobs only', () => {
  const a = desiredJob(group(), settingsOf, remote);
  const b = desiredJob(group({ _id: 'ds0/Vouille/ct/105', ns: 'Vouille', type: 'ct', backupId: '105' }), settingsOf, remote);
  const c = desiredJob(group({ _id: 'ds0/Jarsay/ct/105', ns: 'Jarsay', type: 'ct', backupId: '105' }), settingsOf, remote);
  const plan = planSync([a, b, c], [
    { ...a }, // same: nothing
    { ...b, schedule: '05:00' }, // differs: update
    { id: 'hlm-000000000000', store: 'ds9' }, // no longer wanted: removed
    { id: 'manual-sync', store: 'ds9' }, // not the hub's: left alone
  ]);
  assert.deepEqual(plan.create.map((j) => j.id), [c.id]);
  assert.deepEqual(plan.update.map((j) => j.id), [b.id]);
  assert.deepEqual(plan.remove, ['hlm-000000000000']);
  // a filter changed on the PBS by hand is put back
  assert.deepEqual(planSync([a], [{ ...a, 'group-filter': [] }]).update.map((j) => j.id), [a.id]);
  assert.throws(() => planSync([{ ...a, 'group-filter': [] }], []));
});

test('update of a job clears the optional fields no longer set', () => {
  const j = desiredJob(group({ ns: '' }), { ...settingsOf, transferLast: null }, remote);
  const body = updateBody(j);
  assert.equal('id' in body, false);
  assert.deepEqual(body.delete, ['ns', 'remote-ns', 'transfer-last', 'rate-in']);
  assert.equal('delete' in updateBody(desiredJob(group(), { ...settingsOf, rateIn: '1MiB' }, remote)), false);
});

test('remote entry: address of the main PBS, rewritten when the reader token changes', () => {
  const main = { url: 'https://192.168.100.8:8007', fingerprint: 'AB:CD' };
  const one = remoteEntry(main, { readerTokenId: 'homelab@pbs!reader', readerTokenSecret: 's1' });
  assert.deepEqual(one.entry, { host: '192.168.100.8', port: 8007, 'auth-id': 'homelab@pbs!reader', fingerprint: 'AB:CD' });
  assert.notEqual(remoteEntry(main, { readerTokenId: 'homelab@pbs!reader', readerTokenSecret: 's2' }).hash, one.hash);
  assert.equal(remoteEntry({ url: 'https://pbs.lan', fingerprint: '' }, { readerTokenId: 'x@pbs!r', readerTokenSecret: 's' }).entry.port, 8007);
  // the hash never holds the secret in clear
  assert.equal(one.hash.includes('s1'), false);
});

test('groups that cannot be copied, the same group from two datastores', () => {
  assert.notEqual(notCopiable({ source: 'haos' }), null);
  assert.notEqual(notCopiable({ placeholder: true }), null);
  assert.equal(notCopiable({ source: 'vzdump' }), null);
  // Hosts/host/canicoif-pprod moved from ds0 to ds3: one target group
  const moved = [{ _id: 'ds0/Hosts/host/canicoif-pprod', store: 'ds0', ns: 'Hosts', type: 'host', backupId: 'canicoif-pprod' }];
  assert.equal(sameGroupElsewhere({ _id: 'ds3/Hosts/host/canicoif-pprod', ns: 'Hosts', type: 'host', backupId: 'canicoif-pprod' }, moved)?.store, 'ds0');
  assert.equal(sameGroupElsewhere(moved[0], moved), null);
  // ct/105 under Vouille and under Jarsay: two groups
  assert.equal(sameGroupElsewhere({ _id: 'ds0/Jarsay/ct/105', ns: 'Jarsay', type: 'ct', backupId: '105' }, [{ _id: 'ds0/Vouille/ct/105', store: 'ds0', ns: 'Vouille', type: 'ct', backupId: '105' }]), null);
});

test('last run of a sync job: start read from its UPID', () => {
  const start = 1_760_680_000;
  const upid = `UPID:pbs:00001234:0000ABCD:00000001:${start.toString(16).toUpperCase()}:syncjob:hlm-x:root@pam:`;
  assert.equal(upidStart(upid), start * 1000);
  assert.equal(upidStart('garbage'), null);
  assert.deepEqual(lastRunOf({ id: 'x', 'last-run-upid': upid, 'last-run-state': 'OK', 'last-run-endtime': start + 60 }), { start: start * 1000, end: (start + 60) * 1000, ok: true });
  assert.deepEqual(lastRunOf({ id: 'x', 'last-run-state': 'missing Datastore.Modify', 'last-run-endtime': start }), { start: start * 1000, end: start * 1000, ok: false, error: 'missing Datastore.Modify' });
  assert.equal(lastRunOf({ id: 'x' }), null);
});

const H = 3600_000;
const offsite = (o: Partial<BackupOffsite>): BackupOffsite => ({ enabled: true, schedule: '06:00', transferLast: 2, rateIn: null, jobId: 'hlm-x', since: 0, ...o });

test('state of a copy: pending, ok, late, failed', () => {
  const now = 100 * H;
  const times = [{ t: now - 30 * H, verify: null }, { t: now - 6 * H, verify: null }];
  const b = (o: Partial<BackupOffsite>) => ({ times, lastBackup: now - 6 * H, offsite: offsite(o) });
  assert.equal(offsiteState({ times, lastBackup: now, offsite: offsite({ enabled: false }) }), null);
  assert.equal(offsiteState(b({})), 'pending');
  // run after the last snapshot, which arrived
  assert.equal(offsiteState(b({ lastRun: { start: now - 2 * H, end: now - H, ok: true }, lastBackup: now - 6 * H })), 'ok');
  // run after the last snapshot, only the previous one is there
  assert.equal(offsiteState(b({ lastRun: { start: now - 2 * H, end: now - H, ok: true }, lastBackup: now - 30 * H })), 'late');
  // the last snapshot was made after the run started: the previous one is enough
  assert.equal(offsiteState(b({ lastRun: { start: now - 10 * H, end: now - 5 * H, ok: true }, lastBackup: now - 30 * H })), 'ok');
  assert.equal(offsiteState(b({ lastRun: { start: now - 2 * H, end: now - H, ok: false, error: 'x' }, lastBackup: now - 6 * H })), 'failed');
  // sync job refused by the secondary
  assert.equal(offsiteState(b({ error: 'HTTP 403' })), 'failed');
});

test('alerts: a failed copy is an alert, a late one a warning; running it is for operators', () => {
  const now = Date.now();
  const base = { _id: 'ds0/Hosts/host/a', store: 'ds0', ns: 'Hosts', type: 'host', backupId: 'a', count: 3, lastBackup: now - H, size: null, verify: 'ok' as const, hostId: null, seenAt: new Date(), times: [{ t: now - H, verify: null }] };
  const late = backupsAlert([{ ...base, offsite: offsite({ lastRun: { start: now - 0.5 * H, end: now - 0.4 * H, ok: true }, lastBackup: now - 30 * H }) }], now);
  assert.equal(late?.level, 'warn');
  assert.match(late!.reasons[0], /copie déportée en retard/);
  const failed = backupsAlert([{ ...base, offsite: offsite({ lastRun: { start: now, end: now, ok: false, error: 'x' } }) }], now);
  assert.equal(failed?.level, 'alert');
  assert.equal(authorize('operator', 'POST', '/api/backups/:id/offsite/run'), true);
  assert.equal(authorize('operator', 'PUT', '/api/backups/:id/offsite'), false);
  assert.equal(authorize('operator', 'POST', '/api/settings/pbs-remote/token'), false);
  assert.equal(authorize('viewer', 'POST', '/api/backups/:id/offsite/run'), false);
});

test('poll of the secondary: last snapshot of each copied group and its timeline, oldest first', () => {
  const g = (id: string, last: number, count: number) => ({ 'backup-type': 'host', 'backup-id': id, 'last-backup': last, 'backup-count': count });
  const s = (id: string, t: number, state?: string, size?: number) => ({ 'backup-type': 'host', 'backup-id': id, 'backup-time': t, ...(size ? { size } : {}), ...(state ? { verification: { state } } : {}) });
  const out = copiedGroups([g('a', 300, 3), g('b', 50, 0)], [s('a', 300, undefined, 9), s('a', 100, 'ok', 7), s('a', 200, 'failed'), s('other', 400)]);
  assert.deepEqual(out.get('host/a'), {
    lastBackup: 300_000,
    count: 3,
    verify: null,
    size: 9,
    times: [
      { t: 100_000, verify: 'ok', size: 7 },
      { t: 200_000, verify: 'failed', size: null },
      { t: 300_000, verify: null, size: 9 },
    ],
  });
  // a group listed without snapshots (pruned meanwhile): no timeline
  assert.deepEqual(out.get('host/b'), { lastBackup: 50_000, count: 0, verify: null, size: null, times: [] });
  assert.equal(out.has('host/other'), false);
});
