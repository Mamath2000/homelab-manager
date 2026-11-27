import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { copied } from '../src/offsite.js';
import { carriedSet, carryOf, computeChanges, movedGroups, nextcloudOnRemoved, pendingCount, pveOnRemoved, serverChangeOf, storesToGrant, type ChangeGroup } from '../src/pbsChanges.js';
import { offsiteStatus } from '../src/monitoring.js';
import { authorize } from '../src/profiles.js';
import type { BackupDoc } from '../src/types.js';

const hostA = new ObjectId();
const hostB = new ObjectId();
const g = (store: string, backupId: string, extra: Partial<ChangeGroup> = {}, ns = 'Hosts', type = 'host'): ChangeGroup => ({
  _id: `${store}/${ns}/${type}/${backupId}`,
  store,
  ns,
  type,
  backupId,
  hostId: null,
  lastBackup: 0,
  count: 1,
  ...extra,
});
const offsite = (enabled: boolean) => ({ enabled, jobId: 'hlm-ds3-Hosts', since: 1000, lastRun: { start: 1, end: 2, ok: false, error: 'no such datastore' } });

test('copy of a group: only while it is on the main PBS (#378)', () => {
  assert.equal(copied({ offsite: offsite(true) }), true);
  assert.equal(copied({ offsite: offsite(true), gone: true }), false);
  assert.equal(copied({ offsite: offsite(false) }), false);
  assert.equal(copied({ offsite: offsite(true), source: 'haos' }), false);
  // its follow-up says nothing about a gone group (the backup check says it is gone)
  const report = offsiteStatus({}, { online: true, now: Date.now(), groups: [{ ...g('ds3', 'web'), offsite: offsite(true), gone: true } as unknown as BackupDoc] });
  assert.equal(report, null);
});

test('moved groups: gone, one group alive elsewhere with the same namespace, type and id', () => {
  const groups = [
    g('ds3', 'web', { gone: true }),
    g('ds0', 'web'),
    g('ds1', 'db', { gone: true }), // nowhere
    g('ds2', 'nas', { gone: true }), // two candidates: not guessed
    g('ds0', 'nas'),
    g('ds4', 'nas'),
    g('ds3', 'web', { gone: true }, 'Vouille'), // another namespace: not the same backup
    g('ds3', 'ha', { gone: true, placeholder: true }), // placeholder: not on the PBS
  ];
  const { moved, vanished } = movedGroups(groups);
  assert.deepEqual(moved.map((m) => [m.from._id, m.to._id]), [['ds3/Hosts/host/web', 'ds0/Hosts/host/web']]);
  assert.deepEqual(vanished.map((v) => [v.group._id, v.candidates]), [
    ['ds1/Hosts/host/db', 0],
    ['ds2/Hosts/host/nas', 2],
    ['ds3/Vouille/host/web', 0],
  ]);
});

test('carried over: the host attached by hand, the threshold, the copy; never over what the new group has', () => {
  const from = g('ds3', 'web', { gone: true, hostId: hostA, staleHours: 48, offsite: offsite(true) });
  assert.deepEqual(carryOf(from, g('ds0', 'web')), { hostId: true, staleHours: true, offsite: true, conflict: null });
  // attached by a job (managed / vzdump): the job attaches the new group itself
  assert.equal(carryOf({ ...from, source: 'managed' }, g('ds0', 'web')).hostId, false);
  // the new group already has its settings
  const to = g('ds0', 'web', { hostId: hostB, staleHours: 12, offsite: offsite(true) });
  assert.deepEqual(carryOf(from, to), { hostId: false, staleHours: false, offsite: false, conflict: 'le nouveau groupe est rattaché à un autre hôte' });
  assert.equal(carryOf(from, { ...to, hostId: hostA }).conflict, null);

  const set = carriedSet(from, g('ds0', 'web'), carryOf(from, g('ds0', 'web')));
  assert.equal(set.hostId, hostA);
  assert.equal(set.staleHours, 48);
  // the copy goes on from the sync job of the new datastore, its history kept
  assert.equal(set.offsite?.enabled, true);
  assert.equal(set.offsite?.jobId, 'hlm-ds0-Hosts');
  assert.equal(set.offsite?.since, 1000);
  assert.equal(set.offsite?.error, null);
  assert.deepEqual(carriedSet(from, to, carryOf(from, to)), {});
});

test('jobs of Proxmox VE and the plugin Nextcloud on a datastore no longer there', () => {
  const stores = new Set(['ds0']);
  const job = (id: string, store: string | null) => ({ id, schedule: '', enabled: true, nextRun: null, storage: `pbs-${store}`, store, ns: 'Vouille' });
  const list = [
    { cluster: 'vouille', jobs: [job('backup-a', 'ds3'), job('backup-b', 'ds0')] },
    { cluster: 'vouille', jobs: [job('backup-a', 'ds3'), job('local', null)] },
  ];
  assert.deepEqual(pveOnRemoved(list, stores), [{ cluster: 'vouille', job: 'backup-a', storage: 'pbs-ds3', store: 'ds3', guests: 2 }]);
  assert.deepEqual(nextcloudOnRemoved({ database: 'ds1', config: 'ds0', users: [{ id: 'bob', store: 'ds2' }, { id: 'al', store: 'ds1' }] }, stores), ['ds1', 'ds2']);
  assert.deepEqual(nextcloudOnRemoved({ database: null, config: 'ds0', users: [] }, stores), []);
});

test('changes: removed datastores from what the hub still knows of them, nothing before a first poll', () => {
  const jobId = new ObjectId();
  const input = {
    stores: ['ds0'],
    groups: [g('ds3', 'web', { gone: true }), g('ds0', 'web'), g('ds1', 'db', { gone: true }), g('ds0', 'old', { gone: true })],
    jobs: [
      { _id: jobId, hostId: hostA, name: 'etc', store: 'ds2', ns: 'Hosts', backupId: 'srv' },
      { _id: new ObjectId(), hostId: hostA, name: 'ok', store: 'ds0', ns: 'Hosts', backupId: 'srv2' },
      // a job of the plugin is changed through the plugin
      { _id: new ObjectId(), hostId: hostB, name: 'nc', store: 'ds5', ns: 'Hosts', backupId: 'nextcloud-db', plugin: { name: 'nextcloud' as const, part: 'database' } },
    ],
    nextcloud: [{ hostId: hostB, plugin: { database: 'ds5', config: 'ds0', users: [] } }],
    guests: [],
  };
  const c = computeChanges(input);
  assert.deepEqual(c.removedStores, ['ds1', 'ds2', 'ds3', 'ds5']);
  assert.deepEqual(c.moved.map((m) => m.from._id), ['ds3/Hosts/host/web']);
  // gone in a datastore still there (pruned): vanished, its datastore not removed
  assert.deepEqual(c.vanished.map((v) => v.group._id), ['ds0/Hosts/host/old', 'ds1/Hosts/host/db']);
  assert.deepEqual(c.jobs.map((j) => j._id), [jobId]);
  assert.deepEqual(c.nextcloud, [{ hostId: hostB, stores: ['ds5'] }]);
  const none = computeChanges({ ...input, stores: [] });
  assert.equal(none.moved.length + none.vanished.length + none.jobs.length + none.removedStores.length, 0);
  assert.equal(pendingCount({ server: null, moved: [1, 2] as never, vanished: [], jobs: [1] as never, nextcloud: [], pve: [] }), 3);
});

test('rights of the tokens of the hosts: the new datastores, all of them when never set', () => {
  assert.deepEqual(storesToGrant(['ds0', 'ds1'], ['ds0']), ['ds1']);
  assert.deepEqual(storesToGrant(['ds0'], ['ds0', 'ds3']), []);
  assert.deepEqual(storesToGrant(['ds0', 'ds1'], undefined), ['ds0', 'ds1']);
});

test('server change: another agent or certificate, the first server kept until the admin answers', () => {
  const agent = { hostId: new ObjectId().toHexString(), mode: 'native' as const };
  const other = { hostId: new ObjectId().toHexString(), mode: 'native' as const };
  const before = { agent, url: 'https://pbs:8007', fingerprint: 'AA', tokenId: 'homelab@pbs!monitor' };
  assert.equal(serverChangeOf(before, { agent, fingerprint: 'AA' }), null);
  assert.equal(serverChangeOf({ ...before, url: '' }, { agent: other, fingerprint: 'AA' }), null);
  const byAgent = serverChangeOf(before, { agent: other, fingerprint: 'AA' });
  assert.deepEqual(byAgent?.from, before);
  assert.ok(serverChangeOf(before, { agent, fingerprint: 'BB' }));
  // already pending: unchanged
  assert.equal(serverChangeOf({ ...before, serverChange: byAgent }, { agent, fingerprint: 'CC' }), byAgent);
  // a fingerprint removed (system CAs) is not another server
  assert.equal(serverChangeOf(before, { agent, fingerprint: '' }), null);
});

test('changes of the PBS: read by every profile, applied by the admin only', () => {
  assert.equal(authorize('viewer', 'GET', '/api/backups/changes'), true);
  assert.equal(authorize('operator', 'POST', '/api/backups/changes'), false);
  assert.equal(authorize('viewer', 'POST', '/api/settings/pbs/server-change'), false);
  assert.equal(authorize('admin', 'POST', '/api/settings/pbs/server-change'), true);
});
