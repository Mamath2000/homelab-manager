import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { mergeCache, remoteConfigured } from '../src/disconnect.js';
import { DEFAULT_REMOTE } from '../src/offsite.js';
import { pbsConnected } from '../src/pbs.js';
import type { CachedBackupJob } from '../src/types.js';

const job = (name: string, _id = new ObjectId()): CachedBackupJob => ({
  _id,
  name,
  archives: [{ name: 'home', path: '/home' }],
  excludes: [],
  store: 'ds0',
  ns: 'Hosts',
  backupId: name,
  schedule: '03:00',
  timezone: 'Europe/Paris',
  enabled: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

test('main PBS connected: address and monitoring token', () => {
  assert.equal(pbsConnected({ url: 'https://pbs:8007', tokenId: 'homelab@pbs!monitor', tokenSecret: 's' }), true);
  assert.equal(pbsConnected({ url: 'https://pbs:8007', tokenId: 'homelab@pbs!monitor', tokenSecret: '' }), false);
  assert.equal(pbsConnected({ url: '', tokenId: '', tokenSecret: '' }), false);
});

test('secondary configured: anything the hub set up there', () => {
  assert.equal(remoteConfigured(DEFAULT_REMOTE), false);
  assert.equal(remoteConfigured({ ...DEFAULT_REMOTE, url: 'https://pbs2:8007' }), true);
  assert.equal(remoteConfigured({ ...DEFAULT_REMOTE, readerTokenId: 'homelab@pbs!reader' }), true);
});

test('cache of a host: merged with the one of an earlier disconnection', () => {
  const at = new Date(1);
  const fresh = mergeCache(null, { tokenId: 'host-x@pbs!backup', jobs: [job('a')], nextcloud: null }, at);
  assert.deepEqual(fresh, { at, tokenId: 'host-x@pbs!backup', jobs: [job('a', fresh.jobs[0]._id)], nextcloud: null });
  // no token now: the one of before is kept; the same job, newer, replaces it; the others stay
  const same = fresh.jobs[0]._id;
  const old = { ...fresh, jobs: [...fresh.jobs, job('b')] };
  const m = mergeCache(old, { jobs: [{ ...job('a2', same) }], nextcloud: null }, at);
  assert.equal(m.tokenId, 'host-x@pbs!backup');
  assert.deepEqual(m.jobs.map((j) => j.name).sort(), ['a2', 'b']);
  // nothing before, nothing now: no token id
  assert.equal('tokenId' in mergeCache(undefined, { jobs: [], nextcloud: null }, at), false);
});
