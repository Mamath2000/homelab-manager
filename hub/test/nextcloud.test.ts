import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { buildSpec, checkDatabase, clientState, dumpArchives, heldBack, normDatabase } from '../src/backupJobs.js';
import { checkPlugin, planJobs, userBackupId, wantedJobs, type NextcloudDiscovery, type PluginInput } from '../src/nextcloud.js';
import type { BackupJobDoc, PbsSettings } from '../src/types.js';

const disco: NextcloudDiscovery = {
  containers: { nextcloud: 'nextcloud-aio-nextcloud', database: 'nextcloud-aio-database' },
  version: '31.0.9',
  database: 'nextcloud_database',
  dbSize: 1e9,
  dataDir: '/mnt/user/ncdata/data',
  configDir: '/var/lib/docker/volumes/nextcloud_aio_nextcloud/_data/config',
  instanceId: 'ochz3p5m7m1t',
  composeFiles: [],
  users: [
    { id: 'David', name: 'David', path: '/mnt/user/ncdata/data/David', exists: true },
    { id: 'mamath', name: 'Mamath', path: '/mnt/user/ncdata/data/mamath', exists: true },
    { id: 'newbie', name: 'Newbie', path: '/mnt/user/ncdata/data/newbie', exists: false },
    { id: '../x', name: 'bad', exists: false, error: 'identifiant inutilisable comme répertoire' },
  ],
  free: 1e12,
};

const input = (o: Partial<PluginInput> = {}): PluginInput => ({
  workDir: '/mnt/user/docker/nextcloud-aio/backup-homelab',
  keep: 2,
  schedule: '02:30',
  enabled: true,
  database: 'ds0',
  config: 'ds0',
  users: [
    { id: 'David', store: 'ds0' },
    { id: 'mamath', store: 'ds1' },
  ],
  ...o,
});

const hostId = new ObjectId();
const job = (o: Partial<BackupJobDoc>): BackupJobDoc => ({
  _id: new ObjectId(),
  hostId,
  name: 'x',
  archives: [],
  excludes: [],
  store: 'ds0',
  ns: 'Hosts',
  backupId: 'x',
  schedule: '03:00',
  timezone: 'Europe/Paris',
  enabled: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...o,
});

test('settings of the plugin are checked against what the agent found', () => {
  const stores = ['ds0', 'ds1', 'ds2', 'ds3'];
  assert.equal(checkPlugin(input(), disco, stores), null);
  assert.match(checkPlugin(input({ workDir: '/etc/x' }), disco, stores)!, /interdit/);
  assert.match(checkPlugin(input({ schedule: 'demain' }), disco, stores)!, /planification/);
  assert.match(checkPlugin(input({ database: null, config: null, users: [] }), disco, stores)!, /rien à sauvegarder/);
  assert.match(checkPlugin(input({ database: 'ds9' }), disco, stores)!, /datastore inconnu/);
  assert.match(checkPlugin(input({ users: [{ id: 'ghost', store: 'ds0' }] }), disco, stores)!, /inconnu de Nextcloud/);
  assert.match(checkPlugin(input({ users: [{ id: 'newbie', store: 'ds0' }] }), disco, stores)!, /pas encore de répertoire/);
  assert.match(checkPlugin(input({ users: [{ id: '../x', store: 'ds0' }] }), disco, stores)!, /inutilisable/);
  assert.match(checkPlugin(input({ users: [{ id: 'mamath', store: 'ds0' }, { id: 'mamath', store: 'ds1' }] }), disco, stores)!, /double/);
  // two ids, one group: David and david
  const twins = { ...disco, users: [...disco.users, { id: 'david', name: 'david', path: '/mnt/user/ncdata/data/david', exists: true }] };
  assert.match(checkPlugin(input({ users: [{ id: 'David', store: 'ds0' }, { id: 'david', store: 'ds0' }] }), twins, stores)!, /identifiant de sauvegarde/);
});

test('jobs asked for by the settings', () => {
  const w = wantedJobs(input(), disco);
  assert.deepEqual(
    w.map((j) => [j.part, j.backupId, j.store, j.kind]),
    [
      ['database', 'nextcloud-db', 'ds0', 'nextcloud'],
      ['config', 'nextcloud-config', 'ds0', 'nextcloud'],
      ['user:David', 'nextcloud-user-david', 'ds0', 'directories'],
      ['user:mamath', 'nextcloud-user-mamath', 'ds1', 'directories'],
    ],
  );
  // a work directory each: their histories of dumps stay apart
  assert.equal(w[0].database!.workDir, '/mnt/user/docker/nextcloud-aio/backup-homelab/database');
  assert.equal(w[1].database!.mode, 'config');
  assert.deepEqual(w[2].archives, [{ name: 'data', path: '/mnt/user/ncdata/data/David' }]);
  assert.equal(userBackupId('a.b@x y'), 'nextcloud-user-a.b-x-y');
});

test('jobs made by hand are taken over, plugin jobs no longer asked for are removed', () => {
  const hand = job({ name: 'nextcloud-user-david', archives: [{ name: 'david', path: '/mnt/user/ncdata/data/David' }], backupId: 'nextcloud-user-david', schedule: '02:30' });
  // two directories: not the directory of the user alone, left alone
  const other = job({ name: 'unraid-docker', archives: [{ name: 'a', path: '/mnt/user/ncdata/data/mamath' }, { name: 'b', path: '/boot' }], backupId: 'unraid-docker' });
  const db = job({ name: 'Nextcloud · base', kind: 'nextcloud', database: { mode: 'database', databases: [], workDir: '/old/database', keep: 1 }, backupId: 'nextcloud-db', plugin: { name: 'nextcloud', part: 'database' } });
  const gone = job({ name: 'Nextcloud · sam', archives: [{ name: 'data', path: '/mnt/user/ncdata/data/sam' }], backupId: 'nextcloud-user-sam', plugin: { name: 'nextcloud', part: 'user:sam' } });
  const plan = planJobs(hostId, input({ config: null }), disco, [hand, other, db, gone], 'Europe/Paris');

  assert.deepEqual(plan.update.map((u) => u.job._id), [db._id, hand._id]);
  const taken = plan.update[1].set;
  assert.deepEqual(taken.plugin, { name: 'nextcloud', part: 'user:David' });
  assert.equal(taken.schedule, '02:30');
  assert.equal(taken.backupId, undefined, 'the group of a job taken over does not change');
  assert.equal(plan.update[0].set.database!.workDir, '/mnt/user/docker/nextcloud-aio/backup-homelab/database');

  assert.deepEqual(plan.create.map((j) => [j.backupId, j.store, j.ns]), [['nextcloud-user-mamath', 'ds1', 'Hosts']]);
  assert.deepEqual(plan.remove.map((j) => j._id), [gone._id]);
});

test('nextcloud jobs: archives, checks, and held back from agents that do not know them', () => {
  const d = normDatabase('nextcloud', { mode: 'config', databases: ['x'], container: 'c', workDir: ' /w/config ', keep: 1 })!;
  assert.deepEqual(d, { mode: 'config', databases: [], workDir: '/w/config', keep: 1 });
  assert.deepEqual(dumpArchives('nextcloud', d).map((a) => a.path), ['/w/config/nc-config']);
  assert.deepEqual(dumpArchives('nextcloud', { ...d, mode: 'database' }).map((a) => a.name), ['pg-globals', 'pg-nextcloud']);
  assert.equal(checkDatabase('nextcloud', d), null);
  assert.match(checkDatabase('nextcloud', { ...d, mode: 'cluster' })!, /mode/);

  const nc = job({ kind: 'nextcloud', database: d, backupId: 'nextcloud-config', plugin: { name: 'nextcloud', part: 'config' } });
  // agent 0.3: database jobs but not this kind, it would refuse the whole definition
  assert.equal(heldBack({ capabilities: ['backup', 'backup_database'] }, nc), true);
  assert.equal(heldBack({ capabilities: ['backup', 'backup_database', 'backup_nextcloud'] }, nc), false);
  const pbs = { url: 'https://pbs.lo:8007', fingerprint: 'AB' } as PbsSettings;
  const host = { pbsCredential: { tokenId: 'u@pbs!t', tokenSecret: 's', updatedAt: new Date() }, capabilities: ['backup', 'backup_nextcloud'] };
  const spec = buildSpec(host, [nc], pbs);
  assert.deepEqual(spec.jobs[0], { id: nc._id.toHexString(), name: 'x', archives: [], excludes: [], store: 'ds0', ns: 'Hosts', backupId: 'nextcloud-config', schedule: '03:00', tz: 'Europe/Paris', enabled: true, kind: 'nextcloud', database: d });

  assert.equal(clientState(['backup_nextcloud', 'backup_database:nextcloud']).nextcloud, true);
  assert.equal(clientState(['backup_nextcloud']).nextcloud, false, 'instance not running on the host');
  // the generic form does not offer it
  assert.deepEqual(clientState(['backup_database', 'backup_database:nextcloud']).databases, []);
});
