// Serveur de démonstration : sert web/dist et répond à /api/* avec des données fictives (aucune base, aucune vraie machine).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const DIST = process.env.DIST;
const PORT = Number(process.env.DEMO_PORT || 4173);
const NOW = Date.now();
const H = 3600e3, D = 24 * H;
const iso = (t) => new Date(t).toISOString();
const ago = (ms) => NOW - ms;

// ---------- catalogue ----------
const sites = [
  { id: 's1', name: 'Maison', kind: 'main', format: 'large', color: 'emerald' },
  { id: 's2', name: 'Résidence secondaire', kind: 'vpn', format: 'medium', color: 'sky' },
];
const tags = [
  { id: 't1', name: 'infra', color: 'blue' },
  { id: 't2', name: 'domotique', color: 'violet' },
  { id: 't3', name: 'docker', color: 'sky' },
  { id: 't4', name: 'média', color: 'amber' },
  { id: 't5', name: 'réseau', color: 'teal' },
];

// ---------- hôtes ----------
function pkgs(n, sec) {
  const names = ['openssl', 'libssl3', 'linux-image-amd64', 'curl', 'libc6', 'systemd', 'tzdata', 'ca-certificates', 'openssh-server', 'sudo', 'bash', 'nginx'];
  return Array.from({ length: n }, (_, i) => ({ name: names[i % names.length] + (i >= names.length ? `-${i}` : ''), current: '1.0.' + i, candidate: '1.0.' + (i + 1), repo: i < sec ? 'Debian-Security' : 'Debian', security: i < sec }));
}
function host(id, name, o) {
  const apt = o.apt ?? { n: 0, sec: 0 };
  return {
    id, name, siteId: o.site ?? 's1', tags: o.tags ?? [], createdAt: iso(ago(90 * D)), enrolledAt: iso(ago(89 * D)),
    lastSeenAt: iso(ago(o.online === false ? 3 * D : 20e3)), online: o.online !== false, roaming: false, critical: !!o.critical, haExcluded: false,
    haDetail: null, accessNetwork: 'lan', agentVersion: '1.4.2', agentAuth: 'cert', certIssuedAt: iso(ago(89 * D)), enrollExpiresAt: null,
    capabilities: ['apt', 'docker', 'reboot', 'backup', 'health', 'ping', ...(o.caps ?? [])], recentlyInstalled: [],
    agentOutdated: false, latestAgentVersion: '1.4.2',
    info: { hostname: name, osId: 'debian', osName: o.os ?? 'Debian GNU/Linux 12 (bookworm)', kernel: o.kernel ?? '6.1.0-28-amd64', arch: 'amd64', uptime: (o.up ?? 21) * 86400, ips: [o.ip], virt: o.virt ?? 'lxc', macs: o.macs ?? null },
    apt: o.apt === null ? null : { checkedAt: ago(2 * H), listsUpdatedAt: ago(5 * H), upgradable: pkgs(apt.n, apt.sec), held: [], rebootRequired: !!o.reboot, rebootPkgs: o.reboot ? ['linux-image-amd64'] : [], autoremovable: [] },
    aptSummary: o.apt === null ? null : { upgradable: apt.n, security: apt.sec, held: 0, rebootRequired: !!o.reboot, autoremovable: 0 },
    docker: o.docker ?? null, dockerSummary: o.docker ? dockerSummary(o.docker) : null,
    ups: null, health: o.health ?? null, smartDevices: [], setupOverrides: {}, setup: null,
    pve: o.pve ?? null, pveLost: null, pbsMount: null, roles: [], roleCandidates: null, osFamily: 'linux', backupClientPath: null, sessions: null, sessionSummary: null,
  };
}
function svc(name, image, state = 'running', update = 'uptodate', health) {
  return { name, image, containers: [{ id: name + '1', name, state, status: state === 'running' ? 'Up 12 days' : 'Exited (1) 2 hours ago', health, imageId: 'sha256:' + name }], update, localDigest: 'sha256:aa', remoteDigest: 'sha256:bb', checkError: null };
}
function stack(name, services, o = {}) {
  const running = services.filter((s) => s.containers[0].state === 'running').length;
  const updates = services.filter((s) => s.update === 'available').length;
  return { name, managed: true, workingDir: '/opt/stacks/' + name, configFiles: ['/opt/stacks/' + name + '/compose.yml'], envFiles: [], status: running === services.length ? 'running' : running ? 'partial' : 'stopped', services, running, total: services.length, update: updates ? 'available' : 'uptodate', updates, problems: o.problems ?? [] };
}
function dockerSummary(d) {
  return { stacks: d.stacks.length, running: d.stacks.filter((s) => s.status === 'running').length, partial: d.stacks.filter((s) => s.status === 'partial').length, stopped: 0, down: 0, updates: d.stacks.reduce((a, s) => a + s.updates, 0), problems: d.stacks.reduce((a, s) => a + s.problems.length, 0), unmanaged: 0 };
}
const dockerDemo = {
  engine: '27.3.1', compose: '2.29.7', checkedAt: ago(10 * 60e3), updatesCheckedAt: ago(3 * H),
  stacks: [
    stack('traefik', [svc('traefik', 'traefik:v3.1', 'running', 'uptodate', 'healthy')]),
    stack('nextcloud', [svc('app', 'nextcloud:29', 'running', 'available', 'healthy'), svc('db', 'postgres:16', 'running', 'uptodate', 'healthy'), svc('redis', 'redis:7', 'running')]),
    stack('vaultwarden', [svc('vaultwarden', 'vaultwarden/server:1.32', 'running', 'uptodate', 'healthy')]),
    stack('paperless', [svc('web', 'paperless-ngx:2.12', 'running', 'available'), svc('broker', 'redis:7', 'running')]),
  ],
};
const health = (cpu, mem, disk) => ({ system: { checkedAt: NOW, cpuPercent: cpu, memPercent: mem, memTotal: 8e9, memUsed: (8e9 * mem) / 100, load1: cpu / 40, load5: cpu / 50, load15: cpu / 55, cpuCount: 4 }, disks: { checkedAt: NOW, volumes: [{ device: '/dev/sda1', mountpoint: '/', fstype: 'ext4', total: 64e9, used: (64e9 * disk) / 100, percent: disk }] }, alerts: [] });

const pveLink = (vmid, type, name, covered = true) => ({ cluster: 'maison', vmid, type, node: 'pve1', name, covered });
const hosts = [
  host('h1', 'pve1', { ip: '192.168.10.10', tags: ['t1'], virt: 'none', apt: { n: 12, sec: 2 }, kernel: '6.8.12-4-pve', os: 'Debian GNU/Linux 12 (bookworm)', up: 44, critical: true, caps: ['pve'], health: health(18, 52, 41) }),
  host('h2', 'docker-01', { ip: '192.168.10.21', tags: ['t3', 't1'], apt: { n: 7, sec: 1 }, docker: dockerDemo, pve: pveLink(110, 'lxc', 'docker-01'), health: health(24, 61, 58), macs: ['bc:24:11:aa:10:21'] }),
  host('h3', 'pbs', { ip: '192.168.10.8', tags: ['t1'], apt: { n: 3, sec: 0 }, pve: pveLink(108, 'lxc', 'pbs'), caps: ['pbs'], health: health(6, 33, 74) }),
  host('h4', 'haos', { ip: '192.168.10.30', tags: ['t2'], apt: null, os: 'Home Assistant OS 14.0', virt: 'kvm', pve: pveLink(120, 'qemu', 'haos'), caps: ['ha_backups'], health: health(12, 44, 36) }),
  host('h5', 'pihole', { ip: '192.168.10.2', tags: ['t5'], apt: { n: 5, sec: 2 }, pve: pveLink(101, 'lxc', 'pihole'), health: health(3, 21, 30) }),
  host('h6', 'nas-media', { ip: '192.168.10.40', tags: ['t4'], apt: { n: 2, sec: 0 }, virt: 'none', health: health(9, 28, 83) }),
  host('h7', 'zigbee', { ip: '192.168.10.31', tags: ['t2'], apt: { n: 0, sec: 0 }, pve: pveLink(115, 'lxc', 'zigbee'), health: health(5, 25, 22) }),
  host('h8', 'vps-residence', { ip: '10.20.0.5', site: 's2', tags: ['t1'], apt: { n: 9, sec: 3 }, virt: 'kvm', reboot: true, health: health(14, 47, 52) }),
  host('h9', 'rpi-cave', { ip: '10.20.0.9', site: 's2', tags: ['t2'], apt: { n: 1, sec: 0 }, online: false, virt: 'none' }),
];
const byId = Object.fromEntries(hosts.map((h) => [h.id, h]));

// ---------- statut ----------
const ck = (key, label, level = 'ok', reason) => ({ key, label, level, ...(reason ? { reason } : {}) });
const dom = (level, checks = []) => ({ level, checks });
function hostStatus(h, extra = {}) {
  const domains = {};
  domains.system = h.online ? dom('ok', [ck('conn', 'Agent connecté')]) : dom('alert', [ck('conn', 'Agent hors ligne', 'alert', 'injoignable depuis 3 jours')]);
  if (h.aptSummary) {
    const s = h.aptSummary.security;
    domains.apt = s ? dom(s > 1 ? 'alert' : 'warn', [ck('sec', 'Correctifs de sécurité', s > 1 ? 'alert' : 'warn', `${s} correctif(s) de sécurité en attente`)]) : dom('ok', [ck('apt', 'À jour')]);
  }
  if (h.docker) domains.docker = dom('warn', h.docker.stacks.map((s) => ck('st-' + s.name, s.name, s.updates ? 'warn' : 'ok', s.updates ? 'image à mettre à jour' : undefined)));
  Object.assign(domains, extra);
  const levels = Object.values(domains).map((d) => d.level);
  return { level: levels.includes('alert') ? 'alert' : levels.includes('warn') ? 'warn' : 'ok', domains };
}
const bk = {
  h1: dom('warn', [ck('b-pve1', 'pve1 · répertoires /etc/pve', 'warn', 'en retard : dernière sauvegarde il y a 2 jours (seuil 26 h)')]),
  h2: dom('ok', [ck('b-d1', 'docker-01 · image PVE'), ck('b-d2', 'docker-01 · stacks')]),
  h3: dom('ok', [ck('b-p', 'pbs · image PVE')]),
  h4: dom('ok', [ck('b-h1', 'haos · image PVE'), ck('b-h2', 'Home Assistant · Local'), ck('b-h3', 'Home Assistant · SFTP')]),
  h5: dom('alert', [ck('b-pi', 'pihole · image PVE', 'alert', 'dernière exécution en échec : espace insuffisant sur le datastore')]),
  h7: dom('ok', [ck('b-z', 'zigbee · image PVE')]),
};
const sv = {
  h2: dom('ok', [ck('p1', 'Nextcloud'), ck('p2', 'Traefik')]),
  h7: dom('ok', [ck('p3', 'Zigbee2MQTT')]),
  h4: dom('ok', [ck('p4', 'Home Assistant')]),
  h5: dom('alert', [ck('p5', 'Pi-hole DNS', 'alert', 'connexion refusée')]),
};
const status = {
  domains: [
    { id: 'system', label: 'Connexion', icon: 'radio' }, { id: 'apt', label: 'Mises à jour', icon: 'package' }, { id: 'docker', label: 'Docker', icon: 'container' },
    { id: 'backup', label: 'Sauvegardes', icon: 'database-backup' }, { id: 'offsite', label: 'Copie externe', icon: 'cloud-upload' }, { id: 'ups', label: 'Onduleur', icon: 'battery-charging' },
    { id: 'mount', label: 'Montage PBS', icon: 'folder-open' }, { id: 'health', label: 'Santé', icon: 'activity' }, { id: 'services', label: 'Services', icon: 'globe' },
  ],
  hosts: Object.fromEntries(hosts.map((h) => [h.id, hostStatus(h, { ...(bk[h.id] ? { backup: bk[h.id] } : {}), ...(sv[h.id] ? { services: sv[h.id] } : {}) })])),
  equipments: {},
};

// ---------- équipements & sondes ----------
const equipments = [
  { id: 'e1', name: 'switch-salon', type: 'switch', siteId: 's1', ip: '192.168.10.3', source: 'manual', externalId: null, uplinkId: null, native: null, roles: [], createdAt: iso(ago(60 * D)), probes: [{ id: 'p10', name: 'Ping', state: 'up', message: null }] },
  { id: 'e2', name: 'ap-salon', type: 'ap', siteId: 's1', ip: '192.168.10.4', source: 'omada', externalId: 'AA-BB-CC-00-00-04', uplinkId: 'e1', native: { syncedAt: iso(ago(120e3)), checks: [ck('c', 'Connecté au contrôleur')] }, roles: [], createdAt: iso(ago(60 * D)), probes: [{ id: 'p11', name: 'Interface web', state: 'up', message: null }] },
  { id: 'e3', name: 'SLZB-06', type: 'coordinator', siteId: 's1', ip: '192.168.10.41', source: 'manual', externalId: null, uplinkId: 'e1', native: null, roles: [], createdAt: iso(ago(40 * D)), probes: [{ id: 'p12', name: 'Zigbee2MQTT', state: 'up', message: null }] },
  { id: 'e4', name: 'passerelle-maison', type: 'gateway', siteId: 's1', ip: '192.168.10.1', source: 'omada', externalId: 'AA-BB-CC-00-00-01', uplinkId: null, native: { syncedAt: iso(ago(120e3)), checks: [ck('c', 'Connecté au contrôleur'), ck('v', 'Tunnel maison ⇄ résidence')] }, roles: [], createdAt: iso(ago(60 * D)), probes: [{ id: 'p13', name: 'Tunnel VPN', state: 'up', message: null }] },
  { id: 'e5', name: 'esp-portail', type: 'iot', siteId: 's1', ip: '192.168.10.52', source: 'manual', externalId: null, uplinkId: 'e1', native: null, roles: [], createdAt: iso(ago(30 * D)), probes: [{ id: 'p14', name: 'ESPHome', state: 'down', message: 'aucun message depuis 10 min' }] },
];
for (const e of equipments) status.equipments[e.id] = (() => { const down = e.probes.some((p) => p.state === 'down'); return { level: down ? 'alert' : 'ok', domains: { services: dom(down ? 'alert' : 'ok', e.probes.map((p) => ck(p.id, p.name, p.state === 'down' ? 'alert' : 'ok', p.message ?? undefined))) } }; })();

const pr = (id, o) => ({ id, hostId: null, equipmentId: null, stack: null, runFrom: 'hub', intervalSec: 60, timeoutSec: 10, retries: 1, state: 'up', since: iso(ago(5 * D)), message: null, checkedAt: ago(30e3), latencyMs: 12, ...o });
const probes = [
  pr('p1', { hostId: 'h2', stack: 'nextcloud', name: 'Nextcloud', target: { type: 'http', url: 'https://cloud.exemple.fr/status.php', status: 200, keyword: 'installed' }, latencyMs: 84 }),
  pr('p2', { hostId: 'h2', stack: 'traefik', name: 'Traefik', target: { type: 'tcp', host: '192.168.10.21', port: 443 }, latencyMs: 3 }),
  pr('p3', { hostId: 'h7', name: 'Zigbee2MQTT', target: { type: 'mqtt', brokerId: 'r4', topic: 'zigbee2mqtt/bridge/state', contains: 'online' }, latencyMs: 40 }),
  pr('p4', { hostId: 'h4', name: 'Home Assistant', target: { type: 'http', url: 'http://192.168.10.30:8123', status: 200 }, latencyMs: 120 }),
  pr('p5', { hostId: 'h5', name: 'Pi-hole DNS', target: { type: 'tcp', host: '192.168.10.2', port: 53 }, state: 'down', since: iso(ago(3 * H)), message: 'connexion refusée', latencyMs: null }),
  pr('p6', { hostId: 'h8', name: 'Ping résidence → maison', target: { type: 'ping', host: '192.168.10.10' }, runFrom: { hostId: 'h8' }, latencyMs: 24 }),
  pr('p7', { hostId: 'h6', name: 'Jellyfin', target: { type: 'http', url: 'http://192.168.10.40:8096/health', status: 200 }, latencyMs: 31 }),
  pr('p10', { equipmentId: 'e1', name: 'Ping', target: { type: 'ping', host: '192.168.10.3' }, latencyMs: 1 }),
  pr('p11', { equipmentId: 'e2', name: 'Interface web', target: { type: 'http', url: 'https://192.168.10.4', insecure: true }, latencyMs: 60 }),
  pr('p12', { equipmentId: 'e3', name: 'Zigbee2MQTT', target: { type: 'mqtt', brokerId: 'r4', topic: 'zigbee2mqtt/bridge/state', contains: 'online' }, latencyMs: 40 }),
  pr('p13', { equipmentId: 'e4', name: 'Tunnel VPN', target: { type: 'vpn', roleId: 'r5', vpnId: 'v1', host: '10.20.0.5' }, runFrom: { hostId: 'h1' }, latencyMs: 22 }),
  pr('p14', { equipmentId: 'e5', name: 'ESPHome', target: { type: 'mqtt', brokerId: 'r4', topic: 'esp-portail/status', contains: 'online' }, state: 'down', since: iso(ago(10 * 60e3)), message: 'aucun message depuis 10 min', latencyMs: null }),
];
const probeDays = [];
for (const p of probes) for (let i = 29; i >= 0; i--) {
  const d = new Date(NOW - i * D).toISOString().slice(0, 10);
  const bad = (p.id === 'p5' && i === 0) || (p.id === 'p14' && i < 1) || (p.id === 'p4' && i === 9);
  probeDays.push({ probeId: p.id, day: d, up: bad ? 1300 : 1440, down: bad ? 140 : 0, unknown: 0 });
}
const probeRecent = probes.flatMap((p) => Array.from({ length: 30 }, (_, i) => ({ probeId: p.id, at: iso(NOW - (30 - i) * 120e3), state: p.state === 'down' && i > 22 ? 'down' : 'up' })));

// ---------- rôles ----------
const carrier = (id) => ({ kind: 'host', id, name: byId[id].name });
const connected = { state: 'connected', error: null };
const roles = [
  { id: 'r1', type: 'pbs-primary', name: 'PBS principal', carrier: carrier('h3'), hasSecret: true, url: 'https://192.168.10.8:8007', account: 'homelab@pbs!monitor', status: connected, summary: '2 datastores · 14 groupes · v3.2', uses: [], config: { url: 'https://192.168.10.8:8007', tailscaleUrl: '', mode: 'native', container: '' } },
  { id: 'r2', type: 'pve-cluster', name: 'maison', carrier: carrier('h1'), hasSecret: true, url: 'https://192.168.10.10:8006', account: 'homelab@pve!monitor', status: connected, summary: '1 nœud · 6 CT/VM · 3 jobs de sauvegarde', uses: [], config: { cluster: 'maison', url: 'https://192.168.10.10:8006', fingerprint: 'AB:CD:…:EF', tokenId: 'homelab@pve!monitor', polledAt: iso(ago(6 * 60e3)), guests: 6 } },
  { id: 'r4', type: 'mqtt-broker', name: 'Mosquitto maison', carrier: carrier('h7'), hasSecret: true, url: 'mqtt://192.168.10.31:1883', account: 'homelab', status: connected, summary: null, uses: ['3 sondes', 'pont Home Assistant'], config: { scheme: 'mqtt', port: 1883, address: null, username: 'homelab' } },
  { id: 'r5', type: 'omada-controller', name: 'Omada maison', carrier: carrier('h2'), hasSecret: true, url: 'https://192.168.10.21:8043', account: 'homelab', status: connected, summary: '2 sites · 4 appareils · 1 tunnel VPN', uses: [], config: { url: 'https://192.168.10.21:8043', fingerprint: 'AB:CD:…:EF', clientId: 'hlm' } },
];

// ---------- sauvegardes ----------
const SNAP = (nDays, hour, missing = [], size = 4e9) => Array.from({ length: nDays }, (_, i) => nDays - 1 - i).filter((i) => !missing.includes(i)).map((i) => {
  const d = new Date(NOW - i * D); d.setHours(hour, 5, 0, 0);
  return { t: d.getTime(), verify: i > 0 ? 'ok' : null, size: size * (0.95 + ((i * 7) % 10) / 100) };
}).reverse().reverse().sort((a, b) => a.t - b.t);
let nb = 0;
function grp(o) {
  const times = o.times ?? SNAP(30, 2);
  const last = times.length ? times[times.length - 1] : null;
  return {
    id: o.id ?? `g${++nb}`, store: 'pbs-main', ns: o.ns ?? 'Maison', type: o.type ?? 'ct', backupId: o.backupId, count: times.length, lastBackup: last?.t ?? 0, size: last?.size ?? null,
    verify: last?.verify ?? null, hostId: o.hostId, seenAt: iso(ago(6 * 60e3)), state: o.state ?? 'ok', times, threshold: o.threshold ?? 26, thresholdSource: o.thresholdSource ?? 'schedule', interval: D,
    source: o.source ?? 'vzdump', offsite: null, pve: o.pve ?? null, managed: o.managed ?? null, ha: o.ha ?? null, ...(o.rest ?? {}),
  };
}
const pveRef = (vmid, lastOk = true) => ({ cluster: 'maison', vmid, tz: 'Europe/Paris', jobs: [{ id: 'backup-daily', schedule: '02:00', scheduleText: 'tous les jours à 02:00', enabled: true, nextRun: NOW + 14 * H, storage: 'pbs-main', store: 'pbs-main', ns: 'Maison' }], lastTask: { upid: 'UPID:x', at: ago(20 * H), ok: lastOk, ...(lastOk ? {} : { error: 'espace insuffisant sur le datastore' }) } });
const managed = (name, sched = '03:00', txt = 'tous les jours à 03:00') => ({ jobId: 'j-' + name, name, tz: 'Europe/Paris', schedule: sched, scheduleText: txt, enabled: true, synced: true, lastRun: { at: ago(14 * H), ok: true }, kind: 'directories' });
const haDest = (id, auto, txt) => ({ agentId: 'h4', automatic: auto, scheduleText: txt, tz: 'Europe/Paris', next: NOW + 9 * H, lastAttempted: ago(15 * H), lastCompleted: ago(15 * H), failedAt: null, error: null });
const lateTimes = SNAP(30, 3).filter((s) => s.t < NOW - 2 * D);
const failTimes = SNAP(30, 2).filter((s) => s.t < NOW - 20 * H - D + 20 * H);
const groups = [
  grp({ backupId: '110', hostId: 'h2', pve: pveRef(110) }),
  grp({ backupId: 'docker-01-stacks', type: 'host', ns: 'Hosts', hostId: 'h2', source: 'managed', managed: managed('stacks'), times: SNAP(30, 3, [9]), thresholdSource: 'schedule' }),
  grp({ backupId: '108', hostId: 'h3', pve: pveRef(108) }),
  grp({ backupId: '120', type: 'vm', hostId: 'h4', pve: pveRef(120), times: SNAP(30, 2, [], 18e9) }),
  grp({ id: 'haos-local', backupId: 'haos/haos/local', type: 'host', ns: 'Home Assistant', store: 'Home Assistant', hostId: 'h4', source: 'haos', ha: haDest('local', true, 'tous les jours à 04:45'), times: SNAP(30, 4, [], 5e8), thresholdSource: 'schedule' }),
  grp({ id: 'haos-sftp', backupId: 'haos/haos/sftp', type: 'host', ns: 'Home Assistant', store: 'Home Assistant', hostId: 'h4', source: 'haos', ha: haDest('sftp', true, 'tous les jours à 04:45'), times: SNAP(30, 4, [], 5e8), thresholdSource: 'schedule' }),
  grp({ backupId: '101', hostId: 'h5', state: 'task_failed', pve: pveRef(101, false), times: failTimes, rest: {} }),
  grp({ backupId: 'pve1-etc', type: 'host', ns: 'Hosts', hostId: 'h1', source: 'managed', state: 'stale', managed: { ...managed('etc-pve', '03:00', 'tous les jours à 03:00'), lastRun: { at: ago(2 * D + 21 * H), ok: true } }, times: lateTimes, threshold: 26 }),
  grp({ backupId: '115', hostId: 'h7', pve: pveRef(115), times: SNAP(30, 2, [], 1.5e9) }),
  grp({ backupId: '130', hostId: null, state: 'ok', pve: pveRef(130), times: SNAP(30, 2, [3], 2e9) }),
];
const backups = {
  statsError: null, connected: true, offsite: null, polledAt: iso(ago(6 * 60e3)), pollError: null,
  datastores: [{ store: 'pbs-main', total: 2e12, used: 1.12e12, avail: 0.88e12 }, { store: 'archives', total: 4e12, used: 0.9e12, avail: 3.1e12 }],
  clusters: [{ id: 'maison', name: 'maison', polledAt: iso(ago(6 * 60e3)), pollError: null, guests: 6 }], groups, orphans: [], cached: [],
};
const backupStats = { days: Array.from({ length: 30 }, (_, i) => ({ day: Math.floor((NOW - (29 - i) * D) / D) * D, uploaded: (2 + ((i * 37) % 9)) * 1e9, duration: (900 + ((i * 53) % 700)) * 1000, count: 6, failed: i === 27 ? 1 : 0 })), groups: Object.fromEntries(groups.map((g) => [g.id, Array.from({ length: 30 }, (_, i) => ({ uploaded: 1e9 + (i % 5) * 3e8, duration: (200 + (i % 7) * 30) * 1000, failed: 0 }))])) };
const backupUsage = { main: { 'pbs-main': Array.from({ length: 30 }, (_, i) => ({ day: Math.floor((NOW - (29 - i) * D) / D) * D, used: 1.0e12 + i * 4e9, total: 2e12 })) }, offsite: [] };

// ---------- jobs, alertes ----------
const jobs = [
  { id: 'j1', hostId: 'h2', hostName: 'docker-01', action: 'apt_upgrade', packages: [], stack: null, service: null, modules: null, trigger: 'manual', status: 'success', createdAt: iso(ago(40 * 60e3)), finishedAt: iso(ago(38 * 60e3)), exitCode: 0, error: null },
  { id: 'j2', hostId: 'h2', hostName: 'docker-01', action: 'backup_run', packages: [], stack: null, service: null, modules: null, backupJobName: 'stacks', trigger: 'schedule', status: 'success', createdAt: iso(ago(14 * H)), finishedAt: iso(ago(14 * H - 90e3)), exitCode: 0, error: null },
  { id: 'j3', hostId: 'h5', hostName: 'pihole', action: 'apt_update', packages: [], stack: null, service: null, modules: null, trigger: 'schedule', status: 'success', createdAt: iso(ago(5 * H)), finishedAt: iso(ago(5 * H - 20e3)), exitCode: 0, error: null },
];
function alertDays(id) {
  const base = status.hosts[id] ?? status.equipments[id];
  return Array.from({ length: 30 }, (_, k) => {
    const i = 29 - k;
    const day = new Date(NOW - i * D).toISOString().slice(0, 10);
    const domains = {};
    for (const d of Object.keys(base.domains)) {
      let level = 'ok'; let reasons = [];
      if (i === 0) { level = base.domains[d].level === 'unknown' ? 'ok' : base.domains[d].level; reasons = base.domains[d].checks.filter((c) => c.reason).map((c) => c.reason); }
      else if (d === 'apt' && id !== 'h6' && i % 11 === 3) { level = 'warn'; reasons = ['mises à jour en attente']; }
      else if (d === 'backup' && id === 'h5' && i < 2) { level = 'alert'; reasons = ['dernière exécution en échec']; }
      else if (d === 'backup' && id === 'h1' && i < 2) { level = 'warn'; reasons = ['en retard']; }
      else if (d === 'system' && id === 'h9') { level = 'alert'; reasons = ['agent hors ligne']; }
      domains[d] = { level, reasons };
    }
    return { day, domains };
  });
}

// ---------- réponses ----------
const me = { username: 'admin', displayName: 'Mathieu', profile: 'admin', mustChangePassword: false, features: { standardisation: false }, channel: 'prod' };
const emptyJobsCfg = (hostId) => ({ jobs: [], client: { installed: true, method: 'apt' }, credential: null });

function route(method, url) {
  const u = new URL(url, 'http://x');
  const p = u.pathname;
  let m;
  if (p === '/api/auth/status') return { noAccounts: false, user: me };
  if (p === '/api/hosts' && method === 'GET') return hosts;
  if (p === '/api/hosts' && method === 'POST') return { host: { ...hosts[0], id: 'hnew', name: 'nouvel-hote', online: false, agentAuth: 'none', enrolledAt: null, enrollExpiresAt: iso(NOW + 24 * H) }, installCommand: 'curl -fsSLk --pinnedpubkey sha256//k3V9xq0cQ1m2Yp7sT8aZl5nWb4RuE6fJhD0gHiOpLwM= https://192.168.10.21:3443/install.sh | sh -s -- 7Hq2-9xKd-Pm4T', haosToken: 'eyJ1IjoiaHR0cHM6Ly8xOTIuMTY4LjEwLjIxOjM0NDMiLCJrIjoiazNWOXhxMGNRMW0ifQ==', expiresAt: iso(NOW + 24 * H) };
  if ((m = p.match(/^\/api\/hosts\/([^/]+)$/))) return byId[m[1]] ?? {};
  if ((m = p.match(/^\/api\/hosts\/([^/]+)\/alerts$/))) return { days: alertDays(m[1]) };
  if ((m = p.match(/^\/api\/equipments\/([^/]+)\/alerts$/))) return { days: alertDays(m[1]) };
  if ((m = p.match(/^\/api\/hosts\/([^/]+)\/jobs$/))) return jobs.filter((j) => j.hostId === m[1]);
  if ((m = p.match(/^\/api\/hosts\/([^/]+)\/probes$/))) return { probes: probes.filter((x) => x.hostId === m[1]) };
  if ((m = p.match(/^\/api\/equipments\/([^/]+)\/probes$/))) return { probes: probes.filter((x) => x.equipmentId === m[1]) };
  if ((m = p.match(/^\/api\/hosts\/([^/]+)\/health$/))) return { samples: [] };
  if ((m = p.match(/^\/api\/hosts\/([^/]+)\/backup-jobs$/))) return emptyJobsCfg(m[1]);
  if (p === '/api/alerts') return { days: hosts.flatMap((h) => alertDays(h.id).map((d) => ({ ...d, hostId: h.id }))), equipmentDays: equipments.flatMap((e) => alertDays(e.id).map((d) => ({ ...d, equipmentId: e.id }))) };
  if (p === '/api/status') return status;
  if (p === '/api/sites') return { sites };
  if (p === '/api/tags') return { tags };
  if (p === '/api/equipments') return { equipments };
  if ((m = p.match(/^\/api\/equipments\/([^/]+)$/))) return equipments.find((e) => e.id === m[1]) ?? {};
  if (p === '/api/probes') return { probes };
  if (p === '/api/probes/days') return { days: probeDays };
  if (p === '/api/probes/recent') return { measures: probeRecent };
  if (p === '/api/settings/mqtt-brokers') return { brokers: [{ id: 'r4', name: 'Mosquitto maison', url: 'mqtt://192.168.10.31:1883', username: 'homelab', hasPassword: true, hostId: 'h7', hostName: 'zigbee', status: connected, probes: 3 }] };
  if (p === '/api/roles') return { roles };
  if (p === '/api/jobs') return jobs;
  if (p === '/api/backups') return backups;
  if (p === '/api/backups/stats') return backupStats;
  if (p === '/api/backups/usage') return backupUsage;
  if (p === '/api/pbs-mount') return { mount: null, pending: null };
  if (p === '/api/settings/agents') return { autoUpdate: true, hubUrl: '', checkIntervalHours: 12, agentPort: 3443, tailscaleHub: '', binaries: [], tls: { agentUrl: 'https://192.168.10.21:3443', serverPin: 'k3V9xq0cQ1m2Yp7sT8aZl5nWb4RuE6fJhD0gHiOpLwM=', caFingerprint: 'AB:CD:12:34', upgradeCommand: null, uninstallCommand: null } };
  if (p === '/api/settings/homeassistant') return { enabled: false, brokerRoleId: 'r4', discoveryPrefix: 'homeassistant', publicUrl: '', detail: { level: 'standard' } };
  if (p === '/api/health/overview') return { hosts: [] };
  if (p === '/api/settings/health') return {};
  if (p === '/api/settings/pbs') return { configured: true };
  if (p === '/api/settings/pbs-remote') return { configured: false };
  if (p === '/api/settings/pve') return { clusters: [] };
  if (p === '/api/settings/pve/inventory') return { clusters: [] };
  if (p === '/api/settings/omada') return { controllers: [] };
  if (p === '/api/users') return [];
  if (p === '/api/events') return null; // SSE
  return undefined;
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.json': 'application/json' };
http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    if (req.url.startsWith('/api/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ok\n\n'); return; }
    let body = route(req.method, req.url);
    if (body === undefined) { console.error('[demo] route inconnue', req.method, req.url); res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.error('[demo] http://localhost:' + PORT));
