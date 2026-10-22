import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { DOMAINS, aptStatus, backupStatus, dayOf, dockerStatus, evaluate, healthStatus, offsiteStatus, systemStatus, worst, type Context } from '../src/monitoring.js';
import type { AptReport, BackupDoc, DockerStack, HostDoc, Package } from '../src/types.js';
import { dockerHost } from './fixtures.js';

const H = 3600_000;
const now = Date.UTC(2026, 9, 15, 12);
const on = { online: true, now };
const off = { online: false, now };
const pkg = (name: string, security = false): Package => ({ name, current: '1', candidate: '2', repo: 'trixie', security });
const report = (o: Partial<AptReport> = {}): AptReport => ({ checkedAt: now, listsUpdatedAt: now - H, upgradable: [], held: [], rebootRequired: false, rebootPkgs: [], ...o });
const host = (o: Partial<HostDoc> = {}): HostDoc => ({ _id: new ObjectId(), name: 'h', createdAt: new Date(), enrolledAt: new Date(), ...o }) as HostDoc;
const group = (o: Partial<BackupDoc> = {}) => ({ _id: 'ds/ns/host/home', backupId: 'home', lastBackup: now - H, verify: null, gone: false, staleHours: 26, ...o }) as BackupDoc;

test('worst: the highest level wins, ok without any', () => {
  assert.equal(worst([]), 'ok');
  assert.equal(worst(['ok', 'warn']), 'warn');
  assert.equal(worst(['warn', 'alert', 'ok']), 'alert');
});

test('system: offline is a warning, an alert when critical; roaming away and pending are unknown', () => {
  assert.equal(systemStatus({}, { online: true }).level, 'ok');
  assert.deepEqual(dayOf(systemStatus(host(), { online: false })), { level: 'warn', reasons: ['Agent hors ligne'] });
  assert.equal(dayOf(systemStatus(host({ critical: true }), { online: false }))?.level, 'alert');
  assert.equal(systemStatus(host({ roaming: true }), { online: false }).level, 'unknown');
  assert.equal(systemStatus(host({ enrolledAt: undefined }), { online: false }).level, 'unknown');
  // a roaming host that is back is a host like the others
  assert.equal(systemStatus(host({ roaming: true }), { online: true }).level, 'ok');
});

test('APT: not applicable without a report, unknown offline, security first then the rest', () => {
  assert.equal(aptStatus({}, on), null);
  assert.equal(aptStatus({ apt: report() }, off)?.level, 'unknown');
  assert.deepEqual(dayOf(aptStatus({ apt: report() }, on)), { level: 'ok', reasons: [] });
  const sec = aptStatus({ apt: report({ upgradable: [pkg('curl', true), pkg('vim')], rebootRequired: true }) }, on);
  assert.equal(sec?.level, 'alert');
  assert.deepEqual(dayOf(sec)?.reasons, ['Mises à jour de sécurité : curl', 'Redémarrage requis', '1 paquet(s) à mettre à jour']);
  const warn = aptStatus({ apt: report({ upgradable: [pkg('vim')], rebootRequired: true, rebootPkgs: ['linux-image'], listsUpdatedAt: now - 3 * 24 * H }) }, on);
  assert.deepEqual(dayOf(warn), { level: 'warn', reasons: ['Redémarrage requis (linux-image)', '1 paquet(s) à mettre à jour', 'Listes de paquets périmées'] });
});

function stack(name: string, status: DockerStack['status'], states: string[], health?: string): DockerStack {
  return {
    name,
    workingDir: `/srv/${name}`,
    configFiles: [],
    envFiles: [],
    status,
    services: states.map((state, i) => ({ name: `s${i}`, image: `img${i}`, containers: [{ id: `${name}${i}`, name: `${name}-${i}`, state, status: '', imageId: 'img-current', health }] })),
  };
}

test('Docker: not applicable without Docker, unknown offline; a problem is an alert, an image update a warning', () => {
  assert.equal(dockerStatus({ ...dockerHost({}), capabilities: [], docker: undefined }, on), null);
  assert.equal(dockerStatus(dockerHost({ stacks: [stack('web', 'running', ['running'])] }), off)?.level, 'unknown');
  assert.deepEqual(dayOf(dockerStatus(dockerHost({ stacks: [stack('web', 'running', ['running'])] }), on)), { level: 'ok', reasons: [] });
  // stopped on purpose is not a problem
  assert.equal(dayOf(dockerStatus(dockerHost({ stacks: [stack('web', 'stopped', ['exited'])] }), on))?.level, 'ok');
  const updates = { checkedAt: now, images: [{ ref: 'img0', digest: 'new' }] };
  const r = {
    stacks: [stack('aio', 'running', ['running']), stack('web', 'running', ['running'])],
    images: [{ ref: 'img0', id: 'img-current', digest: 'old' }],
  };
  assert.deepEqual(dayOf(dockerStatus({ ...dockerHost(r, updates), unmanagedStacks: ['aio'] }, on)), { level: 'warn', reasons: ['web : 1 image(s) à mettre à jour'] });
  const bad = dockerStatus(dockerHost({ stacks: [stack('web', 'partial', ['running', 'exited']), stack('db', 'running', ['running'], 'unhealthy')] }), on);
  assert.equal(bad?.level, 'alert');
  assert.deepEqual(dayOf(bad)?.reasons, ['web : 1/2 conteneurs en marche', 'db : s0 : en mauvaise santé']);
  // unmanaged: its state is not followed
  assert.equal(dayOf(dockerStatus({ ...dockerHost({ stacks: [stack('aio', 'partial', ['running', 'exited'])] }), unmanagedStacks: ['aio'] }, on))?.level, 'ok');
});

test('backups: independent of the connection; failures are alerts, late ones warnings, ignored while a roaming host is away', () => {
  assert.equal(backupStatus({}, { ...on, groups: [] }), null);
  assert.deepEqual(dayOf(backupStatus({}, { ...off, groups: [group()] })), { level: 'ok', reasons: [] });
  assert.deepEqual(dayOf(backupStatus({}, { ...on, groups: [group({ comment: 'config', lastBackup: now - 30 * H })] })), { level: 'warn', reasons: ['config : en retard'] });
  const mixed = backupStatus({}, { ...on, groups: [group({ lastBackup: now - 30 * H }), group({ _id: 'x', backupId: 'db', verify: 'failed' })] });
  assert.deepEqual(dayOf(mixed), { level: 'alert', reasons: ['home : en retard', 'db : vérification en échec'] });
  assert.deepEqual(mixed?.checks.map((c) => [c.label, c.level]), [['home', 'warn'], ['db', 'alert']]);
  // a roaming host away cannot back up; a failure stays one
  const late = group({ lastBackup: now - 30 * H });
  assert.equal(dayOf(backupStatus({ roaming: true }, { ...off, groups: [late] }))?.level, 'ok');
  assert.equal(dayOf(backupStatus({ roaming: true }, { ...off, groups: [group({ verify: 'failed' })] }))?.level, 'alert');
});

test('offsite: only when a copy is enabled, and not counted in the backups', () => {
  const copied = group({ offsite: { enabled: true, jobId: 'j', since: 0, state: 'failed', lastRun: { start: 1, end: 2, ok: false } } });
  assert.equal(offsiteStatus({}, { ...on, groups: [group()] }), null);
  assert.equal(dayOf(offsiteStatus({}, { ...on, groups: [copied] }))?.level, 'alert');
  assert.equal(dayOf(backupStatus({}, { ...on, groups: [copied] }))?.level, 'ok');
});

test('offsite: a copy enabled but never made is a warning; a snapshot waiting after a first copy is not', () => {
  const o = (lastBackup?: number) => ({ enabled: true, jobId: 'j', since: now - H, state: 'pending' as const, lastBackup });
  const never = offsiteStatus({}, { ...on, groups: [group({ offsite: o() })] });
  assert.deepEqual(dayOf(never), { level: 'warn', reasons: ['home : pas encore copiée'] });
  assert.equal(dayOf(offsiteStatus({}, { ...on, groups: [group({ lastBackup: now - H, verify: 'ok', times: [{ t: now - H, verify: 'ok' }], offsite: o(now - 30 * H) })] }))?.level, 'ok');
});

test('host: worst of its known domains; unknown ones do not count; absent domains are missing', () => {
  const ctx = (c: Partial<Context> = {}): Context => ({ online: true, groups: [], now, ...c });
  const plain = evaluate(host(), ctx());
  assert.deepEqual(Object.keys(plain.domains), ['system']);
  assert.equal(plain.level, 'ok');
  // offline with an APT report: apt unknown, system warns
  const away = evaluate(host({ apt: report() }), ctx({ online: false }));
  assert.equal(away.domains.apt?.level, 'unknown');
  assert.equal(away.level, 'warn');
  // offline roaming: nothing known but the backups, which still count
  const roaming = evaluate(host({ roaming: true, apt: report() }), ctx({ online: false, groups: [group({ verify: 'failed' })] }));
  assert.equal(roaming.domains.system?.level, 'unknown');
  assert.equal(roaming.level, 'alert');
  assert.deepEqual(DOMAINS.map((d) => d.id), ['system', 'apt', 'docker', 'backup', 'offsite', 'ups', 'mount', 'health']);
});

test('health alerts are live checks and are unknown while the host is offline', () => {
  const snapshot = {
    system: { checkedAt: now, cpuPercent: 95, memPercent: 30, memUsed: 30, memTotal: 100 },
    alerts: [{ key: 'system:cpu', label: 'CPU', level: 'warn' as const, reason: 'CPU élevée' }],
  };
  assert.deepEqual(dayOf(healthStatus({ health: snapshot }, on)), { level: 'warn', reasons: ['CPU élevée'] });
  assert.equal(healthStatus({ health: snapshot }, off)?.level, 'unknown');
});
