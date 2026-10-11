import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { buildSpec, checkJob, pbsServer, validPath, type JobInput } from '../src/backupJobs.js';
import { backupState } from '../src/pbs.js';
import { authorize } from '../src/roles.js';
import type { BackupDoc, BackupJobDoc, PbsSettings } from '../src/types.js';

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
  assert.match(checkJob(input({ ns: '/Hosts' }), true)!, /namespace/);
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
  assert.equal(backupState(g(), 26, run + 3 * H), 'ok');
  assert.equal(backupState(g({ lastBackup: run - 23 * H }), 26, run + 3 * H), 'stale');
  assert.equal(backupState(g({ managed: { jobId: 'j', name: 'home', tz: 'Europe/Paris', schedule: '03:00', enabled: true, synced: false } }), 26, run + 3 * H), 'not_synced');
  assert.equal(
    backupState(g({ lastBackup: run - 23 * H, managed: { jobId: 'j', name: 'home', tz: 'Europe/Paris', schedule: '03:00', enabled: true, synced: true, lastRun: { at: run + 600_000, ok: false, error: 'x' } } }), 26, run + 3 * H),
    'task_failed',
  );
});

test('running a backup job: operator; defining it: admin', () => {
  assert.equal(authorize('operator', 'POST', '/api/backup-jobs/:jobId/run'), true);
  assert.equal(authorize('operator', 'POST', '/api/hosts/:id/backup-jobs'), false);
  assert.equal(authorize('operator', 'PUT', '/api/hosts/:id/pbs-credential'), false);
  assert.equal(authorize('viewer', 'POST', '/api/backup-jobs/:jobId/run'), false);
  assert.equal(authorize('viewer', 'GET', '/api/hosts/:id/backup-jobs'), true);
});

test('API tokens created by a pasted command: what the hub asks for, admin only', async () => {
  const { setupPlan } = await import('../src/tokenSetup.js');
  assert.deepEqual(setupPlan('host', { hostName: 'Canicoif PProd', store: 'ds2' }), {
    tool: 'pbs',
    user: 'host-canicoif-pprod@pbs',
    token: 'backup',
    path: '/datastore/ds2/Hosts',
    role: 'DatastoreBackup',
  });
  assert.equal(setupPlan('pve', {}).role, 'PVEAuditor');
  assert.equal(setupPlan('pbs', {}).path, '/datastore');
  assert.equal(authorize('operator', 'POST', '/api/settings/token-setups'), false);
  assert.equal(authorize('admin', 'POST', '/api/settings/token-setups'), true);
});
