import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { buildSpec, checkDatabase, checkJob, clientState, dumpArchives, dumpsOf, heldBack, jobArchives, jobDatabase, jobKind, normDatabase, pbsServer, runError, validPath, type JobInput } from '../src/backupJobs.js';
import { backupState } from '../src/pbs.js';
import { authorize } from '../src/roles.js';
import type { BackupDoc, BackupJobDoc, DatabaseDump, PbsSettings } from '../src/types.js';

const input = (o: Partial<JobInput> = {}): JobInput => ({
  name: 'home',
  archives: [{ name: 'home', path: '/home' }],
  excludes: ['**/.cache'],
  store: 'ds2',
  ns: 'Hosts',
  backupId: 'x4',
  schedule: '03:00',
  timezone: 'Europe/Paris',
  enabled: true,
  ...o,
});

test('paths of the directories: absolute, normalised, no ":"', () => {
  for (const p of ['/', '/home', '/mnt/user/appdata']) assert.ok(validPath(p), p);
  for (const p of ['home', '/home/', '/a/../b', '/a/./b', '/a//b', '/mnt/a:b']) assert.ok(!validPath(p), p);
});

test('job definitions are checked like the agent does', () => {
  assert.equal(checkJob(input(), true), null);
  assert.match(checkJob(input({ archives: [] }), true)!, /répertoire/);
  assert.match(checkJob(input({ archives: [{ name: 'a', path: '/a' }, { name: 'a', path: '/b' }] }), true)!, /double/);
  assert.match(checkJob(input({ archives: [{ name: 'home.pxar', path: '/home' }] }), true)!, /archive/);
  assert.match(checkJob(input({ schedule: '2026-10-11 03:00' }), true)!, /planification/);
  assert.match(checkJob(input({ backupId: '../x' }), true)!, /identifiant/);
  // the backup id is only checked at creation (fixed afterwards)
  assert.equal(checkJob(input({ backupId: undefined }), false), null);
  // the namespace is fixed: the token of a host only writes Hosts
  assert.match(checkJob(input({ ns: 'Vouille' }), true)!, /namespace/);
  assert.match(checkJob(input({ timezone: 'Mars/Olympus' }), true)!, /fuseau/);
});

const pbs = { url: 'https://192.168.100.8:8007', fingerprint: 'AB:CD', clientImage: 'mathmath350/pbs-client:4.0' } as PbsSettings;
const job: BackupJobDoc = {
  _id: new ObjectId(),
  hostId: new ObjectId(),
  name: 'home',
  archives: [{ name: 'home', path: '/home' }],
  excludes: [],
  store: 'ds2',
  ns: 'Hosts',
  backupId: 'x4',
  schedule: '03:00',
  timezone: 'Europe/Paris',
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const cred = { tokenId: 'host-x4@pbs!backup', tokenSecret: 's1', updatedAt: new Date() };

test('definition sent to the agent', () => {
  assert.equal(pbsServer({ url: 'https://pbs.lo' }), 'pbs.lo:8007');
  const spec = buildSpec({ pbsCredential: cred }, [job], pbs);
  assert.equal(spec.server, '192.168.100.8:8007');
  assert.equal(spec.jobs[0].tz, 'Europe/Paris');
  assert.equal(spec.image, 'mathmath350/pbs-client:4.0');
  // a new secret is a new definition
  assert.notEqual(buildSpec({ pbsCredential: { ...cred, tokenSecret: 's2' } }, [job], pbs).hash, spec.hash);
  assert.equal(buildSpec({ pbsCredential: cred }, [job], pbs).hash, spec.hash);
  // no token: nothing to run
  assert.deepEqual(buildSpec({}, [job], pbs).jobs, []);
});

const H = 3600_000;
test('state of a group written by a job of the hub', () => {
  const run = Date.UTC(2026, 9, 11, 1); // 03:00 Paris
  const g = (o: Partial<BackupDoc> = {}) =>
    ({ lastBackup: run + 60_000, verify: null, gone: false, managed: { jobId: 'j', name: 'home', tz: 'Europe/Paris', schedule: '03:00', enabled: true, synced: true }, ...o }) as BackupDoc;
  assert.equal(backupState(g(), run + 3 * H), 'ok');
  assert.equal(backupState(g({ lastBackup: run - 23 * H }), run + 3 * H), 'stale');
  assert.equal(backupState(g({ managed: { jobId: 'j', name: 'home', tz: 'Europe/Paris', schedule: '03:00', enabled: true, synced: false } }), run + 3 * H), 'not_synced');
  assert.equal(
    backupState(g({ lastBackup: run - 23 * H, managed: { jobId: 'j', name: 'home', tz: 'Europe/Paris', schedule: '03:00', enabled: true, synced: true, lastRun: { at: run + 600_000, ok: false, error: 'x' } } }), run + 3 * H),
    'task_failed',
  );
});

test('a job created after its last scheduled time is not late', () => {
  const run = Date.UTC(2026, 9, 11, 1); // 03:00 Paris
  const created = Date.UTC(2026, 9, 11, 17, 49);
  const g = { lastBackup: 0, verify: null, gone: false, managed: { jobId: 'j', name: 'home', tz: 'Europe/Paris', schedule: '03:00', enabled: true, synced: true, since: created } } as unknown as BackupDoc;
  assert.equal(backupState(g, created + H), 'ok');
  // the next day, its first run is expected
  assert.equal(backupState(g, run + 24 * H + 3 * H), 'stale');
});

test('running a backup job: operator; defining it: admin', () => {
  assert.equal(authorize('operator', 'POST', '/api/backup-jobs/:jobId/run'), true);
  assert.equal(authorize('operator', 'POST', '/api/hosts/:id/backup-jobs'), false);
  assert.equal(authorize('operator', 'PUT', '/api/hosts/:id/pbs-credential'), false);
  assert.equal(authorize('viewer', 'POST', '/api/backup-jobs/:jobId/run'), false);
  assert.equal(authorize('viewer', 'GET', '/api/hosts/:id/backup-jobs'), true);
});

test('API tokens created by a pasted command: what the hub asks for, admin only', async () => {
  const { parseTokenId, setupPlan } = await import('../src/tokenSetup.js');
  // the namespace Hosts of every datastore: the script applies the path to each one
  assert.deepEqual(setupPlan('host', { hostName: 'Canicoif PProd' }), {
    tool: 'pbs',
    user: 'host-canicoif-pprod@pbs',
    token: 'backup',
    path: '/datastore/{store}/Hosts',
    role: 'DatastoreBackup',
  });
  assert.equal(setupPlan('pve', {}).role, 'PVEAuditor');
  // another id when the default token already exists on the server
  assert.equal(setupPlan('pve', { tokenName: 'hlm2' }).token, 'hlm2');
  assert.deepEqual(parseTokenId('hlm@pve!backup2', 'pve'), { user: 'hlm@pve', token: 'backup2' });
  assert.equal(parseTokenId('hlm@pam!x', 'pve'), null);
  assert.equal(parseTokenId('hlm@pve!x', 'pbs'), null);
  assert.equal(parseTokenId('hlm@pbs!1x', 'pbs'), null);
  assert.equal(setupPlan('pbs', {}).path, '/datastore');
  assert.equal(authorize('operator', 'POST', '/api/settings/token-setups'), false);
  assert.equal(authorize('admin', 'POST', '/api/settings/token-setups'), true);
});

test('error of a failed run: the last "Error:" line of the client', () => {
  const log = "Starting backup: [Hosts]:host/x\nError: missing permissions 'Datastore.Backup' on '/datastore/ds0/Hosts'\n";
  assert.equal(runError({ ok: false, error: 'proxmox-backup-client a échoué (code 255)', log }), "missing permissions 'Datastore.Backup' on '/datastore/ds0/Hosts'");
  assert.equal(runError({ ok: false, error: 'docker pull failed', log: 'pulling\n' }), 'docker pull failed');
  assert.equal(runError({ ok: true, log }), null);
});

test('state of the PBS client of a host, from its capabilities', () => {
  assert.deepEqual(clientState(['backup_setup', 'backup_install:apt', 'backup_install:docker']), { mode: null, install: ['apt', 'docker'], databases: null, supported: true });
  assert.deepEqual(clientState(['backup_setup', 'backup', 'backup:docker', 'backup_install:apt']), { mode: 'docker', install: ['apt'], databases: null, supported: true });
  assert.deepEqual(clientState(['backup', 'backup:native']), { mode: 'native', install: [], databases: null, supported: true });
  assert.deepEqual(clientState(['apt_update']), { mode: null, install: [], databases: null, supported: false });
});

test('database settings are checked like the agent does', () => {
  const pg = (o: Partial<DatabaseDump> = {}): DatabaseDump => ({ mode: 'databases', databases: ['hass', 'hass-jarsay'], workDir: '/mnt/backup', keep: 1, ...o });
  const mongo = (o: Partial<DatabaseDump> = {}): DatabaseDump => ({ container: 'mongo', databases: ['canicoif'], workDir: '/home/mamath/dumps', keep: 0, ...o });
  assert.equal(checkDatabase('postgres', pg()), null);
  assert.equal(checkDatabase('postgres', pg({ mode: 'cluster', databases: [] })), null);
  assert.equal(checkDatabase('mongodb', mongo()), null);
  assert.match(checkDatabase('postgres', pg({ databases: [] }))!, /au moins une base/);
  assert.match(checkDatabase('postgres', pg({ mode: 'cluster' }))!, /cluster/);
  assert.match(checkDatabase('postgres', pg({ databases: ['a;b'] }))!, /nom de base/);
  assert.match(checkDatabase('postgres', pg({ databases: ['-x'] }))!, /nom de base/);
  assert.match(checkDatabase('postgres', pg({ databases: ['a', 'a'] }))!, /double/);
  assert.match(checkDatabase('postgres', pg({ container: 'pg' }))!, /local/);
  for (const w of ['/mnt', '/', 'mnt/backup', '/mnt/../etc', '/mnt/backup/', '/mnt/a:b']) assert.match(checkDatabase('postgres', pg({ workDir: w }))!, /répertoire de travail/, w);
  assert.match(checkDatabase('postgres', pg({ workDir: '/etc/backup' }))!, /interdit/);
  assert.match(checkDatabase('mongodb', mongo({ container: '-it' }))!, /conteneur/);
  assert.match(checkDatabase('mongodb', mongo({ databases: [] }))!, /au moins une base/);
  assert.match(checkDatabase('mongodb', mongo({ mode: 'cluster' }))!, /mode/);
  for (const keep of [-1, 31, 1.5]) assert.match(checkDatabase('postgres', pg({ keep }))!, /gardés/, String(keep));
});

test('a database job holds its dumps only, named like the agent does', () => {
  const d: DatabaseDump = { mode: 'databases', databases: ['hass'], workDir: '/mnt/backup', keep: 1 };
  assert.deepEqual(dumpArchives('postgres', d), [
    { name: 'pg-globals', path: '/mnt/backup/pg-globals' },
    { name: 'pg-hass', path: '/mnt/backup/pg-hass' },
  ]);
  assert.deepEqual(dumpArchives('postgres', { ...d, mode: 'cluster', databases: [] }), [{ name: 'pg-cluster', path: '/mnt/backup/pg-cluster' }]);
  assert.deepEqual(dumpArchives('mongodb', { container: 'mongo', databases: ['homelab'], workDir: '/srv/dumps', keep: 0 }), [{ name: 'mongo-homelab', path: '/srv/dumps/mongo-homelab' }]);
  const db = input({ kind: 'postgres', database: d, archives: [], excludes: [] });
  assert.equal(checkJob(db, true), null);
  assert.equal(jobArchives(db).length, 2);
  assert.match(checkJob({ ...db, archives: [{ name: 'home', path: '/home' }] }, true)!, /que ses dumps/);
  assert.match(checkJob({ ...db, excludes: ['x'] }, true)!, /que ses dumps/);
  assert.match(checkJob({ ...db, database: null }, true)!, /réglages/);
  assert.match(checkJob({ ...db, database: { ...d, workDir: '/etc/x' } }, true)!, /interdit/);
  // a directories job: no database settings
  assert.match(checkJob(input({ database: d }), true)!, /répertoires/);
});

test('first form of the database jobs (prepare, cleanup) read as kind + database', () => {
  const legacy = { prepare: { type: 'mongodb' as const, container: 'mongo', databases: ['db'], workDir: '/srv/d', cleanup: true } as never };
  assert.equal(jobKind(legacy), 'mongodb');
  assert.deepEqual(jobDatabase(legacy), { container: 'mongo', databases: ['db'], workDir: '/srv/d', keep: 0 });
  assert.equal(jobDatabase({ prepare: { type: 'mongodb', container: 'mongo', databases: ['db'], workDir: '/srv/d', cleanup: false } as never })!.keep, 1);
  assert.equal(jobKind({}), 'directories');
  assert.equal(jobDatabase({}), null);
  // only the fields of its kind
  assert.deepEqual(normDatabase('postgres', { mode: 'cluster', databases: [], workDir: '/mnt/b', keep: 2, container: 'x' }), { mode: 'cluster', databases: [], workDir: '/mnt/b', keep: 2 });
  assert.equal(normDatabase('directories', { databases: [], workDir: '/mnt/b', keep: 2 }), null);
});

test('a database job is held back from an agent that does not know them', () => {
  const pgJob: BackupJobDoc = { ...job, _id: new ObjectId(), backupId: 'pg', archives: [{ name: 'home', path: '/home' }], kind: 'postgres', database: { mode: 'cluster', databases: [], workDir: '/mnt/backup', keep: 3 } };
  const old = buildSpec({ pbsCredential: cred, capabilities: ['backup'] }, [job, pgJob], pbs);
  assert.deepEqual(old.jobs.map((j) => j.backupId), ['x4']);
  assert.ok(heldBack({ capabilities: ['backup'] }, pgJob));
  const cur = buildSpec({ pbsCredential: cred, capabilities: ['backup', 'backup_database'] }, [job, pgJob], pbs);
  assert.deepEqual(cur.jobs.map((j) => j.backupId), ['x4', 'pg']);
  assert.equal(cur.jobs[1].kind, 'postgres');
  assert.deepEqual(cur.jobs[1].database, pgJob.database);
  // its dumps only: stored directories are not sent
  assert.deepEqual(cur.jobs[1].archives, []);
  // directories jobs: definition (and hash) unchanged
  assert.ok(!('kind' in cur.jobs[0]));
  assert.equal(buildSpec({ pbsCredential: cred, capabilities: ['backup', 'backup_database'] }, [job], pbs).hash, buildSpec({ pbsCredential: cred }, [job], pbs).hash);
  assert.deepEqual(clientState(['backup', 'backup_database', 'backup_database:mongodb']).databases, ['mongodb']);
});
test('sizes of the dumps reported by the agent', () => {
  assert.deepEqual(dumpsOf([{ archive: 'mongo-db', database: 'db', dbSize: 1000, dumpSize: 300 }, { archive: 'pg-globals', dbSize: 0, dumpSize: 'x' }, { archive: '../x' }, null]), [
    { archive: 'mongo-db', database: 'db', dbSize: 1000, dumpSize: 300 },
    { archive: 'pg-globals', dbSize: 0, dumpSize: -1 },
  ]);
  assert.equal(dumpsOf(undefined), undefined);
  assert.equal(dumpsOf([]), undefined);
});
