import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { DOMAINS, aptStatus, backupStatus, dayOf, dockerStatus, evaluate, evaluateAll, haosUpdateStatus, healthStatus, offsiteStatus, servicesStatus, systemStatus, worst, type Context } from '../src/monitoring.js';
import type { AptReport, BackupDoc, DockerStack, HostDoc, Package, ProbeDoc, ProbeState } from '../src/types.js';
import { dockerHost } from './fixtures.js';

const H = 3600_000;
const now = Date.UTC(2026, 9, 15, 12);
const on = { online: true, now };
const off = { online: false, now };
const pkg = (name: string, security = false): Package => ({ name, current: '1', candidate: '2', repo: 'trixie', security });
const report = (o: Partial<AptReport> = {}): AptReport => ({ checkedAt: now, listsUpdatedAt: now - H, upgradable: [], held: [], rebootRequired: false, rebootPkgs: [], ...o });
const host = (o: Partial<HostDoc> = {}): HostDoc => ({ _id: new ObjectId(), name: 'h', createdAt: new Date(), enrolledAt: new Date(), ...o }) as HostDoc;
const group = (o: Partial<BackupDoc> = {}) => ({ _id: 'ds/ns/host/home', backupId: 'home', lastBackup: now - H, verify: null, gone: false, staleHours: 26, ...o }) as BackupDoc;

test('system: the certificate of the agent is a warning in its last 30 days, an alert once expired', () => {
  const day = 24 * H;
  const level = (left: number, online = true) => systemStatus(host({ certNotAfter: new Date(now + left) }), { online, now }).checks.find((c) => c.key === 'certificate')?.level;
  assert.equal(level(200 * day), 'ok');
  assert.equal(level(10 * day), 'warn');
  assert.equal(level(10 * day, false), 'warn');
  assert.equal(level(-day, false), 'alert');
  assert.match(dayOf(systemStatus(host({ certNotAfter: new Date(now - day) }), { online: false, now }))!.reasons.join(), /expiré/);
  // unknown (agent not connected since the update of the hub): no check
  assert.equal(systemStatus(host(), { online: true, now }).checks.some((c) => c.key === 'certificate'), false);
});

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

test('HAOS: not applicable outside HAOS, unknown offline; an OS or Core update is a warning, in the APT domain', () => {
  const info = (haos: NonNullable<HostDoc['info']>['haos']) => ({ hostname: 'ha', osId: 'haos', osName: 'Home Assistant OS', kernel: '', arch: 'amd64', uptime: 1, ips: [], virt: 'kvm', haos });
  assert.equal(haosUpdateStatus({}, on), null);
  const v = (current: string, latest: string) => ({ current, latest, available: current !== latest });
  const upToDate = info({ os: v('16.3', '16.3'), core: v('2026.11.1', '2026.11.1') });
  assert.equal(haosUpdateStatus({ info: upToDate }, off)?.level, 'unknown');
  assert.deepEqual(dayOf(haosUpdateStatus({ info: upToDate }, on)), { level: 'ok', reasons: [] });
  const both = haosUpdateStatus({ info: info({ os: v('16.2', '16.3'), core: v('2026.11.0', '2026.11.1') }) }, on);
  assert.deepEqual(dayOf(both), {
    level: 'warn',
    reasons: ['Home Assistant OS à mettre à jour : 16.2 → 16.3', 'Home Assistant Core à mettre à jour : 2026.11.0 → 2026.11.1'],
  });
  // the APT domain of a HAOS host carries them
  assert.equal(evaluate(host({ info: info({ core: v('2026.11.0', '2026.11.1') }) }), { ...on, groups: [] }).domains.apt?.level, 'warn');
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
  assert.deepEqual(DOMAINS.map((d) => d.id), ['system', 'apt', 'docker', 'backup', 'offsite', 'ups', 'mount', 'health', 'services']);
});

test('health alerts are live checks and are unknown while the host is offline', () => {
  const snapshot = {
    system: { checkedAt: now, cpuPercent: 95, memPercent: 30, memUsed: 30, memTotal: 100 },
    alerts: [{ key: 'system:cpu', label: 'CPU', level: 'warn' as const, reason: 'CPU élevée' }],
  };
  assert.deepEqual(dayOf(healthStatus({ health: snapshot }, on)), { level: 'warn', reasons: ['CPU élevée'] });
  assert.equal(healthStatus({ health: snapshot }, off)?.level, 'unknown');
});

const probe = (hostId: ObjectId, name: string, state?: ProbeState, message?: string, stack?: string): ProbeDoc =>
  ({ _id: new ObjectId(), subject: { kind: 'host', id: hostId, stack }, name, target: { type: 'ping', host: 'h' }, runFrom: 'hub', intervalSec: 60, timeoutSec: 10, retries: 0, state, message, createdAt: new Date() }) as ProbeDoc;

test('services: not applicable without probes; a down probe is an alert, an up one is ok', () => {
  const id = new ObjectId();
  assert.equal(servicesStatus({}, { online: true, probes: [] }), null);
  assert.equal(servicesStatus({}, { online: true }), null);
  const s = servicesStatus({}, { online: true, probes: [probe(id, 'DNS AdGuard', 'up'), probe(id, 'Bridge Zigbee2MQTT', 'down', 'payload « offline »', 'zigbee2mqtt')] });
  assert.equal(s?.level, 'alert');
  assert.deepEqual(dayOf(s), { level: 'alert', reasons: ['Bridge Zigbee2MQTT : payload « offline »'] });
  assert.deepEqual(s?.checks.map((c) => c.label), ['DNS AdGuard', 'zigbee2mqtt · Bridge Zigbee2MQTT']);
  assert.equal(dayOf(servicesStatus({}, { online: true, probes: [probe(id, 'a', 'up')] }))?.level, 'ok');
});

test('services: an offline host does not hide its probes', () => {
  const id = new ObjectId();
  const s = servicesStatus({}, { online: false, probes: [probe(id, 'Nextcloud', 'down', 'code 502')] });
  assert.equal(s?.level, 'alert');
  assert.equal(servicesStatus({}, { online: false, probes: [probe(id, 'Nextcloud', 'up')] })?.level, 'ok');
});

test('services: probes that cannot measure are unknown and never count; a roaming host away is unknown', () => {
  const id = new ObjectId();
  const none = servicesStatus({}, { online: true, probes: [probe(id, 'Chargeur VE', 'unknown', 'broker injoignable'), probe(id, 'Neuve')] });
  assert.equal(none?.level, 'unknown');
  assert.equal(dayOf(none), null);
  // the readable ones make the level, the others are only mentioned
  const mixed = servicesStatus({}, { online: true, probes: [probe(id, 'DNS', 'up'), probe(id, 'Chargeur VE', 'unknown')] });
  assert.equal(mixed?.level, 'ok');
  assert.equal(mixed?.reason, '1 sonde(s) non mesurée(s)');
  assert.equal(mixed?.checks.length, 1);
  const away = servicesStatus({ roaming: true }, { online: false, probes: [probe(id, 'DNS', 'down', 'x')] });
  assert.deepEqual([away?.level, away?.reason], ['unknown', 'Absent (itinérant)']);
  assert.equal(servicesStatus({ roaming: true }, { online: true, probes: [probe(id, 'DNS', 'down', 'x')] })?.level, 'alert');
});

test('evaluateAll: probes go to their host, a probe down makes the host an alert', () => {
  const a = host();
  const b = host();
  const out = evaluateAll([a, b], [], now, [probe(a._id, 'DNS', 'down', 'connexion refusée'), probe(b._id, 'DNS', 'up'), { ...probe(a._id, 'x', 'down'), subject: { kind: 'equipment', id: a._id } } as ProbeDoc]);
  assert.equal(out[a._id.toHexString()].domains.services?.checks.length, 1);
  assert.equal(out[a._id.toHexString()].level, 'alert');
  assert.equal(out[b._id.toHexString()].level, 'warn');
});
