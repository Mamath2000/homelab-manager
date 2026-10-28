import { ObjectId } from 'mongodb';
import { HEALTH_OVERRIDE_ENABLED_KEYS, HEALTH_OVERRIDE_NUMBER_KEYS } from './types.js';
import type { FastifyInstance } from 'fastify';
import { healthMetrics, hosts, settings } from './db.js';
import type { HealthCeph, HealthDisks, HealthMetricDoc, HealthRaid, HealthRaidArray, HealthRaidMember, HealthUnraid, HealthUnraidDisk, HealthUnraidPool, HealthSettings, HealthEnabled, HealthOverrides, HealthSmart, HealthSystem, HealthVolume, HealthSmartDisk, HostDoc } from './types.js';
import { parseId } from './db.js';
import { isOnline, sendToAgent } from './agents.js';
import { healthWithSilenced } from './healthSilence.js';
import { hostDto } from './hostDto.js';
import { publish } from './events.js';

export const DEFAULT_HEALTH_SETTINGS: HealthSettings = {
  _id: 'health',
  systemIntervalSeconds: 30,
  diskIntervalSeconds: 5 * 60,
  smartIntervalSeconds: 10 * 60,
  retentionHours: 48,
  cpuWarningThreshold: 75,
  cpuAlertThreshold: 90,
  memoryWarningThreshold: 80,
  memoryAlertThreshold: 90,
  diskWarningThreshold: 75,
  diskAlertThreshold: 90,
  smartTemperatureWarningThreshold: 60,
  smartTemperatureAlertThreshold: 70,
  smartWearWarningThreshold: 70,
  smartWearAlertThreshold: 85,
  systemSustainedMinutes: 5,
  smartSustainedMinutes: 0,
  loadWarningThreshold: 0.95,
  loadAlertThreshold: 1.2,
  loadSustainedMinutes: 10,
  diskRearmMinutes: 60,
};

export async function loadHealthSettings(): Promise<HealthSettings> {
  const stored = (await settings.findOne({ _id: 'health' })) as (Partial<HealthSettings> & Record<string, unknown>) | null;
  const legacyNumber = (key: string) => typeof stored?.[key] === 'number' ? stored[key] as number : undefined;
  const legacyAlert = (key: string, fallback: number) => Math.max(2, legacyNumber(key) ?? fallback);
  return {
    ...DEFAULT_HEALTH_SETTINGS,
    ...stored,
    cpuWarningThreshold: stored?.cpuWarningThreshold ?? Math.min(DEFAULT_HEALTH_SETTINGS.cpuWarningThreshold, legacyAlert('cpuThreshold', DEFAULT_HEALTH_SETTINGS.cpuAlertThreshold) - 1),
    cpuAlertThreshold: stored?.cpuAlertThreshold ?? legacyAlert('cpuThreshold', DEFAULT_HEALTH_SETTINGS.cpuAlertThreshold),
    memoryWarningThreshold: stored?.memoryWarningThreshold ?? Math.min(DEFAULT_HEALTH_SETTINGS.memoryWarningThreshold, legacyAlert('memoryThreshold', DEFAULT_HEALTH_SETTINGS.memoryAlertThreshold) - 1),
    memoryAlertThreshold: stored?.memoryAlertThreshold ?? legacyAlert('memoryThreshold', DEFAULT_HEALTH_SETTINGS.memoryAlertThreshold),
    diskWarningThreshold: stored?.diskWarningThreshold ?? Math.min(DEFAULT_HEALTH_SETTINGS.diskWarningThreshold, legacyAlert('diskThreshold', DEFAULT_HEALTH_SETTINGS.diskAlertThreshold) - 1),
    diskAlertThreshold: stored?.diskAlertThreshold ?? legacyAlert('diskThreshold', DEFAULT_HEALTH_SETTINGS.diskAlertThreshold),
    smartTemperatureWarningThreshold: stored?.smartTemperatureWarningThreshold ?? Math.min(DEFAULT_HEALTH_SETTINGS.smartTemperatureWarningThreshold, legacyAlert('smartTemperatureThreshold', DEFAULT_HEALTH_SETTINGS.smartTemperatureAlertThreshold) - 1),
    smartTemperatureAlertThreshold: stored?.smartTemperatureAlertThreshold ?? legacyAlert('smartTemperatureThreshold', DEFAULT_HEALTH_SETTINGS.smartTemperatureAlertThreshold),
    smartWearWarningThreshold: stored?.smartWearWarningThreshold ?? Math.min(DEFAULT_HEALTH_SETTINGS.smartWearWarningThreshold, legacyAlert('smartWearThreshold', DEFAULT_HEALTH_SETTINGS.smartWearAlertThreshold) - 1),
    smartWearAlertThreshold: stored?.smartWearAlertThreshold ?? legacyAlert('smartWearThreshold', DEFAULT_HEALTH_SETTINGS.smartWearAlertThreshold),
    systemSustainedMinutes: stored?.systemSustainedMinutes ?? legacyNumber('sustainedMinutes') ?? DEFAULT_HEALTH_SETTINGS.systemSustainedMinutes,
  };
}

// Effective settings of a host: the global ones, with the fields it overrides.
export function resolveHealthSettings(global: HealthSettings, overrides?: HealthOverrides): HealthSettings & Required<HealthEnabled> {
  return {
    ...global,
    cpuEnabled: true, memoryEnabled: true, loadEnabled: true, diskEnabled: true, smartTemperatureEnabled: true, smartWearEnabled: true,
    ...overrides,
  };
}

const THRESHOLD_PAIRS = [
  ['cpuWarningThreshold', 'cpuAlertThreshold'],
  ['memoryWarningThreshold', 'memoryAlertThreshold'],
  ['diskWarningThreshold', 'diskAlertThreshold'],
  ['smartTemperatureWarningThreshold', 'smartTemperatureAlertThreshold'],
  ['smartWearWarningThreshold', 'smartWearAlertThreshold'],
  ['loadWarningThreshold', 'loadAlertThreshold'],
] as const;

export const THRESHOLD_ORDER_ERROR = 'Le seuil warning doit être inférieur au seuil alerte.';
export function thresholdsInvalid(s: HealthSettings): boolean {
  return THRESHOLD_PAIRS.some(([warning, alert]) => s[warning] >= s[alert]);
}

export function isVirtualizedHealthHost(host: Pick<HostDoc, 'info'>): boolean {
  const virt = host.info?.virt?.trim().toLowerCase();
  return !!virt && virt !== 'none' && virt !== 'unknown';
}

// WSL shares the Windows disks: its volumes say nothing about the machine, so they are neither kept nor alerted on.
export function hasNoHealthDisks(host: Pick<HostDoc, 'info'>): boolean {
  return host.info?.virt?.trim().toLowerCase() === 'wsl';
}

// A container sees the block devices of its host in /sys: their md arrays are the host's, not its own.
const CONTAINER_VIRT = new Set(['lxc', 'lxc-libvirt', 'openvz', 'systemd-nspawn', 'docker', 'podman', 'rkt', 'wsl', 'proot', 'pouch']);
export function isContainerHealthHost(host: Pick<HostDoc, 'info'>): boolean {
  return CONTAINER_VIRT.has(host.info?.virt?.trim().toLowerCase() ?? '');
}

export async function healthConfigForHost(host: HostDoc) {
  const s = await loadHealthSettings();
  return {
    type: 'health_config',
    healthConfig: {
      systemIntervalSeconds: s.systemIntervalSeconds,
      diskIntervalSeconds: s.diskIntervalSeconds,
      smartIntervalSeconds: s.smartIntervalSeconds,
      smartDevices: isVirtualizedHealthHost(host) ? [] : host.smartDevices ?? [],
    },
  };
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const checkedAt = (v: unknown) => finite(v) && v >= Date.now() - 10 * 60_000 && v <= Date.now() + 60_000;

export function isHealthSystem(v: unknown): v is HealthSystem {
  if (!v || typeof v !== 'object') return false;
  const r = v as HealthSystem;
  return checkedAt(r.checkedAt) && finite(r.cpuPercent) && r.cpuPercent >= 0 && r.cpuPercent <= 100 &&
    finite(r.memPercent) && r.memPercent >= 0 && r.memPercent <= 100 &&
    finite(r.memUsed) && r.memUsed >= 0 && finite(r.memTotal) && r.memTotal > 0 &&
    [r.load1, r.load5, r.load15].every((n) => n === undefined || (finite(n) && n >= 0)) &&
    (r.cpuCount === undefined || (finite(r.cpuCount) && r.cpuCount > 0 && r.cpuCount <= 4096));
}

function isHealthVolume(v: unknown): v is HealthVolume {
  if (!v || typeof v !== 'object') return false;
  const d = v as HealthVolume;
  return typeof d.device === 'string' && d.device.length <= 512 &&
    typeof d.mountpoint === 'string' && d.mountpoint.length <= 1024 &&
    typeof d.fstype === 'string' && d.fstype.length <= 128 &&
    finite(d.used) && d.used >= 0 && finite(d.total) && d.total > 0 &&
    finite(d.percent) && d.percent >= 0 && d.percent <= 100;
}

export function isHealthDisks(v: unknown): v is HealthDisks {
  if (!v || typeof v !== 'object') return false;
  const r = v as HealthDisks;
  return checkedAt(r.checkedAt) && Array.isArray(r.volumes) && r.volumes.length <= 512 && r.volumes.every(isHealthVolume);
}

function isHealthSmartDisk(v: unknown): v is HealthSmartDisk {
  if (!v || typeof v !== 'object') return false;
  const d = v as HealthSmartDisk;
  return typeof d.device === 'string' && d.device.length <= 512 &&
    (d.model === undefined || (typeof d.model === 'string' && d.model.length <= 256)) &&
    (d.serial === undefined || (typeof d.serial === 'string' && d.serial.length <= 256)) &&
    (d.healthy === undefined || typeof d.healthy === 'boolean') &&
    (d.temperatureC === undefined || (finite(d.temperatureC) && d.temperatureC >= -50 && d.temperatureC <= 250)) &&
    (d.reallocated === undefined || (finite(d.reallocated) && d.reallocated >= 0)) &&
    (d.nvmeWearPercent === undefined || (finite(d.nvmeWearPercent) && d.nvmeWearPercent >= 0 && d.nvmeWearPercent <= 1000)) &&
    (d.standby === undefined || typeof d.standby === 'boolean') &&
    (d.error === undefined || (typeof d.error === 'string' && d.error.length <= 1024));
}

export function isHealthSmart(v: unknown): v is HealthSmart {
  if (!v || typeof v !== 'object') return false;
  const r = v as HealthSmart;
  return checkedAt(r.checkedAt) && Array.isArray(r.disks) && r.disks.length <= 32 && r.disks.every(isHealthSmartDisk);
}

const shortText = (v: unknown, max = 64) => typeof v === 'string' && v.length <= max;
const count = (v: unknown) => finite(v) && Number.isInteger(v) && v >= 0;

function isHealthRaidMember(v: unknown): v is HealthRaidMember {
  if (!v || typeof v !== 'object') return false;
  const m = v as HealthRaidMember;
  return shortText(m.device) && m.device.length > 0 && shortText(m.state, 256) && (m.slot === undefined || count(m.slot)) && count(m.errors);
}

function isHealthRaidArray(v: unknown): v is HealthRaidArray {
  if (!v || typeof v !== 'object') return false;
  const a = v as HealthRaidArray;
  return shortText(a.name) && a.name.length > 0 && shortText(a.level) && shortText(a.state) && shortText(a.syncAction) &&
    count(a.raidDisks) && count(a.degraded) && count(a.mismatchCount) &&
    (a.syncPercent === undefined || (finite(a.syncPercent) && a.syncPercent >= 0 && a.syncPercent <= 100)) &&
    Array.isArray(a.members) && a.members.length <= 64 && a.members.every(isHealthRaidMember);
}

const optional = <T>(v: T | undefined, ok: (v: T) => boolean) => v === undefined || ok(v);
const percent = (v: unknown) => finite(v) && v >= 0 && v <= 100;

function isHealthUnraidDisk(v: unknown): v is HealthUnraidDisk {
  if (!v || typeof v !== 'object') return false;
  const d = v as HealthUnraidDisk;
  return shortText(d.name) && d.name.length > 0 && shortText(d.type) && optional(d.device, (x) => shortText(x)) && shortText(d.status) &&
    count(d.errors) && optional(d.fsErrors, count);
}

function isHealthUnraidPool(v: unknown): v is HealthUnraidPool {
  if (!v || typeof v !== 'object') return false;
  const p = v as HealthUnraidPool;
  return shortText(p.name) && p.name.length > 0 && shortText(p.fsType) && optional(p.profile, (x) => shortText(x)) && optional(p.health, (x) => shortText(x)) &&
    count(p.devices) && count(p.devicesExpected) && Array.isArray(p.disks) && p.disks.length <= 64 && p.disks.every(isHealthUnraidDisk);
}

function isHealthUnraid(v: unknown): v is HealthUnraid {
  if (!v || typeof v !== 'object') return false;
  const u = v as HealthUnraid;
  const c = u.lastCheck;
  return shortText(u.state) && optional(u.syncAction, (x) => shortText(x)) && optional(u.syncPercent, percent) &&
    optional(c, (x) => !!x && typeof x === 'object' && count(x.startedAt) && optional(x.finishedAt, count) && count(x.errors) && finite(x.exit) && Number.isInteger(x.exit)) &&
    Array.isArray(u.disks) && u.disks.length <= 64 && u.disks.every(isHealthUnraidDisk) &&
    Array.isArray(u.pools) && u.pools.length <= 32 && u.pools.every(isHealthUnraidPool);
}

function isHealthCeph(v: unknown): v is HealthCeph {
  if (!v || typeof v !== 'object') return false;
  const c = v as HealthCeph;
  return optional(c.fsid, (x) => shortText(x)) && optional(c.status, (x) => shortText(x)) && optional(c.error, (x) => shortText(x, 512)) &&
    Array.isArray(c.checks) && c.checks.length <= 64 && c.checks.every((x) => !!x && typeof x === 'object' && shortText(x.code) && x.code.length > 0 &&
      shortText(x.severity) && shortText(x.message, 512) && typeof x.muted === 'boolean' &&
      Array.isArray(x.detail) && x.detail.length <= 10 && x.detail.every((d) => shortText(d, 512))) &&
    [c.osdsTotal, c.osdsUp, c.osdsIn, c.pgs, c.pgsClean, c.usedBytes, c.totalBytes].every(count) &&
    Array.isArray(c.osds) && c.osds.length <= 64 &&
    c.osds.every((o) => !!o && typeof o === 'object' && count(o.id) && shortText(o.name) && typeof o.up === 'boolean' && typeof o.in === 'boolean');
}

export function isHealthRaid(v: unknown): v is HealthRaid {
  if (!v || typeof v !== 'object') return false;
  const r = v as HealthRaid;
  return checkedAt(r.checkedAt) && Array.isArray(r.arrays) && r.arrays.length <= 32 && r.arrays.every(isHealthRaidArray) &&
    optional(r.unraid, isHealthUnraid) && optional(r.ceph, isHealthCeph);
}

// md states where the array no longer serves its data normally
const RAID_STOPPED_STATES = new Set(['inactive', 'readonly', 'broken', 'suspended', 'clear']);

// Alerts of the RAID report, immediate. The corrected read errors of a member are part of the key: accepting the warning
// accepts that count, a new error raises it again.
export function raidAlerts(report: HealthRaid) {
  const list: { key: string; label: string; level: 'warn' | 'alert'; reason: string }[] = [];
  for (const a of report.arrays) {
    const add = (key: string, level: 'warn' | 'alert', reason: string) => list.push({ key: `raid:${a.name}:${key}`, label: a.name, level, reason: `${a.name} : ${reason}` });
    if (a.degraded > 0) add('degraded', 'alert', `${a.level} dégradé, ${a.degraded} disque(s) manquant(s) sur ${a.raidDisks}`);
    if (RAID_STOPPED_STATES.has(a.state)) add('state', 'alert', `array ${a.state}`);
    else if (a.state === 'read-auto') add('state', 'warn', 'array en lecture seule (read-auto)');
    for (const m of a.members) {
      if (m.state.split(',').includes('faulty')) add(`member:${m.device}:faulty`, 'alert', `${m.device} en échec (faulty)`);
      if (m.errors > 0) add(`member:${m.device}:errors:${m.errors}`, 'warn', `${m.device} : ${m.errors} erreur(s) de lecture corrigée(s)`);
    }
    const progress = a.syncPercent !== undefined ? ` (${a.syncPercent.toFixed(1)} %)` : '';
    if (['resync', 'recover', 'reshape'].includes(a.syncAction)) add('sync', 'warn', `${a.syncAction} en cours${progress}`);
    // check / repair: the periodic scrub, shown but not alerted on; its mismatches are, once it is over
    else if (a.mismatchCount > 0 && a.syncAction === 'idle') add('mismatch', 'warn', `${a.mismatchCount} secteur(s) incohérent(s) au dernier contrôle`);
  }
  if (report.unraid) list.push(...unraidAlerts(report.unraid));
  if (report.ceph) list.push(...cephAlerts(report.ceph));
  return list;
}

// Unraid disk states other than DISK_OK (empty slots are left out by the agent)
const UNRAID_DISK_STATES: Record<string, string> = {
  DISK_DSBL: 'désactivé (émulé)', DISK_NP_DSBL: 'absent (émulé)', DISK_NP_MISSING: 'manquant', DISK_INVALID: 'invalide',
  DISK_WRONG: 'mauvais disque', DISK_DSBL_NEW: 'remplacé, à reconstruire', DISK_NEW: 'nouveau, pas encore intégré',
};

// Unraid array and pools. As for md, error counts are in the keys: an accepted warning comes back when the count rises.
// The last parity check is keyed by its start: accepting it accepts that check only.
export function unraidAlerts(u: HealthUnraid) {
  const list: { key: string; label: string; level: 'warn' | 'alert'; reason: string }[] = [];
  const add = (key: string, level: 'warn' | 'alert', reason: string) => list.push({ key: `raid:unraid:${key}`, label: 'Unraid', level, reason: `Unraid : ${reason}` });
  if (u.state !== 'STARTED') add('state', 'alert', `array ${u.state || 'inconnu'}`);
  const disk = (d: HealthUnraidDisk, where: string) => {
    if (d.status !== 'DISK_OK') add(`disk:${d.name}:status`, d.status === 'DISK_NEW' ? 'warn' : 'alert', `${where}${d.name} ${UNRAID_DISK_STATES[d.status] ?? d.status}`);
    if (d.errors > 0) add(`disk:${d.name}:errors:${d.errors}`, 'warn', `${where}${d.name} : ${d.errors} erreur(s) d'entrée-sortie`);
    if (d.fsErrors) add(`disk:${d.name}:fserrors:${d.fsErrors}`, 'warn', `${where}${d.name} : ${d.fsErrors} erreur(s) btrfs`);
  };
  for (const d of u.disks) disk(d, '');
  for (const p of u.pools) {
    if (p.devices < p.devicesExpected) add(`pool:${p.name}:missing`, 'alert', `pool ${p.name}, ${p.devicesExpected - p.devices} disque(s) manquant(s) sur ${p.devicesExpected}`);
    if (p.health && p.health !== 'ONLINE') add(`pool:${p.name}:health`, 'alert', `pool ${p.name} ${p.health}`);
    for (const d of p.disks) disk(d, `pool ${p.name}, `);
  }
  const progress = u.syncPercent !== undefined ? ` (${u.syncPercent.toFixed(1)} %)` : '';
  // the monthly parity check is shown, not alerted on; a rebuild is
  if (u.syncAction?.startsWith('recon')) add('sync', 'warn', `reconstruction en cours${progress}`);
  const c = u.lastCheck;
  if (c && !u.syncAction) {
    if (c.errors > 0) add(`lastcheck:${c.startedAt}:errors`, 'alert', `${c.errors} erreur(s) de parité au dernier contrôle`);
    else if (c.exit !== 0) add(`lastcheck:${c.startedAt}:exit`, 'warn', `dernier contrôle de parité interrompu (code ${c.exit})`);
  }
  return list;
}

// Ceph: the cluster-wide checks have the same keys on every node (acceptance shared by fsid), an OSD's on its node only.
export const isCephClusterKey = (key: string) => key === 'raid:ceph:unreachable' || key.startsWith('raid:ceph:check:');

// Acceptances of a host after (un)accepting keys; only the keys of its active alerts are accepted.
export function applySilence(current: HostDoc['healthSilenced'], alerts: NonNullable<HostDoc['health']>['alerts'], keys: string[], silenced: boolean) {
  const levels = new Map((alerts ?? []).map((a) => [a.key, a.level]));
  const next = (current ?? []).filter((s) => !keys.includes(s.key));
  if (silenced) for (const key of keys) if (levels.has(key)) next.push({ key, level: levels.get(key)! });
  return next;
}

export function cephAlerts(c: HealthCeph) {
  const list: { key: string; label: string; level: 'warn' | 'alert'; reason: string }[] = [];
  const add = (key: string, level: 'warn' | 'alert', reason: string) => list.push({ key: `raid:ceph:${key}`, label: 'Ceph', level, reason: `Ceph : ${reason}` });
  if (c.error) {
    add('unreachable', 'alert', `pas de réponse (${c.error})`);
    return list;
  }
  for (const x of c.checks) {
    if (x.muted || (x.severity !== 'HEALTH_WARN' && x.severity !== 'HEALTH_ERR')) continue;
    const detail = x.detail.length ? ` (${x.detail.join(' ; ')})` : '';
    add(`check:${x.code}`, x.severity === 'HEALTH_ERR' ? 'alert' : 'warn', `${x.message}${detail}`);
  }
  for (const o of c.osds) {
    if (!o.up) add(`${o.name}:down`, 'alert', `${o.name} arrêté (down)`);
    else if (!o.in) add(`${o.name}:out`, 'warn', `${o.name} sorti du cluster (out)`);
  }
  return list;
}

type HealthCategory = HealthMetricDoc['category'];
type HealthReport = HealthSystem | HealthDisks | HealthSmart | HealthRaid;
const pendingHostWrites = new Map<string, Promise<void>>();

export function healthMetricLevel(
  current: number,
  samples: { checkedAt: number; value: number }[],
  warning: number,
  alert: number,
  durationMinutes: number,
  intervalSeconds: number,
  now = Date.now(),
): 'warn' | 'alert' | undefined {
  const sustained = (threshold: number) => {
    if (durationMinutes === 0) return current >= threshold;
    const intervalMs = intervalSeconds * 1000;
    const cutoff = now - durationMinutes * 60_000;
    if (!samples.length || samples[samples.length - 1].checkedAt < now - intervalMs * 2) return false;
    let start = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].value < threshold) start = i + 1;
    }
    const high = samples.slice(start);
    if (!high.length || high[0].checkedAt > cutoff) return false;
    for (let i = 1; i < high.length; i++) {
      if (high[i].checkedAt - high[i - 1].checkedAt > intervalMs * 2) return false;
    }
    return true;
  };
  // no hysteresis: a level is lifted as soon as the value is back under its threshold
  if (sustained(alert)) return 'alert';
  if (sustained(warning)) return 'warn';
  return undefined;
}

type AlertLevel = 'warn' | 'alert';
export type HealthRearm = { key: string; level: AlertLevel; at: number };
const LEVEL_RANK: Record<AlertLevel, number> = { warn: 1, alert: 2 };

// After an alert was lifted, the same level (or a lower one) stays silent for `rearmMinutes`; a higher level is raised at once.
function rearmSuppresses(rearm: HealthRearm[] | undefined, key: string, level: AlertLevel, rearmMinutes: number, now: number): boolean {
  const r = rearm?.find((x) => x.key === key);
  return !!r && now - r.at < rearmMinutes * 60_000 && LEVEL_RANK[level] <= LEVEL_RANK[r.level];
}

// Rearm records after a report: the alerts that just disappeared start a delay, those raised again (or expired) end theirs.
export function nextRearm(previous: HealthRearm[] | undefined, oldAlerts: { key: string; level: AlertLevel }[], newAlerts: { key: string }[], rearmMinutes: number, now = Date.now()): HealthRearm[] {
  const lifted = oldAlerts.filter((a) => !newAlerts.some((n) => n.key === a.key)).map((a) => ({ key: a.key, level: a.level, at: now }));
  const kept = (previous ?? []).filter((r) => now - r.at < rearmMinutes * 60_000 && !newAlerts.some((n) => n.key === r.key) && !lifted.some((l) => l.key === r.key));
  return rearmMinutes > 0 ? [...kept, ...lifted] : [];
}

export function reportAlerts(h: HostDoc, category: HealthCategory, report: HealthReport, settings: HealthSettings & HealthEnabled, samples: HealthReport[] = []) {
  const old = h.health?.alerts ?? [];
  const retained = old.filter((a) => !a.key.startsWith(`${category}:`));
  const next: NonNullable<HostDoc['health']>['alerts'] = [];
  const alert = (key: string, label: string, reason: string, level: 'warn' | 'alert' = 'warn') => next.push({ key: `${category}:${key}`, label, level, reason });

  if (category === 'system') {
    const r = report as HealthSystem;
    const addSystemMetric = (key: 'cpu' | 'memory', label: string, field: 'cpuPercent' | 'memPercent', value: number, warning: number, critical: number) => {
      const level = healthMetricLevel(
        value,
        samples.filter((sample): sample is HealthSystem => 'cpuPercent' in sample).map((sample) => ({ checkedAt: sample.checkedAt, value: sample[field] })),
        warning,
        critical,
        settings.systemSustainedMinutes,
        settings.systemIntervalSeconds,
      );
      if (level) alert(key, label, `${label} à ${value.toFixed(1)} % (warning ${warning} %, alerte ${critical} %, durée ${settings.systemSustainedMinutes} min)`, level);
    };
    if (settings.cpuEnabled !== false) addSystemMetric('cpu', 'CPU', 'cpuPercent', r.cpuPercent, settings.cpuWarningThreshold, settings.cpuAlertThreshold);
    if (settings.memoryEnabled !== false) addSystemMetric('memory', 'Mémoire', 'memPercent', r.memPercent, settings.memoryWarningThreshold, settings.memoryAlertThreshold);
    // A container reads its host's load average: the ratio to its own CPUs says nothing, so it is only coloured, never alerted.
    if (settings.loadEnabled !== false && r.load5 !== undefined && r.cpuCount && !isContainerHealthHost(h)) {
      const ratio = r.load5 / r.cpuCount;
      const values = samples
        .filter((sample): sample is HealthSystem => 'cpuPercent' in sample && sample.load5 !== undefined && !!sample.cpuCount)
        .map((sample) => ({ checkedAt: sample.checkedAt, value: sample.load5! / sample.cpuCount! }));
      const { loadWarningThreshold: warning, loadAlertThreshold: critical, loadSustainedMinutes: minutes } = settings;
      const level = healthMetricLevel(ratio, values, warning, critical, minutes, settings.systemIntervalSeconds);
      if (level) alert('load', 'Charge', `Charge 5 min ${r.load5.toFixed(2)} pour ${Number(r.cpuCount.toFixed(1))} CPU (ratio ${ratio.toFixed(2)} ; warning ${warning}, alerte ${critical}, ${minutes ? `durée ${minutes} min` : 'déclenchement immédiat'})`, level);
    }
  } else if (category === 'disks') {
    if (settings.diskEnabled !== false) for (const v of (report as HealthDisks).volumes) {
      const key = `disks:volume:${v.mountpoint}`;
      const values = samples.filter((sample): sample is HealthDisks => 'volumes' in sample)
        .flatMap((sample) => sample.volumes.filter((volume) => volume.mountpoint === v.mountpoint).map((volume) => ({ checkedAt: sample.checkedAt, value: volume.percent })));
      const level = healthMetricLevel(v.percent, values, settings.diskWarningThreshold, settings.diskAlertThreshold, 0, settings.diskIntervalSeconds);
      // a level still active is never delayed (only the one raised again after being lifted is)
      if (!level || (!old.some((a) => a.key === key) && rearmSuppresses(h.health?.rearm, key, level, settings.diskRearmMinutes, report.checkedAt))) continue;
      alert(`volume:${v.mountpoint}`, v.mountpoint, `${v.mountpoint} utilisé à ${v.percent.toFixed(1)} % (warning ${settings.diskWarningThreshold} %, alerte ${settings.diskAlertThreshold} %, déclenchement immédiat${settings.diskRearmMinutes ? `, réactivation ${settings.diskRearmMinutes} min après la levée` : ''})`, level);
    }
  } else if (category === 'raid') {
    next.push(...raidAlerts(report as HealthRaid));
  } else {
    for (const d of (report as HealthSmart).disks) {
      if (d.healthy === false) alert(`smart:${d.device}:health`, d.device, `${d.device} : état SMART en échec`, 'alert');
      if (settings.smartTemperatureEnabled !== false && d.temperatureC !== undefined) {
        const values = samples.filter((sample): sample is HealthSmart => 'disks' in sample)
          .flatMap((sample) => sample.disks.filter((disk) => disk.device === d.device && disk.temperatureC !== undefined).map((disk) => ({ checkedAt: sample.checkedAt, value: disk.temperatureC! })));
        const level = healthMetricLevel(d.temperatureC, values, settings.smartTemperatureWarningThreshold, settings.smartTemperatureAlertThreshold, settings.smartSustainedMinutes, settings.smartIntervalSeconds);
          if (level) alert(`smart:${d.device}:temperature`, d.device, `${d.device} : température ${d.temperatureC} °C (warning ${settings.smartTemperatureWarningThreshold} °C, alerte ${settings.smartTemperatureAlertThreshold} °C, ${settings.smartSustainedMinutes ? `durée ${settings.smartSustainedMinutes} min` : 'déclenchement immédiat'})`, level);
      }
      if (d.reallocated !== undefined && d.reallocated > 0) alert(`smart:${d.device}:reallocated`, d.device, `${d.device} : ${d.reallocated} secteur(s) réalloué(s)`, 'alert');
      if (settings.smartWearEnabled !== false && d.nvmeWearPercent !== undefined) {
        const values = samples.filter((sample): sample is HealthSmart => 'disks' in sample)
          .flatMap((sample) => sample.disks.filter((disk) => disk.device === d.device && disk.nvmeWearPercent !== undefined).map((disk) => ({ checkedAt: sample.checkedAt, value: disk.nvmeWearPercent! })));
        const level = healthMetricLevel(d.nvmeWearPercent, values, settings.smartWearWarningThreshold, settings.smartWearAlertThreshold, settings.smartSustainedMinutes, settings.smartIntervalSeconds);
        if (level) alert(`smart:${d.device}:wear`, d.device, `${d.device} : usure NVMe ${d.nvmeWearPercent} % (warning ${settings.smartWearWarningThreshold} %, alerte ${settings.smartWearAlertThreshold} %, ${settings.smartSustainedMinutes ? `durée ${settings.smartSustainedMinutes} min` : 'déclenchement immédiat'})`, level);
      }
      if (d.error) alert(`smart:${d.device}:error`, d.device, `${d.device} : ${d.error}`);
    }
  }
  return [...retained, ...next];
}

// A disk asleep at the time of the reading has no values: it keeps the last ones known, flagged as asleep.
export function keepStandbyDisks(report: HealthSmart, previous: HealthSmart | undefined): HealthSmart {
  return {
    ...report,
    disks: report.disks.map((d) => (d.standby ? { ...(previous?.disks.find((p) => p.device === d.device) ?? {}), ...d } : d)),
  };
}

async function persistReport(hostId: ObjectId, category: HealthCategory, report: HealthReport) {
  const sampledAt = new Date(report.checkedAt);
  const host = await hosts.findOne({ _id: hostId });
  if (!host) return;
  if (category === 'disks' && hasNoHealthDisks(host)) {
    await hosts.updateOne({ _id: hostId }, { $unset: { 'health.disks': '' }, $set: { 'health.alerts': (host.health?.alerts ?? []).filter((a) => !a.key.startsWith('disks:')) } });
    return;
  }
  if (category === 'raid' && isContainerHealthHost(host)) {
    await hosts.updateOne({ _id: hostId }, { $unset: { 'health.raid': '' }, $set: { 'health.alerts': (host.health?.alerts ?? []).filter((a) => !a.key.startsWith('raid:')) } });
    return;
  }
  await healthMetrics.insertOne({ hostId, category, sampledAt, report });

  const s = resolveHealthSettings(await loadHealthSettings(), host.healthOverrides);
  const durationMinutes = category === 'system' ? Math.max(s.systemSustainedMinutes, s.loadSustainedMinutes) : category === 'smart' ? s.smartSustainedMinutes : 0;
  const intervalSeconds = category === 'system' ? s.systemIntervalSeconds : category === 'smart' ? s.smartIntervalSeconds : s.diskIntervalSeconds;
  const since = new Date(Date.now() - durationMinutes * 60_000 - intervalSeconds * 2_000);
  const docs = await healthMetrics.find({ hostId, category, sampledAt: { $gte: since } }).sort({ sampledAt: 1 }).limit(5000).toArray();
  const stored = category === 'smart' ? keepStandbyDisks(report as HealthSmart, host.health?.smart) : report;
  const alerts = reportAlerts(host, category, stored, s, docs.map((d) => d.report));
  const field = `health.${category}`;
  const update: Record<string, unknown> = { [field]: stored, 'health.alerts': alerts };
  if (category === 'disks') update['health.rearm'] = nextRearm(host.health?.rearm, (host.health?.alerts ?? []).filter((a) => a.key.startsWith('disks:')), alerts.filter((a) => a.key.startsWith('disks:')), s.diskRearmMinutes, report.checkedAt);
  // RAID keys carry a count: an acceptance whose alert is gone (count changed, array repaired) is dropped
  if (category === 'raid') update.healthSilenced = (host.healthSilenced ?? []).filter((x) => !x.key.startsWith('raid:') || alerts.some((a) => a.key === x.key));
  await hosts.updateOne({ _id: hostId }, { $set: update });
}

async function saveReport(hostId: ObjectId, category: HealthCategory, report: HealthReport) {
  const key = hostId.toHexString();
  const previous = pendingHostWrites.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => persistReport(hostId, category, report));
  pendingHostWrites.set(key, next);
  try {
    await next;
  } finally {
    if (pendingHostWrites.get(key) === next) pendingHostWrites.delete(key);
  }
}

export async function receiveHealthReport(hostId: ObjectId, category: HealthCategory, report: unknown) {
  if ((category === 'system' && !isHealthSystem(report)) ||
      (category === 'disks' && !isHealthDisks(report)) ||
      (category === 'smart' && !isHealthSmart(report)) ||
      (category === 'raid' && !isHealthRaid(report))) return false;
  await saveReport(hostId, category, report as HealthReport);
  return true;
}

const healthSettingsBody = {
  type: 'object',
  required: [
    'systemIntervalSeconds', 'diskIntervalSeconds', 'smartIntervalSeconds',
    'cpuWarningThreshold', 'cpuAlertThreshold', 'memoryWarningThreshold', 'memoryAlertThreshold',
    'diskWarningThreshold', 'diskAlertThreshold', 'smartTemperatureWarningThreshold', 'smartTemperatureAlertThreshold',
    'smartWearWarningThreshold', 'smartWearAlertThreshold', 'systemSustainedMinutes', 'smartSustainedMinutes',
    'loadWarningThreshold', 'loadAlertThreshold', 'loadSustainedMinutes', 'diskRearmMinutes',
  ],
  additionalProperties: false,
  properties: {
    systemIntervalSeconds: { type: 'integer', minimum: 10, maximum: 3600 },
    diskIntervalSeconds: { type: 'integer', minimum: 60, maximum: 86400 },
    smartIntervalSeconds: { type: 'integer', minimum: 600, maximum: 2592000 },
    cpuWarningThreshold: { type: 'number', minimum: 1, maximum: 99 },
    cpuAlertThreshold: { type: 'number', minimum: 2, maximum: 100 },
    memoryWarningThreshold: { type: 'number', minimum: 1, maximum: 99 },
    memoryAlertThreshold: { type: 'number', minimum: 2, maximum: 100 },
    diskWarningThreshold: { type: 'number', minimum: 1, maximum: 99 },
    diskAlertThreshold: { type: 'number', minimum: 2, maximum: 100 },
    smartTemperatureWarningThreshold: { type: 'number', minimum: 1, maximum: 149 },
    smartTemperatureAlertThreshold: { type: 'number', minimum: 2, maximum: 150 },
    smartWearWarningThreshold: { type: 'number', minimum: 1, maximum: 999 },
    smartWearAlertThreshold: { type: 'number', minimum: 2, maximum: 1000 },
    systemSustainedMinutes: { type: 'integer', minimum: 0, maximum: 60 },
    smartSustainedMinutes: { type: 'integer', minimum: 0, maximum: 2880 },
    loadWarningThreshold: { type: 'number', minimum: 0.1, maximum: 9.9 },
    loadAlertThreshold: { type: 'number', minimum: 0.2, maximum: 10 },
    loadSustainedMinutes: { type: 'integer', minimum: 0, maximum: 60 },
    diskRearmMinutes: { type: 'integer', minimum: 0, maximum: 2880 },
  },
} as const;

// Same bounds as the global settings, every field optional.
const healthOverridesBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...Object.fromEntries(HEALTH_OVERRIDE_NUMBER_KEYS.map((k) => [k, healthSettingsBody.properties[k]])),
    ...Object.fromEntries(HEALTH_OVERRIDE_ENABLED_KEYS.map((k) => [k, { type: 'boolean' }])),
  },
} as const;

export function registerHealthRoutes(app: FastifyInstance) {
  app.get('/api/settings/health', loadHealthSettings);
  app.put<{ Body: Omit<HealthSettings, '_id' | 'retentionHours'> }>(
    '/api/settings/health',
    { schema: { body: healthSettingsBody } },
    async (req, reply) => {
      if (thresholdsInvalid({ ...DEFAULT_HEALTH_SETTINGS, ...req.body })) return reply.code(400).send({ error: THRESHOLD_ORDER_ERROR });
      const next: HealthSettings = { ...DEFAULT_HEALTH_SETTINGS, ...req.body, retentionHours: 48 };
      await settings.replaceOne({ _id: 'health' }, next, { upsert: true });
      for (const host of await hosts.find({}).toArray()) {
        if (host.capabilities?.includes('health')) sendToAgent(host._id.toHexString(), await healthConfigForHost(host));
      }
      return next;
    },
  );

  // Per-host overrides: only the fields set differ from the global settings; DELETE restores the defaults.
  app.get<{ Params: { id: string } }>('/api/hosts/:id/health/overrides', async (req, reply) => {
    const hostId = parseId(req.params.id);
    const host = hostId && (await hosts.findOne({ _id: hostId }, { projection: { healthOverrides: 1 } }));
    if (!host) return reply.code(404).send({ error: 'host not found' });
    const overrides = host.healthOverrides ?? {};
    return { overrides, effective: resolveHealthSettings(await loadHealthSettings(), overrides) };
  });

  app.put<{ Params: { id: string }; Body: HealthOverrides }>(
    '/api/hosts/:id/health/overrides',
    { schema: { body: healthOverridesBody } },
    async (req, reply) => {
      const hostId = parseId(req.params.id);
      if (!hostId || !(await hosts.countDocuments({ _id: hostId }, { limit: 1 }))) return reply.code(404).send({ error: 'host not found' });
      const global = await loadHealthSettings();
      const effective = resolveHealthSettings(global, req.body);
      if (thresholdsInvalid(effective)) return reply.code(400).send({ error: THRESHOLD_ORDER_ERROR });
      const overrides = req.body;
      const updated = Object.keys(overrides).length
        ? await hosts.findOneAndUpdate({ _id: hostId }, { $set: { healthOverrides: overrides } }, { returnDocument: 'after' })
        : await hosts.findOneAndUpdate({ _id: hostId }, { $unset: { healthOverrides: '' } }, { returnDocument: 'after' });
      if (updated) publish('host', hostDto(updated));
      return { overrides, effective };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/hosts/:id/health/overrides', async (req, reply) => {
    const hostId = parseId(req.params.id);
    const updated = hostId && (await hosts.findOneAndUpdate({ _id: hostId }, { $unset: { healthOverrides: '' } }, { returnDocument: 'after' }));
    if (!updated) return reply.code(404).send({ error: 'host not found' });
    publish('host', hostDto(updated));
    return { overrides: {}, effective: resolveHealthSettings(await loadHealthSettings()) };
  });

  app.get<{ Params: { id: string }; Querystring: { hours?: string } }>('/api/hosts/:id/health', async (req, reply) => {
    const hostId = parseId(req.params.id);
    if (!hostId || !(await hosts.countDocuments({ _id: hostId }, { limit: 1 }))) return reply.code(404).send({ error: 'host not found' });
    const hours = Math.min(24, Math.max(1, Number(req.query.hours) || 1));
    const samples = await healthMetrics.find({ hostId, sampledAt: { $gte: new Date(Date.now() - hours * 3600_000) } })
      .sort({ sampledAt: 1 }).limit(10_000).toArray();
    return { samples };
  });

  app.get('/api/health/overview', async () => {
    const list = await hosts.find({}).sort({ name: 1 }).toArray();
    const hostIds = list.map((h) => h._id);
    const samples = hostIds.length
      ? await healthMetrics.find({ hostId: { $in: hostIds }, category: 'system', sampledAt: { $gte: new Date(Date.now() - 3600_000) } })
        .sort({ sampledAt: 1 }).limit(20_000).toArray()
      : [];
    const global = await loadHealthSettings();
    const byHost = new Map<string, typeof samples>();
    for (const sample of samples) {
      const key = sample.hostId.toHexString();
      byHost.set(key, [...(byHost.get(key) ?? []), sample]);
    }
    return {
      hosts: list.map((host) => ({
        id: host._id.toHexString(),
        name: host.name,
        online: isOnline(host._id.toHexString()),
        supported: host.capabilities?.includes('health') ?? false,
        virtualized: isVirtualizedHealthHost(host),
        noDisks: hasNoHealthDisks(host),
        health: healthWithSilenced(host.health, host.healthSilenced),
        settings: resolveHealthSettings(global, host.healthOverrides),
        customized: Object.keys(host.healthOverrides ?? {}).length > 0,
        samples: (byHost.get(host._id.toHexString()) ?? []).map(({ sampledAt, report }) => ({ sampledAt, report })),
      })),
    };
  });

  // Accept ("silence") or watch again alerts of a host: they stop counting for its state, the bars keep their colours.
  app.put<{ Params: { id: string }; Body: { keys: string[]; silenced: boolean } }>(
    '/api/hosts/:id/health/silenced',
    {
      schema: {
        body: {
          type: 'object',
          required: ['keys', 'silenced'],
          additionalProperties: false,
          properties: {
            keys: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 512 } },
            silenced: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const hostId = parseId(req.params.id);
      const host = hostId && (await hosts.findOne({ _id: hostId }, { projection: { health: 1, healthSilenced: 1 } }));
      if (!host) return reply.code(404).send({ error: 'host not found' });
      const current = new Map((host.health?.alerts ?? []).map((a) => [a.key, a.level]));
      const keys = new Set(req.body.keys);
      let next = (host.healthSilenced ?? []).filter((s) => !keys.has(s.key));
      if (req.body.silenced) {
        const unknown = req.body.keys.filter((k) => !current.has(k));
        if (unknown.length) return reply.code(409).send({ error: `alerte inactive : ${unknown.join(', ')}` });
        next = [...next, ...req.body.keys.map((key) => ({ key, level: current.get(key)! }))];
      }
      const updated = await hosts.findOneAndUpdate({ _id: hostId }, { $set: { healthSilenced: next } }, { returnDocument: 'after' });
      if (updated) publish('host', hostDto(updated));
      // a cluster-wide Ceph check is accepted (or not) on all the nodes of the cluster
      const shared = req.body.keys.filter(isCephClusterKey);
      const fsid = host.health?.raid?.ceph?.fsid;
      if (shared.length && fsid) {
        for (const other of await hosts.find({ _id: { $ne: hostId }, 'health.raid.ceph.fsid': fsid }, { projection: { health: 1, healthSilenced: 1 } }).toArray()) {
          const silenced = applySilence(other.healthSilenced, other.health?.alerts, shared, req.body.silenced);
          const done = await hosts.findOneAndUpdate({ _id: other._id }, { $set: { healthSilenced: silenced } }, { returnDocument: 'after' });
          if (done) publish('host', hostDto(done));
        }
      }
      return { healthSilenced: next };
    },
  );

  app.put<{ Params: { id: string }; Body: { devices: string[] } }>(
    '/api/hosts/:id/health/smart',
    {
      schema: {
        body: {
          type: 'object',
          required: ['devices'],
          additionalProperties: false,
          properties: { devices: { type: 'array', maxItems: 16, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128, pattern: '^/dev/[A-Za-z0-9._/+:-]+$' } } },
        },
      },
    },
    async (req, reply) => {
      const hostId = parseId(req.params.id);
      if (!hostId) return reply.code(404).send({ error: 'host not found' });
      const current = await hosts.findOne({ _id: hostId });
      if (!current) return reply.code(404).send({ error: 'host not found' });
      if (isVirtualizedHealthHost(current)) return reply.code(409).send({ error: 'SMART désactivé sur les hôtes virtualisés' });
      if (!current.capabilities?.includes('smart')) return reply.code(409).send({ error: 'SMART indisponible sur cet agent' });
      const host = await hosts.findOneAndUpdate({ _id: hostId }, { $set: { smartDevices: req.body.devices } }, { returnDocument: 'after' });
      if (!host) return reply.code(404).send({ error: 'host not found' });
      if (host.capabilities?.includes('health')) sendToAgent(hostId.toHexString(), await healthConfigForHost(host));
      return { devices: host.smartDevices ?? [] };
    },
  );
}
