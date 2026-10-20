import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { ARCHIVE_RE, MOUNT_USER, mountAclPath, mountTokenId, mountable, normalizeMountRoot, slowLink, target } from '../src/pbsMount.js';
import { parseTokenId } from '../src/apiTokens.js';
import { dayOf, evaluate, mountStatus } from '../src/monitoring.js';
import { hostDto } from '../src/hostDto.js';
import { authorize } from '../src/roles.js';
import type { BackupDoc, HostDoc, PbsMount } from '../src/types.js';

const group = (o: Partial<BackupDoc> = {}) => ({ _id: 'ds0/Vouille/ct/101', store: 'ds0', ns: 'Vouille', type: 'ct', backupId: '101', ...o }) as BackupDoc;
const fp = Array(32).fill('ab').join(':');

const record = (o: Partial<PbsMount> = {}): PbsMount => ({
  state: 'mounted',
  source: 'main',
  link: { hostId: new ObjectId().toHexString(), mode: 'native' },
  groupId: 'ds0/Vouille/ct/101',
  label: 'nextcloud',
  store: 'ds0',
  ns: 'Vouille',
  type: 'ct',
  backupId: '101',
  time: Date.UTC(2026, 9, 19, 2, 30) / 1000,
  archive: 'root.pxar.didx',
  mountRoot: '/srv/pbs-restore',
  tokenId: mountTokenId(0),
  path: '/srv/pbs-restore/ct-101_2026-10-19_02-30-00_root',
  startedAt: new Date(0),
  ...o,
});

test('mountable: host and ct on the PBS; from the secondary, only the copied ones', () => {
  assert.equal(mountable(group(), 'main'), true);
  assert.equal(mountable(group({ type: 'host' }), 'main'), true);
  assert.equal(mountable(group({ type: 'vm' }), 'main'), false);
  assert.equal(mountable(group({ gone: true }), 'main'), false);
  assert.equal(mountable(group({ placeholder: true }), 'main'), false);
  assert.equal(mountable(group({ source: 'haos' }), 'main'), false);
  assert.equal(mountable(group(), 'offsite'), false);
  assert.equal(mountable(group({ offsite: { enabled: true, jobId: 'hlm-ds0-Vouille', since: 0 } }), 'offsite'), true);
  // copy disabled since: what was copied stays on the secondary
  assert.equal(mountable(group({ offsite: { enabled: false, jobId: 'hlm-ds0-Vouille', since: 0, lastBackup: 1 } as BackupDoc['offsite'] }), 'offsite'), true);
});

test('volatile token: its own user, unique name the agent accepts, read-only on the namespace of the group', () => {
  const id = mountTokenId(Date.UTC(2026, 9, 20));
  assert.deepEqual(parseTokenId(id, 'pbs')?.user, MOUNT_USER);
  // agent/pbs.go pbsTokenRe
  assert.match(parseTokenId(id, 'pbs')!.token, /^[A-Za-z][A-Za-z0-9._-]{0,31}$/);
  assert.notEqual(mountTokenId(1), mountTokenId(2));
  assert.equal(mountAclPath('ds0', 'Vouille'), '/datastore/ds0/Vouille');
  assert.equal(mountAclPath('ds1', ''), '/datastore/ds1');
});

test('archives: .pxar.didx only', () => {
  assert.match('root.pxar.didx', ARCHIVE_RE);
  assert.match('etc_homelab.pxar.didx', ARCHIVE_RE);
  for (const bad of ['drive-scsi0.img.fidx', 'root.mpxar.didx', 'index.json.blob', '../root.pxar.didx', 'a b.pxar.didx']) assert.doesNotMatch(bad, ARCHIVE_RE);
});

test('mount root: normalize configured absolute path', () => {
  assert.equal(normalizeMountRoot('/mnt/backups/restore/'), '/mnt/backups/restore');
  assert.equal(normalizeMountRoot('/mnt/backups/../restore'), '/mnt/restore');
  for (const invalid of ['', 'restore', '/', '/mnt/restore\nother']) assert.equal(normalizeMountRoot(invalid), null);
});

test('target: the address the host reaches the PBS at, with the pinned certificate', () => {
  const src = { url: 'https://192.168.100.20:8007', tailscaleUrl: 'https://100.80.1.2:8007', fingerprint: fp, label: 'PBS principal' };
  assert.deepEqual(target(src, { accessNetwork: 'lan' }), { server: '192.168.100.20', port: 8007, fingerprint: fp.toUpperCase() });
  assert.equal(target(src, { accessNetwork: 'tailscale' }).server, '100.80.1.2');
  assert.equal(target({ ...src, url: 'https://pbs2.lan' }, {}).port, 8007);
  assert.equal(target({ ...src, url: 'https://[fd00::2]:8008' }, {}).server, '[fd00::2]');
  assert.throws(() => target({ ...src, fingerprint: '' }, {}), /empreinte/);
});

test('slow link: the secondary, or another site than the PBS', () => {
  assert.equal(slowLink('main', { siteId: 'vouille' }, { siteId: 'vouille' }), false);
  assert.equal(slowLink('main', { siteId: 'jarsay' }, { siteId: 'vouille' }), true);
  assert.equal(slowLink('offsite', { siteId: 'canicoif' }, { siteId: 'canicoif' }), true);
});

test('monitoring: a mounted snapshot keeps the host in warning, until it is unmounted', () => {
  const h = (pbsMount?: PbsMount) => ({ _id: new ObjectId(), name: 'pve1', createdAt: new Date(), enrolledAt: new Date(), pbsMount }) as HostDoc;
  assert.equal(mountStatus(h()), null);
  const day = dayOf(mountStatus(h(record())));
  assert.equal(day?.level, 'warn');
  assert.match(day!.reasons[0], /nextcloud \(2026-10-19 02:30 UTC\) montée sous \/srv\/pbs-restore\/ct-101/);
  assert.match(dayOf(mountStatus(h(record({ state: 'unmounting', error: 'pve1 hors ligne' }))))!.reasons[0], /Démontage .* en attente : pve1 hors ligne/);
  assert.equal(evaluate(h(record()), { online: true, groups: [], now: 0, agentOutdated: false }).level, 'warn');
});

test('host DTO: the mount without the agent link', () => {
  const r = record();
  const dto = hostDto({ _id: new ObjectId(), name: 'pve1', createdAt: new Date(), pbsMount: r } as HostDoc);
  assert.equal(dto.pbsMount?.pbsHostId, r.link.hostId);
  assert.equal('link' in dto.pbsMount!, false);
});

test('roles: mounting and unmounting are for admins', () => {
  for (const route of ['/api/pbs-mount', '/api/pbs-mount/unmount']) {
    assert.equal(authorize('admin', 'POST', route), true);
    assert.equal(authorize('operator', 'POST', route), false);
    assert.equal(authorize('viewer', 'POST', route), false);
  }
});
