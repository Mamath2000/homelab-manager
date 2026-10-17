import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backupsAlert } from '../src/alerts.js';
import {
  copiedGroups,
  taskGroup,
  taskOk,
  desiredJob,
  isQueueReport,
  lastRunOf,
  notCopiable,
  offsiteSpec,
  offsiteState,
  planSync,
  queuePositions,
  remoteEntry,
  sameGroupElsewhere,
  syncJobId,
  updateBody,
  upidStart,
} from '../src/offsite.js';
import { authorize } from '../src/roles.js';
import type { BackupDoc, BackupOffsite, PbsRemoteSettings } from '../src/types.js';

const remote = { store: 'ds9', tokenId: 'homelab@pbs!hub' };
const settingsOf = { rateIn: null };
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
    'transfer-last': 1,
    comment: 'Homelab Manager : ds0/Hosts/host/nextcloud-config',
  });
  assert.match(j.id, /^hlm-[0-9a-f]{12}$/);
  // root namespace: no ns at all; a limit of rate when set; always the last snapshot only
  const root = desiredJob(group({ _id: 'ds1//ct/105', store: 'ds1', ns: '', type: 'ct', backupId: '105' }), { ...settingsOf, rateIn: '10MiB' }, remote);
  assert.equal('ns' in root, false);
  assert.equal('remote-ns' in root, false);
  assert.equal(root['transfer-last'], 1);
  assert.equal(root['rate-in'], '10MiB');
  // never an empty filter, which would copy everything
  assert.throws(() => desiredJob(group({ backupId: '' }), settingsOf, remote));
  // the agent of the secondary does not run the queue yet: the schedule of the PBS, the group's or 06:00
  assert.equal(desiredJob(group(), settingsOf, remote, false).schedule, '06:00');
  assert.equal(desiredJob(group(), { ...settingsOf, schedule: '06:30' }, remote, false).schedule, '06:30');
});

test('the queue takes over: the schedule of the existing jobs is removed', () => {
  const queued = desiredJob(group(), settingsOf, remote);
  const plan = planSync([queued], [{ ...queued, schedule: '06:00' }]);
  assert.deepEqual(plan.update.map((j) => j.id), [queued.id]);
  assert.deepEqual(updateBody(plan.update[0]).delete, ['schedule', 'rate-in']);
  // already without: nothing to do
  assert.equal(planSync([queued], [{ ...queued }]).update.length, 0);
});

test('reconciliation: creates, updates and removes its own jobs only', () => {
  const a = desiredJob(group(), settingsOf, remote);
  const b = desiredJob(group({ _id: 'ds0/Vouille/ct/105', ns: 'Vouille', type: 'ct', backupId: '105' }), settingsOf, remote);
  const c = desiredJob(group({ _id: 'ds0/Jarsay/ct/105', ns: 'Jarsay', type: 'ct', backupId: '105' }), settingsOf, remote);
  const plan = planSync([a, b, c], [
    { ...a }, // same: nothing
    { ...b, comment: 'changed by hand' }, // differs: update
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
  const j = desiredJob(group({ ns: '' }), settingsOf, remote);
  const body = updateBody(j);
  assert.equal('id' in body, false);
  assert.deepEqual(body.delete, ['ns', 'remote-ns', 'schedule', 'rate-in']);
  assert.deepEqual(updateBody(desiredJob(group(), { ...settingsOf, rateIn: '1MiB' }, remote)).delete, ['schedule']);
  assert.equal('delete' in updateBody(desiredJob(group(), { ...settingsOf, rateIn: '1MiB' }, remote, false)), false);
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
const offsite = (o: Partial<BackupOffsite>): BackupOffsite => ({ enabled: true, rateIn: null, jobId: 'hlm-x', since: 0, ...o });

test('state of a copy: pending, ok, late, failed', () => {
  const now = 1000 * H;
  const run = { start: now - 2 * H, end: now - H, ok: true };
  const b = (mainLast: number, o: Partial<BackupOffsite>) => ({ lastBackup: mainLast, offsite: offsite(o) });
  assert.equal(offsiteState({ lastBackup: now, offsite: offsite({ enabled: false }) }, 24, now), null);
  // never copied, recent snapshot: waits for the queue
  assert.equal(offsiteState(b(now - 6 * H, {}), 24, now), 'pending');
  // never copied for more than the delay plus a day
  assert.equal(offsiteState(b(now - 49 * H, {}), 24, now), 'late');
  // ... counted from the enabling of the copy when later
  assert.equal(offsiteState(b(now - 100 * H, { since: now - 2 * H }), 24, now), 'pending');
  // last snapshot copied
  assert.equal(offsiteState(b(now - 6 * H, { lastRun: run, lastBackup: now - 6 * H }), 24, now), 'ok');
  // newer snapshot not copied yet, within the delay plus a day
  assert.equal(offsiteState(b(now - 30 * H, { lastRun: run, lastBackup: now - 54 * H }), 24, now), 'ok');
  // ... beyond it
  assert.equal(offsiteState(b(now - 50 * H, { lastRun: run, lastBackup: now - 74 * H }), 24, now), 'late');
  // shorter delay: late sooner
  assert.equal(offsiteState(b(now - 30 * H, { lastRun: run, lastBackup: now - 54 * H }), 4, now), 'late');
  assert.equal(offsiteState(b(now - 6 * H, { lastRun: { ...run, ok: false, error: 'x' }, lastBackup: now - 30 * H }), 24, now), 'failed');
  // sync job refused by the secondary
  assert.equal(offsiteState(b(now - 6 * H, { error: 'HTTP 403' }), 24, now), 'failed');
});

test('definition of the queue for the agent of the secondary', () => {
  const r: PbsRemoteSettings = {
    _id: 'pbs-remote',
    enabled: true,
    agent: { hostId: 'a'.repeat(24), mode: 'container', container: 'pbs' },
    url: 'https://192.168.2.101:8007',
    fingerprint: '',
    store: 'ds9',
    tokenId: 'homelab@pbs!hub',
    tokenSecret: 's',
    readerTokenId: 'homelab@pbs!reader',
    readerTokenSecret: 'r',
  };
  const g = (id: string, store: string, ns: string, enabled = true) => ({ store, ns, type: 'host', backupId: id, offsite: offsite({ enabled, jobId: syncJobId(`${store}/${ns}/host/${id}`) }) });
  const groups = [g('b', 'ds3', 'Hosts'), g('a', 'ds0', ''), g('off', 'ds0', 'Hosts', false)];
  const s = offsiteSpec(r, groups, 'Europe/Paris');
  assert.equal(s.container, 'pbs');
  assert.equal(s.store, 'ds9');
  assert.equal(s.remote, 'hlm-main');
  assert.deepEqual(
    [s.windowStart, s.windowEnd, s.concurrency, s.minDelayH, s.countMaintenance, s.tz],
    ['04:00', '09:00', 1, 24, true, 'Europe/Paris'],
  );
  assert.deepEqual(s.jobs.map((j) => j.backupId).sort(), ['a', 'b']);
  assert.deepEqual(s.jobs.find((j) => j.backupId === 'a'), { id: syncJobId('ds0//host/a'), remoteStore: 'ds0', ns: '', type: 'host', backupId: 'a' });
  // stable: the same groups in another order give the same definition
  assert.equal(offsiteSpec(r, [...groups].reverse(), 'Europe/Paris').hash, s.hash);
  // settings changed: a new definition
  const t = offsiteSpec({ ...r, queue: { windowStart: '22:00', windowEnd: '06:00', concurrency: 2, minDelayH: 12, countMaintenance: false } }, groups, 'Europe/Paris');
  assert.notEqual(t.hash, s.hash);
  assert.equal(t.concurrency, 2);
  // secondary disabled: no job, the agent empties its queue
  assert.deepEqual(offsiteSpec({ ...r, enabled: false }, groups).jobs, []);
  // native PBS: no container
  assert.equal(offsiteSpec({ ...r, agent: { hostId: 'a'.repeat(24), mode: 'native' } }, groups).container, '');
});

test('report of the queue: checked, positions of the groups', () => {
  const report = { hash: 'h', scannedAt: 1, queue: [{ jobId: 'hlm-b', since: 5 }, { jobId: 'hlm-a', since: 7 }], running: [], inWindow: false };
  assert.equal(isQueueReport(report), true);
  assert.equal(isQueueReport({ ...report, queue: null }), false);
  assert.equal(isQueueReport(null), false);
  const pos = queuePositions(report);
  assert.deepEqual(pos.get('hlm-a'), { since: 7, position: 2 });
  assert.deepEqual(pos.get('hlm-b'), { since: 5, position: 1 });
  assert.equal(pos.has('hlm-c'), false);
});

test('alerts: a failed copy is an alert, a late one a warning; running it is for operators', () => {
  const now = Date.now();
  const base = { _id: 'ds0/Hosts/host/a', store: 'ds0', ns: 'Hosts', type: 'host', backupId: 'a', count: 3, lastBackup: now - H, size: null, verify: 'ok' as const, hostId: null, seenAt: new Date(), times: [{ t: now - H, verify: null }] };
  const late = backupsAlert([{ ...base, lastBackup: now - 50 * H, offsite: offsite({ lastRun: { start: now - 60 * H, end: now - 59 * H, ok: true }, lastBackup: now - 74 * H }) }], now);
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

test('namespace of a group missing on the secondary: levels to create, parents first', async () => {
  const { missingLevels, namespaceCommands } = await import('../src/routes/offsite.js');
  assert.deepEqual(missingLevels('Hosts', ['Hosts', 'Vouille']), []);
  assert.deepEqual(missingLevels('Hosts', ['Vouille']), ['Hosts']);
  assert.deepEqual(missingLevels('Sites/Jarsay', ['Sites']), ['Sites/Jarsay']);
  assert.deepEqual(missingLevels('Sites/Jarsay', []), ['Sites', 'Sites/Jarsay']);
  assert.deepEqual(namespaceCommands(['Hosts'], 'ds9'), ['proxmox-backup-client namespace create Hosts --repository root@pam@localhost:ds9']);
});

test('tasks of the secondary: the copy a sync task belongs to, how it ended', () => {
  const groups = [{ offsite: offsite({ jobId: 'hlm-aaaaaaaaaaaa' }) }, { offsite: offsite({ jobId: 'hlm-bbbbbbbbbbbb' }) }];
  const t = (worker_id?: string) => ({ upid: 'UPID:pbs2:00001:00002:00000003:6712A000:syncjob:x:root@pam:', worker_id });
  assert.equal(taskGroup(t('hlm-main:ds0:ds9:Hosts:hlm-bbbbbbbbbbbb'), groups), groups[1]);
  assert.equal(taskGroup(t('hlm-aaaaaaaaaaaa'), groups), groups[0]);
  assert.equal(taskGroup(t('other:ds0:ds9::manual-sync'), groups), null);
  assert.equal(taskOk('OK'), true);
  assert.equal(taskOk('WARNINGS: 2'), true);
  assert.equal(taskOk('connection refused'), false);
});
