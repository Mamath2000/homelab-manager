import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayOf, offsiteStatus } from '../src/monitoring.js';
import {
  ADHOC_RE,
  adhocBlocker,
  adhocJobId,
  copiedGroups,
  desiredJobs,
  groupResults,
  groupsOf,
  isSeriesReport,
  lastVerified,
  lineGroup,
  notCopiable,
  offsiteSpec,
  offsiteState,
  planSync,
  remoteEntry,
  sameGroupElsewhere,
  syncJobId,
  taskJob,
  taskOk,
  updateBody,
  upidStart,
} from '../src/offsite.js';
import { authorize } from '../src/roles.js';
import type { BackupOffsite, PbsRemoteSettings } from '../src/types.js';

const remote = { store: 'ds9', tokenId: 'homelab@pbs!hub' };
const group = (backupId: string, store = 'ds0', ns = 'Hosts', type = 'host') => ({ _id: `${store}/${ns}/${type}/${backupId}`, store, ns, type, backupId });

test('sync job id: datastore and namespace, readable, a hash beyond 32 characters', () => {
  assert.equal(syncJobId('ds0', 'Hosts'), 'hlm-ds0-Hosts');
  assert.equal(syncJobId('ds1', ''), 'hlm-ds1');
  assert.equal(syncJobId('ds3', 'Sites/Jarsay'), 'hlm-ds3-Sites.Jarsay');
  const long = syncJobId('ds0', 'Very/Long/Namespace/Path/Here');
  assert.match(long, /^hlm-[0-9a-f]{12}$/);
  assert.equal(syncJobId('ds0', 'Very/Long/Namespace/Path/Here'), long);
});

test('sync jobs: one per datastore and namespace, exact filter, verified only, never recursive nor removing', () => {
  const jobs = desiredJobs([group('b'), group('a'), group('105', 'ds0', 'Vouille', 'ct'), group('105', 'ds0', 'Jarsay', 'ct'), group('100', 'ds1', '', 'vm')], remote);
  assert.deepEqual(jobs.map((j) => j.id), ['hlm-ds0-Hosts', 'hlm-ds0-Jarsay', 'hlm-ds0-Vouille', 'hlm-ds1']);
  assert.deepEqual(jobs[0], {
    id: 'hlm-ds0-Hosts',
    store: 'ds9',
    ns: 'Hosts',
    remote: 'hlm-main',
    'remote-store': 'ds0',
    'remote-ns': 'Hosts',
    'max-depth': 0,
    // sorted: the same groups give the same job
    'group-filter': ['group:host/a', 'group:host/b'],
    'remove-vanished': false,
    owner: 'homelab@pbs!hub',
    'transfer-last': 1,
    'verified-only': true,
    'resync-corrupt': true,
    'worker-threads': 1,
    comment: 'Homelab Manager : ds0 › Hosts',
  });
  // ct/105 of Vouille and of Jarsay: two jobs, each its own namespace (the filter of PBS ignores it)
  assert.deepEqual(jobs[1]['group-filter'], ['group:ct/105']);
  assert.equal(jobs[1]['remote-ns'], 'Jarsay');
  // root namespace: no ns at all
  assert.equal('ns' in jobs[3], false);
  assert.equal('remote-ns' in jobs[3], false);
  // never an incomplete group, which would widen the filter
  assert.throws(() => desiredJobs([group('')], remote));
  assert.deepEqual(desiredJobs([], remote), []);
});

test('reconciliation: creates, updates and removes its own jobs only, the jobs of one group of before too', () => {
  const [a, b, c] = desiredJobs([group('a'), group('105', 'ds0', 'Vouille', 'ct'), group('100', 'ds1', '', 'vm')], remote);
  const plan = planSync([a, b, c], [
    { ...a }, // same: nothing
    { ...b, 'group-filter': ['group:ct/105', 'group:ct/106'] }, // a group added by hand: put back
    { id: 'hlm-80b3ff9bf2c0', store: 'ds9', schedule: '06:00' }, // job of one group (#185): removed
    { id: 'manual-sync', store: 'ds9' }, // not the hub's: left alone
  ]);
  assert.deepEqual(plan.create.map((j) => j.id), [c.id]);
  assert.deepEqual(plan.update.map((j) => j.id), [b.id]);
  assert.deepEqual(plan.remove, ['hlm-80b3ff9bf2c0']);
  // options changed on the PBS by hand are put back
  assert.equal(planSync([a], [{ ...a, 'verified-only': false }]).update.length, 1);
  assert.equal(planSync([a], [{ ...a, 'worker-threads': 4 }]).update.length, 1);
  // an empty filter would copy the whole namespace
  assert.throws(() => planSync([{ ...a, 'group-filter': [] }], []));
});

test('update of a job clears the optional fields no longer set (schedule and rate of before)', () => {
  const [root] = desiredJobs([group('100', 'ds1', '', 'vm')], remote);
  const body = updateBody(root);
  assert.equal('id' in body, false);
  assert.deepEqual(body.delete, ['ns', 'remote-ns', 'schedule', 'rate-in']);
  const [hosts] = desiredJobs([group('a')], remote);
  assert.deepEqual(updateBody(hosts).delete, ['schedule', 'rate-in']);
  // a job of before with a schedule: updated, the schedule removed
  assert.equal(planSync([hosts], [{ ...hosts, schedule: '06:00' }]).update.length, 1);
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

test('groups that cannot be copied, the same group from two datastores; guests can be copied', () => {
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

test('start of a task from its UPID', () => {
  const start = 1_760_680_000;
  assert.equal(upidStart(`UPID:pbs:00001234:0000ABCD:00000001:${start.toString(16).toUpperCase()}:syncjob:x:root@pam:`), start * 1000);
  assert.equal(upidStart('garbage'), null);
});

const H = 3600_000;
const offsite = (o: Partial<BackupOffsite>): BackupOffsite => ({ enabled: true, jobId: 'hlm-ds0-Hosts', since: 0, ...o });

test('state of a copy: pending, ok, late, failed, from the verified snapshots of the main PBS', () => {
  const now = 1000 * H;
  const run = { start: now - 2 * H, end: now - H, ok: true };
  // main PBS: a snapshot verified 6 h ago, a newer one not verified yet
  const times = [
    { t: now - 30 * H, verify: 'ok' as const },
    { t: now - 6 * H, verify: 'ok' as const },
    { t: now - H, verify: null },
  ];
  const b = (o: Partial<BackupOffsite>, t = times) => ({ lastBackup: t[t.length - 1].t, verify: t[t.length - 1].verify, times: t, offsite: offsite(o) });
  assert.equal(lastVerified(b({})), now - 6 * H);
  assert.equal(offsiteState({ ...b({}), offsite: offsite({ enabled: false }) }, now), null);
  // the last verified one is copied: ok (the unverified one is not copied, by choice)
  assert.equal(offsiteState(b({ lastRun: run, lastBackup: now - 6 * H }), now), 'ok');
  // a verified one newer than the copy: pending...
  assert.equal(offsiteState(b({ lastRun: run, lastBackup: now - 30 * H }), now), 'pending');
  // ... late once a daily series missed it
  const old = [{ t: now - 60 * H, verify: 'ok' as const }, { t: now - 31 * H, verify: 'ok' as const }];
  assert.equal(offsiteState(b({ lastRun: run, lastBackup: now - 60 * H }, old), now), 'late');
  // never copied: pending, late after the delay, counted from the enabling when later
  assert.equal(offsiteState(b({}), now), 'pending');
  assert.equal(offsiteState(b({}, old), now), 'late');
  assert.equal(offsiteState(b({ since: now - 2 * H }, old), now), 'pending');
  // nothing verified on the main PBS yet, nothing copied: pending
  assert.equal(offsiteState(b({}, [{ t: now - 50 * H, verify: null }]), now), 'pending');
  // last run failed for this group, or job refused by the secondary
  assert.equal(offsiteState(b({ lastRun: { ...run, ok: false, error: 'x' }, lastBackup: now - 6 * H }), now), 'failed');
  assert.equal(offsiteState(b({ error: 'HTTP 403' }), now), 'failed');
});

test('definition of the series for the agent of the secondary', () => {
  const r: PbsRemoteSettings = {
    _id: 'pbs-remote',
    agent: { hostId: 'a'.repeat(24), mode: 'container', container: 'pbs' },
    url: 'https://192.168.2.101:8007',
    fingerprint: '',
    store: 'ds9',
    tokenId: 'homelab@pbs!hub',
    tokenSecret: 's',
    readerTokenId: 'homelab@pbs!reader',
    readerTokenSecret: 'r',
  };
  const groups = [group('b', 'ds3'), group('a'), group('c'), group('100', 'ds1', '', 'vm')];
  const s = offsiteSpec(r, groups, 'Europe/Paris');
  assert.equal(s.container, 'pbs');
  assert.deepEqual(s.jobs, ['hlm-ds0-Hosts', 'hlm-ds1', 'hlm-ds3-Hosts']);
  assert.equal(s.start, '04:00');
  assert.equal(s.tz, 'Europe/Paris');
  // second pass: only when set (the hash of the others does not change)
  assert.equal('retryAfterMin' in s, false);
  const withRetry = offsiteSpec(r, groups, 'Europe/Paris', 240);
  assert.equal(withRetry.retryAfterMin, 240);
  assert.notEqual(withRetry.hash, s.hash);
  // stable: the same groups in another order give the same definition
  assert.equal(offsiteSpec(r, [...groups].reverse(), 'Europe/Paris').hash, s.hash);
  // another start: a new definition
  const t = offsiteSpec({ ...r, startTime: '05:30' }, groups, 'Europe/Paris');
  assert.notEqual(t.hash, s.hash);
  assert.equal(t.start, '05:30');
  assert.equal(offsiteSpec({ ...r, startTime: 'nope' }, groups).start, '04:00');
  // secondary not connected (being disconnected): no job, the agent empties its series
  assert.deepEqual(offsiteSpec({ ...r, tokenSecret: '' }, groups).jobs, []);
  // native PBS: no container
  assert.equal(offsiteSpec({ ...r, agent: { hostId: 'a'.repeat(24), mode: 'native' } }, groups).container, '');
});

test('report of the series: checked', () => {
  const report = { hash: 'h', day: '2026-10-18', total: 3, pending: ['hlm-ds1'], running: { jobId: 'hlm-ds0-Hosts', upid: 'UPID:x', start: 1 }, nextStart: 2 };
  assert.equal(isSeriesReport(report), true);
  assert.equal(isSeriesReport({ ...report, pending: null }), false);
  assert.equal(isSeriesReport({ hash: 'h', scannedAt: 1, queue: [], running: [], inWindow: false }), false);
  assert.equal(isSeriesReport(null), false);
});

test('alerts: a failed copy is an alert, a late one a warning; the copy is set by admins only', () => {
  const now = Date.now();
  const base = { _id: 'ds0/Hosts/host/a', store: 'ds0', ns: 'Hosts', type: 'host', backupId: 'a', count: 3, lastBackup: now - H, size: null, verify: 'ok' as const, hostId: null, seenAt: new Date(), times: [{ t: now - H, verify: 'ok' as const }] };
  const copy = (groups: Parameters<typeof offsiteStatus>[1]['groups']) => dayOf(offsiteStatus({}, { online: true, groups, now }));
  const late = copy([{ ...base, lastBackup: now - 40 * H, times: [{ t: now - 40 * H, verify: 'ok' }], offsite: offsite({ lastRun: { start: now - 60 * H, end: now - 59 * H, ok: true }, lastBackup: now - 74 * H }) }]);
  assert.equal(late?.level, 'warn');
  assert.match(late!.reasons[0], /copie en retard/);
  const failed = copy([{ ...base, offsite: offsite({ lastRun: { start: now, end: now, ok: false, error: 'x' } }) }]);
  assert.equal(failed?.level, 'alert');
  assert.equal(authorize('operator', 'PUT', '/api/backups/:id/offsite'), false);
  assert.equal(authorize('operator', 'POST', '/api/settings/pbs-remote/token'), false);
  assert.equal(authorize('viewer', 'PUT', '/api/backups/:id/offsite'), false);
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

test('tasks of the secondary: the sync job a task belongs to, how it ended', () => {
  const jobs = ['hlm-ds0-Hosts', 'hlm-ds0'];
  const t = (worker_id?: string) => ({ upid: 'UPID:pbs2:00001:00002:00000003:6712A000:syncjob:x:root@pam:', worker_id });
  assert.equal(taskJob(t('hlm-main:ds0:ds9:Hosts:hlm-ds0-Hosts'), jobs), 'hlm-ds0-Hosts');
  assert.equal(taskJob(t('hlm-main:ds0:ds9::hlm-ds0'), jobs), 'hlm-ds0');
  assert.equal(taskJob(t('other:ds0:ds9::manual-sync'), jobs), null);
  assert.equal(taskOk('OK'), true);
  assert.equal(taskOk('WARNINGS: 2'), true);
  assert.equal(taskOk('connection refused'), false);
});

test('log of a sync task: the group being copied, the result of each group', () => {
  const ts = '2026-10-18T04:00:01+02:00: ';
  assert.equal(lineGroup(`${ts}Syncing hlm-main/ds0/Hosts into ds9/Hosts`), null);
  assert.equal(lineGroup(`${ts}found 2 groups to sync (out of 9 total)`), null);
  assert.equal(lineGroup(`${ts}host/nextcloud-config/2026-10-18T00:30:02Z: start sync`), 'host/nextcloud-config');
  assert.equal(lineGroup('vm/100: skipped: 3 snapshot(s) (2026-10-01T00:00:00Z .. 2026-10-17T00:00:00Z) - older than the newest snapshot present on sync target'), 'vm/100');
  assert.equal(lineGroup(`${ts}re-sync snapshot ct/105/2026-10-17T01:00:00Z due to corruption`), 'ct/105');
  const lines = [`${ts}host/a/2026-10-18T00:30:00Z: sync done`, `${ts}sync group host/b failed - connection reset by peer`, `${ts}TASK ERROR: sync failed with some errors.`];
  const one = groupResults(lines, ['host/a', 'host/b'], 'sync failed with some errors.');
  assert.deepEqual(one.get('host/a'), { ok: true });
  assert.deepEqual(one.get('host/b'), { ok: false, error: 'connection reset by peer' });
  // failed with no group named (namespace missing on the secondary...): all failed
  const all = groupResults([`${ts}Cannot sync ds0/Hosts into ds9/Hosts - Creating Hosts not allowed`], ['host/a'], 'sync failed with some errors.');
  assert.deepEqual(all.get('host/a'), { ok: false, error: 'sync failed with some errors.' });
  assert.deepEqual(groupResults([], ['host/a'], 'OK').get('host/a'), { ok: true });
});

test('immediate copy: job id of a group, in the id format of the agent, apart from the jobs of the datastores', () => {
  const g = group('100', 'ds0', 'Vouille', 'vm');
  const id = adhocJobId(g);
  assert.match(id, ADHOC_RE);
  assert.ok(id.length <= 32);
  assert.equal(adhocJobId(g), id);
  assert.notEqual(adhocJobId(group('101', 'ds0', 'Vouille', 'vm')), id);
  assert.equal(ADHOC_RE.test(syncJobId('ds0', 'Vouille')), false);
  // reconciliation leaves it alone
  const plan = planSync(desiredJobs([g], remote), [{ id }, { id: syncJobId('ds0', 'Vouille') }]);
  assert.deepEqual(plan.remove, []);
});

test('groups of a sync job: the datastore job, or the immediate copy of one group', () => {
  const a = { ...group('100', 'ds0', 'Vouille', 'vm'), offsite: { enabled: true, jobId: 'hlm-ds0-Vouille', since: 0 } };
  const b = { ...group('101', 'ds0', 'Vouille', 'vm'), offsite: { enabled: true, jobId: 'hlm-ds0-Vouille', since: 0 } };
  assert.equal(groupsOf('hlm-ds0-Vouille', [a, b]).length, 2);
  assert.deepEqual(groupsOf(adhocJobId(b), [a, b]), [b]);
});

test('immediate copy: refused when not enabled, running, nothing verified or up to date', () => {
  const verified = { lastBackup: 2000, verify: 'ok' as const, times: [{ t: 2000, verify: 'ok' as const, size: 1 }] };
  const on = { enabled: true, jobId: 'hlm-ds0', since: 0 };
  assert.match(adhocBlocker({ ...verified, offsite: undefined }, null)!, /non activée/);
  assert.match(adhocBlocker({ ...verified, offsite: { ...on, running: { upid: 'u', start: 1, jobId: '' } } }, 'pending')!, /en cours/);
  assert.match(adhocBlocker({ lastBackup: 2000, verify: null, times: [], offsite: on }, 'pending')!, /vérifié/);
  assert.match(adhocBlocker({ ...verified, offsite: on }, 'ok')!, /à jour/);
  assert.equal(adhocBlocker({ ...verified, offsite: on }, 'pending'), null);
  assert.equal(adhocBlocker({ ...verified, offsite: on }, 'late'), null);
});

test('immediate copy: allowed to operators, not to viewers', () => {
  assert.equal(authorize('operator', 'POST', '/api/backups/:id/offsite/run'), true);
  assert.equal(authorize('viewer', 'POST', '/api/backups/:id/offsite/run'), false);
});
