import type { FastifyBaseLogger } from 'fastify';
import { ObjectId } from 'mongodb';
import { isOnline } from './agents.js';
import { backups, hostAlerts, hosts, jobs } from './db.js';
import { subscribe } from './events.js';
import { jobDto } from './jobs.js';
import { DOMAINS, dayOf, evaluate } from './monitoring.js';
import type { AlertDomain, DayAlert, HostAlertDoc, HostDoc, JobDoc } from './types.js';

// History of the alerts over the last days, one state per host, domain and day (see monitoring.ts).
// Each day keeps the latest observed state in each domain, with its reasons.

export const ALERT_DAYS = 30;
const MAX_REASONS = 8;
const day = (lvl: DayAlert['level'], reasons: string[]): DayAlert => ({ level: lvl, reasons });

// Day of a date in the time zone of the hub (TZ of the container), YYYY-MM-DD.
export function dayKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Domain a failed job counts in (null: none, e.g. an agent update).
export function jobDomain(action: JobDoc['action']): AlertDomain | null {
  if (action.startsWith('apt_') || action === 'reboot' || action === 'shutdown') return 'apt';
  if (action.startsWith('docker_')) return 'docker';
  if (action.startsWith('backup_')) return 'backup';
  if (action === 'offsite_run') return 'offsite';
  return null;
}

// A new observation replaces the previous state for this domain and day.
export function latestDay(next: DayAlert): DayAlert {
  return { level: next.level, reasons: next.reasons.slice(0, MAX_REASONS) };
}

async function record(hostId: ObjectId, domains: Partial<Record<AlertDomain, DayAlert | null>>, now = new Date()) {
  const key = dayKey(now);
  const current = await hostAlerts.findOne({ hostId, day: key });
  const set: Partial<Record<AlertDomain, DayAlert>> = {};
  for (const [d, a] of Object.entries(domains) as [AlertDomain, DayAlert | null][]) {
    if (!a) continue;
    const latest = latestDay(a);
    if (JSON.stringify(latest) !== JSON.stringify(current?.[d])) set[d] = latest;
  }
  if (!Object.keys(set).length) return;
  await hostAlerts.updateOne(
    { hostId, day: key },
    // kept a little longer than the timeline shows
    { $set: { ...set, updatedAt: now }, $setOnInsert: { expiresAt: new Date(now.getTime() + (ALERT_DAYS + 10) * 24 * 3600 * 1000) } },
    { upsert: true },
  );
}

// What cannot be read now (APT, Docker, UPS of a host off for days) is left out: the last report says
// nothing of those days. Backups and the connection are always followed by the hub.
export async function recordHost(h: HostDoc, now = new Date()) {
  const groups = await backups.find({ hostId: h._id }).toArray();
  const status = evaluate(h, { online: isOnline(h._id.toHexString()), groups, now: now.getTime() });
  await record(h._id, Object.fromEntries(DOMAINS.map(({ id }) => [id, dayOf(status.domains[id])])), now);
}

export async function recordAll(now = new Date()) {
  for (const h of await hosts.find({}).toArray()) await recordHost(h, now);
}

async function recordHostId(id: string) {
  const _id = ObjectId.isValid(id) ? new ObjectId(id) : null;
  const h = _id && (await hosts.findOne({ _id }));
  if (h) await recordHost(h);
}

const dayDto = (d: HostAlertDoc) => ({ day: d.day, domains: Object.fromEntries(DOMAINS.map(({ id }) => [id, d[id] ?? null])) as Record<AlertDomain, DayAlert | null> });

// Days of a host, oldest first; the missing days are left out (nothing known).
export async function hostAlertDays(hostId: ObjectId, days = ALERT_DAYS, now = new Date()) {
  const from = new Date(now);
  from.setDate(from.getDate() - (days - 1));
  const list = await hostAlerts.find({ hostId, day: { $gte: dayKey(from) } }).sort({ day: 1 }).toArray();
  return list.map(dayDto);
}

// Days of every host (dashboard, one row per site), oldest first.
export async function allAlertDays(days = ALERT_DAYS, now = new Date()) {
  const from = new Date(now);
  from.setDate(from.getDate() - (days - 1));
  const list = await hostAlerts.find({ day: { $gte: dayKey(from) } }).sort({ day: 1 }).toArray();
  return list.map((d) => ({ hostId: d.hostId.toHexString(), ...dayDto(d) }));
}

// Identifiers of the first versions: agent -> system, backups -> backup.
async function migrateDomains() {
  await hostAlerts.updateMany({ agent: { $exists: true } }, { $rename: { agent: 'system' } });
  await hostAlerts.updateMany({ backups: { $exists: true } }, { $rename: { backups: 'backup' } });
}

// First start: the failed jobs of the last days (kept 90 days) fill the past days of the timeline;
// the states of APT and Docker before this version are not known.
async function backfill() {
  if (await hostAlerts.estimatedDocumentCount()) return;
  const from = new Date(Date.now() - ALERT_DAYS * 24 * 3600 * 1000);
  for (const j of await jobs.find({ status: 'failed', createdAt: { $gte: from } }, { projection: { log: 0 } }).sort({ createdAt: 1 }).toArray()) {
    await recordJob(jobDto(j), j.createdAt);
  }
}

async function recordJob(j: ReturnType<typeof jobDto>, at = new Date()) {
  const domain = jobDomain(j.action);
  if (j.status !== 'failed' || !domain || !ObjectId.isValid(j.hostId)) return;
  await record(new ObjectId(j.hostId), { [domain]: day('alert', [`Tâche en échec : ${jobLabel(j)}${j.error ? ` (${j.error})` : ''}`]) }, at);
}

// Records on the events of the hub (and every 10 minutes, for the backups that become late with time).
export function startAlerts(log: FastifyBaseLogger) {
  const fail = (err: unknown) => log.warn({ err }, 'alert recording failed');
  const unsubscribe = subscribe((event, data) => {
    if (event === 'host') recordHostId((data as { id: string }).id).catch(fail);
    else if (event === 'backups') recordAll().catch(fail);
    else if (event === 'host.deleted') {
      const id = (data as { id: string }).id;
      if (ObjectId.isValid(id)) hostAlerts.deleteMany({ hostId: new ObjectId(id) }).catch(fail);
    } else if (event === 'job') recordJob(data as ReturnType<typeof jobDto>).catch(fail);
  });
  const run = () => recordAll().catch(fail);
  migrateDomains().then(backfill).catch(fail);
  const first = setTimeout(run, 30_000);
  const timer = setInterval(run, 10 * 60_000);
  return () => {
    unsubscribe();
    clearTimeout(first);
    clearInterval(timer);
  };
}

const actionLabel: Partial<Record<JobDoc['action'], string>> = {
  apt_update: 'recherche de mises à jour',
  apt_upgrade: 'mise à jour',
  apt_autoremove: 'nettoyage des paquets',
  reboot: 'redémarrage',
  shutdown: 'extinction',
  lock: 'verrouillage',
  docker_check: 'vérification des images',
  docker_up: 'démarrage',
  docker_stop: 'arrêt',
  docker_restart: 'redémarrage',
  docker_update: 'mise à jour',
  backup_run: 'sauvegarde',
  backup_install: 'installation du client PBS',
  offsite_run: 'copie déportée',
};

export function jobLabel(j: { action: JobDoc['action']; stack?: string | null; backupJobName?: string | null }) {
  const label = actionLabel[j.action] ?? j.action;
  if (j.backupJobName) return `${label} ${j.backupJobName}`;
  if (j.stack) return `${label} ${j.stack}`;
  return label;
}
