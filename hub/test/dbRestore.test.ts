import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { DB_ARCHIVE_RE, dbArchive } from '../src/dbRestore.js';
import { jobDto } from '../src/jobs.js';
import { authorize } from '../src/profiles.js';
import type { JobDoc } from '../src/types.js';

test('dbArchive: pg-<base> and mongo-<base> dumps only', () => {
  assert.deepEqual(dbArchive('mongo-canicoif.pxar.didx'), { kind: 'mongodb', database: 'canicoif', supported: true });
  assert.deepEqual(dbArchive('pg-nextcloud.pxar.didx'), { kind: 'postgres', database: 'nextcloud', supported: false });
  // the roles dump is not a database
  assert.equal(dbArchive('pg-globals.pxar.didx'), null);
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

test('db restore routes: admins only', () => {
  for (const [method, route] of [['POST', '/api/db-restore'], ['POST', '/api/db-restore/check']] as const) {
    assert.equal(authorize('admin', method, route), true);
    assert.equal(authorize('operator', method, route), false);
    assert.equal(authorize('viewer', method, route), false);
  }
});
