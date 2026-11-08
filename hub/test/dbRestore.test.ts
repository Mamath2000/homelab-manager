import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { DB_ARCHIVE_RE, RESERVED, dbArchive, mountChecks, targetReason } from '../src/dbRestore.js';
import { jobDto } from '../src/jobs.js';
import { authorize } from '../src/profiles.js';
import type { HostDoc, JobDoc } from '../src/types.js';

test('dbArchive: pg-<base> and mongo-<base> dumps only', () => {
  assert.deepEqual(dbArchive('mongo-canicoif.pxar.didx'), { kind: 'mongodb', database: 'canicoif', supported: true });
  assert.deepEqual(dbArchive('pg-nextcloud.pxar.didx'), { kind: 'postgres', database: 'nextcloud', supported: true });
  // the roles dump is not a database
  assert.equal(dbArchive('pg-globals.pxar.didx'), null);
  // a physical copy of the cluster is not a database
  assert.equal(dbArchive('pg-cluster.pxar.didx'), null);
  for (const bad of ['root.pxar.didx', 'mongo-.pxar.didx', 'mongo-a b.pxar.didx', 'mongo-../x.pxar.didx', 'mongo-x.pxar.fidx', 'mongo-x.pxar.didx.blob', `mongo-${'a'.repeat(49)}.pxar.didx`]) {
    assert.equal(DB_ARCHIVE_RE.test(bad), false, bad);
    assert.equal(dbArchive(bad), null, bad);
  }
});

test('db_restore job: shown without credentials', () => {
  const job = {
    _id: new ObjectId(),
    hostId: new ObjectId(),
    hostName: 'dev-math',
    action: 'db_restore',
    packages: [],
    dbRestore: { kind: 'mongodb', source: 'canicoif', target: 'canicoif_copy', container: 'mongo' },
    trigger: 'manual',
    status: 'running',
    createdAt: new Date(0),
    log: '',
  } as JobDoc;
  const dto = jobDto(job);
  assert.deepEqual(dto.dbRestore, { kind: 'mongodb', source: 'canicoif', target: 'canicoif_copy', container: 'mongo' });
  assert.equal(JSON.stringify(dto).includes('password'), false);
});

test('db restore routes: admins only, reads included', () => {
  for (const route of ['/api/db-restore/targets', '/api/db-restore/:source/groups', '/api/db-restore/:source/snapshots']) {
    assert.equal(authorize('admin', 'GET', route), true);
    assert.equal(authorize('operator', 'GET', route), false);
    assert.equal(authorize('viewer', 'GET', route), false);
  }
  for (const [method, route] of [['POST', '/api/db-restore'], ['POST', '/api/db-restore/check']] as const) {
    assert.equal(authorize('admin', method, route), true);
    assert.equal(authorize('operator', method, route), false);
    assert.equal(authorize('viewer', method, route), false);
  }
});

test('target of a restore: every prerequisite, and why a host is left out', () => {
  const h = (capabilities: string[], osId = 'debian') => ({ name: 'lxc', capabilities, info: { osId, osName: 'Debian 13' } as HostDoc['info'] });
  const full = ['backup_database', 'db_restore', 'pbs_mount', 'backup', 'backup:native', 'mount_checks', 'mount_os', 'fuse', 'systemd'];
  assert.equal(targetReason(h(full)), null);
  assert.deepEqual(mountChecks(h(full)).os, { ok: true, note: 'Debian 13' });
  // an LXC without FUSE: the column says it, and the reason too
  const noFuse = full.filter((c) => c !== 'pbs_mount' && c !== 'fuse');
  assert.equal(mountChecks(h(noFuse)).fuse.ok, false);
  assert.match(targetReason(h(noFuse))!, /FUSE/);
  // no native client
  const docker = full.filter((c) => c !== 'pbs_mount' && c !== 'backup:native').concat('backup:docker');
  assert.equal(mountChecks(h(docker)).pbsClient.ok, false);
  assert.match(targetReason(h(docker))!, /APT/);
  // WSL / HAOS, systemd absent, Windows
  assert.match(mountChecks(h(['db_restore', 'mount_checks', 'systemd'])).os.note!, /WSL/);
  assert.equal(mountChecks(h(['db_restore', 'mount_checks', 'mount_os'])).os.note, 'systemd absent');
  assert.equal(mountChecks(h(['db_restore'], 'windows')).os.ok, false);
  // an older agent does not tell: unknown, not refused
  const old = mountChecks(h(['backup_database', 'db_restore']));
  assert.equal(old.os.ok, null);
  assert.equal(old.fuse.ok, null);
  assert.match(targetReason(h(['backup_database']))!, /à mettre à jour/);
});

test('system databases are never the name of the new database', () => {
  assert.deepEqual(RESERVED.postgres, ['postgres', 'template0', 'template1']);
  assert.deepEqual(RESERVED.mongodb, ['admin', 'local', 'config']);
});
