import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { backupAlerts } from '../src/homeassistant/alerts.js';
import { ROOT_ID, build } from '../src/homeassistant/discovery.js';
import { backupState, matchHost, mergeGroups, normalizeFingerprint } from '../src/pbs.js';
import { authorize } from '../src/roles.js';
import type { HostDoc } from '../src/types.js';

// shapes of /admin/datastore/{store}/groups and /snapshots (PBS 3.x)
const groups = [
  { 'backup-type': 'host', 'backup-id': 'pve-docker01', 'last-backup': 1760050800, 'backup-count': 14, owner: 'backup@pbs!hm', files: ['etc.pxar.didx'] },
  { 'backup-type': 'host', 'backup-id': 'pgsql_nextcloud', 'last-backup': 1759964400, 'backup-count': 7, owner: 'backup@pbs!hm' },
  { 'backup-type': 'ct', 'backup-id': '105', 'last-backup': 1760047200, 'backup-count': 3, comment: 'pihole' },
];
const snapshots = [
  { 'backup-type': 'host', 'backup-id': 'pve-docker01', 'backup-time': 1759964400, size: 100, verification: { state: 'ok', upid: 'x' } },
  { 'backup-type': 'host', 'backup-id': 'pve-docker01', 'backup-time': 1760050800, size: 120 },
  { 'backup-type': 'host', 'backup-id': 'pgsql_nextcloud', 'backup-time': 1759964400, size: 5000, verification: { state: 'failed', upid: 'y' } },
];

test('groups get the size and verification of their last snapshot', () => {
  const g = mergeGroups('ds3', 'Hosts', groups, snapshots);
  assert.equal(g.length, 3);
  assert.deepEqual(
    { id: g[0]._id, last: g[0].lastBackup, size: g[0].size, verify: g[0].verify, count: g[0].count },
    { id: 'ds3/Hosts/host/pve-docker01', last: 1760050800000, size: 120, verify: null, count: 14 },
  );
  assert.equal(g[1].verify, 'failed');
  assert.equal(g[2].size, null);
  assert.equal(g[2].comment, 'pihole');
});

test('groups are matched to hosts by name, hostname, host_xxx prefix, or guest notes', () => {
  const h = (name: string, hostname?: string) => ({ _id: new ObjectId(), name, info: hostname ? ({ hostname } as HostDoc['info']) : undefined });
  const docker = h('Docker 01', 'pve-docker01');
  const pg = h('pgsql');
  const pihole = h('pihole');
  const pg2 = h('pgsql_next');
  const list = [docker, pg, pihole, pg2];
  assert.equal(matchHost({ backupId: 'PVE-Docker01', type: 'host' }, list), docker._id);
  // pgsql_nextcloud is a database of the host pgsql; the longest name wins: pgsql_next over pgsql
  assert.equal(matchHost({ backupId: 'pgsql_nextcloud', type: 'host' }, list), pg._id);
  assert.equal(matchHost({ backupId: 'pgsql_next_db', type: 'host' }, list), pg2._id);
  assert.equal(matchHost({ backupId: 'pgsql_full', type: 'host' }, list), pg._id);
  assert.equal(matchHost({ backupId: '105', comment: 'pihole', type: 'ct' }, list), pihole._id);
  // notes are only used for guests: a host backup named otherwise stays without host
  assert.equal(matchHost({ backupId: 'nextcloud', comment: 'pihole', type: 'host' }, list), null);
  assert.equal(matchHost({ backupId: 'pgsqlx', type: 'host' }, list), null);
});

test('state: late after the threshold (own one first), failed verification, ignored, gone', () => {
  const now = Date.UTC(2026, 9, 11, 12);
  const b = { lastBackup: now - 25 * 3600_000, verify: null as 'ok' | 'failed' | null };
  assert.equal(backupState(b, 26, now), 'ok');
  assert.equal(backupState({ ...b, lastBackup: now - 27 * 3600_000 }, 26, now), 'stale');
  assert.equal(backupState({ ...b, lastBackup: now - 27 * 3600_000, staleHours: 24 * 8 }, 26, now), 'ok');
  assert.equal(backupState({ ...b, verify: 'failed' }, 26, now), 'failed');
  assert.equal(backupState({ ...b, verify: 'failed', ignored: true }, 26, now), 'ignored');
  assert.equal(backupState({ ...b, gone: true }, 26, now), 'gone');
});

test('alerts: late and failed groups, none for a roaming host away', () => {
  const now = Date.UTC(2026, 9, 11, 12);
  const list = [
    { backupId: 'a', state: 'stale', lastBackup: now - 3 * 86_400_000 },
    { backupId: 'b', state: 'failed', lastBackup: now },
    { backupId: 'c', state: 'ok', lastBackup: now },
  ];
  assert.deepEqual(backupAlerts(list, false, now).map((a) => a.message), ['a : pas de sauvegarde depuis 3 j', 'b : vérification en échec']);
  assert.deepEqual(backupAlerts(list, true, now).map((a) => a.message), ['b : vérification en échec']);
});

test('Home Assistant: one backup sub-device per host, root counts and datastore space', () => {
  const host = { _id: new ObjectId(), name: 'docker', createdAt: new Date() } as HostDoc;
  const hid = host._id.toHexString();
  const { devices } = build([{ host, online: true, busy: false }], {
    topic: 'hm',
    discoveryPrefix: 'homeassistant',
    version: '1',
    backups: {
      groups: [
        { id: '1', backupId: 'docker', hostId: hid, state: 'stale', lastBackup: Date.UTC(2026, 9, 8) },
        { id: '2', backupId: 'nextcloud', hostId: null, state: 'stale', lastBackup: Date.UTC(2026, 9, 8) },
        { id: '3', backupId: 'old', hostId: hid, state: 'ignored', lastBackup: 0 },
      ],
      datastores: [{ store: 'ds3', total: 1000, used: 250 }],
    },
  });
  const sub = devices.find((d) => d.id === `hm_${hid}_backup`)!;
  assert.ok(sub);
  const state = (dev: typeof sub, key: string) => dev.states.find(([t]) => t === `hm/${dev.id}/${key}/state`)?.[1];
  assert.equal(state(sub, 'late'), '1');
  assert.equal(state(sub, 'last_backup'), new Date(Date.UTC(2026, 9, 8)).toISOString());
  // the host rolls up its backup alert
  const hostDev = devices.find((d) => d.id === `hm_${hid}`)!;
  assert.match(hostDev.states.find(([t]) => t === `hm/hm_${hid}/alerts/attributes`)![1], /docker : pas de sauvegarde/);
  const root = devices.find((d) => d.id === ROOT_ID)!;
  assert.equal(state(root, 'backups_late'), '2');
  assert.equal(state(root, 'datastore_ds3'), '25');
  // the group without host is an alert of the root
  assert.match(root.states.find(([t]) => t === `hm/${ROOT_ID}/alerts/attributes`)![1], /nextcloud/);
  // without PBS: nothing about backups
  const none = build([{ host, online: true, busy: false }], { topic: 'hm', discoveryPrefix: 'homeassistant', version: '1' });
  assert.ok(!none.devices.some((d) => d.id.endsWith('_backup')));
});

test('fingerprints are normalised to upper case with colons', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(normalizeFingerprint(hex), 'AB:'.repeat(31) + 'AB');
  assert.equal(normalizeFingerprint('ab:'.repeat(31) + 'ab'), 'AB:'.repeat(31) + 'AB');
});

test('roles: settings admin only, every role reads the backups, operators refresh', () => {
  assert.ok(!authorize('operator', 'GET', '/api/settings/pbs'));
  assert.ok(authorize('viewer', 'GET', '/api/backups'));
  assert.ok(authorize('operator', 'POST', '/api/backups/refresh'));
  assert.ok(!authorize('viewer', 'POST', '/api/backups/refresh'));
  assert.ok(!authorize('operator', 'PATCH', '/api/backups/:id'));
  assert.ok(authorize('admin', 'PATCH', '/api/backups/:id'));
});
