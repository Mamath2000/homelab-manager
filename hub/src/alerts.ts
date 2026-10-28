import type { FastifyBaseLogger } from 'fastify';
import { ObjectId, type Collection } from 'mongodb';
import { isOnline } from './agents.js';
import { backups, equipmentAlerts, equipments, hostAlerts, hosts, jobs, probes } from './db.js';
import { subscribe } from './events.js';
import { jobDto } from './jobs.js';
import { DOMAINS, dayOf, evaluate, evaluateEquipment } from './monitoring.js';
import type { AlertDayFields, AlertDomain, DayAlert, EquipmentDoc, HostDoc, JobDoc } from './types.js';

// History of the alerts over the last days, one state per host (or equipment), domain and day (see monitoring.ts).
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

// Hosts and equipment have the same days, each in its own collection.
type Subject = { kind: 'host' | 'equipment'; id: ObjectId };
const daysOf = (kind: Subject['kind']) => (kind === 'host' ? hostAlerts : equipmentAlerts) as unknown as Collection<AlertDayFields>;
const keyOf = (s: Subject) => (s.kind === 'host' ? { hostId: s.id } : { equipmentId: s.id });

async function record(subject: Subject, domains: Partial<Record<AlertDomain, DayAlert | null>>, now = new Date()) {
  const key = dayKey(now);
  const coll = daysOf(subject.kind);
  const current = await coll.findOne({ ...keyOf(subject), day: key });
  const set: Partial<Record<AlertDomain, DayAlert>> = {};
  for (const [d, a] of Object.entries(domains) as [AlertDomain, DayAlert | null][]) {
    if (!a) continue;
    const latest = latestDay(a);
    if (JSON.stringify(latest) !== JSON.stringify(current?.[d])) set[d] = latest;
  }
  if (!Object.keys(set).length) return;
  await coll.updateOne(
    { ...keyOf(subject), day: key },
    // kept a little longer than the timeline shows
    { $set: { ...set, updatedAt: now }, $setOnInsert: { expiresAt: new Date(now.getTime() + (ALERT_DAYS + 10) * 24 * 3600 * 1000) } },
    { upsert: true },
  );
}

// What cannot be read now (APT, Docker, UPS of a host off for days) is left out: the last report says
// nothing of those days. Backups, probes and the connection are always followed by the hub.
export async function recordHost(h: HostDoc, now = new Date()) {
  const groups = await backups.find({ hostId: h._id }).toArray();
  const hostProbes = await probes.find({ 'subject.kind': 'host', 'subject.id': h._id }).toArray();
  const status = evaluate(h, { online: isOnline(h._id.toHexString()), groups, now: now.getTime(), probes: hostProbes });
  await record({ kind: 'host', id: h._id }, Object.fromEntries(DOMAINS.map(({ id }) => [id, dayOf(status.domains[id])])), now);
}

// An equipment: its probes and what its source reports, both read by the hub.
export async function recordEquipment(e: EquipmentDoc, now = new Date()) {
  const own = await probes.find({ 'subject.kind': 'equipment', 'subject.id': e._id }).toArray();
  const status = evaluateEquipment(e, { now: now.getTime(), probes: own });
  await record({ kind: 'equipment', id: e._id }, Object.fromEntries(DOMAINS.map(({ id }) => [id, dayOf(status.domains[id])])), now);
}

export async function recordAll(now = new Date()) {
  for (const h of await hosts.find({}).toArray()) await recordHost(h, now);
  for (const e of await equipments.find({}).toArray()) await recordEquipment(e, now);
}

async function recordHostId(id: string) {
  const _id = ObjectId.isValid(id) ? new ObjectId(id) : null;
  const h = _id && (await hosts.findOne({ _id }));
  if (h) await recordHost(h);
}

async function recordEquipmentId(id: string) {
  const _id = ObjectId.isValid(id) ? new ObjectId(id) : null;
  const e = _id && (await equipments.findOne({ _id }));
  if (e) await recordEquipment(e);
}

const dayDto = (d: AlertDayFields) => ({ day: d.day, domains: Object.fromEntries(DOMAINS.map(({ id }) => [id, d[id] ?? null])) as Record<AlertDomain, DayAlert | null> });

async function subjectDays(subject: Subject, days: number, now: Date) {
  const from = new Date(now);
  from.setDate(from.getDate() - (days - 1));
  const list = await daysOf(subject.kind).find({ ...keyOf(subject), day: { $gte: dayKey(from) } }).sort({ day: 1 }).toArray();
  return list.map(dayDto);
}

// Days of a host, oldest first; the missing days are left out (nothing known).
export const hostAlertDays = (hostId: ObjectId, days = ALERT_DAYS, now = new Date()) => subjectDays({ kind: 'host', id: hostId }, days, now);

// The same for an equipment (its page).
export const equipmentAlertDays = (equipmentId: ObjectId, days = ALERT_DAYS, now = new Date()) => subjectDays({ kind: 'equipment', id: equipmentId }, days, now);

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
  await record({ kind: 'host', id: new ObjectId(j.hostId) }, { [domain]: day('alert', [`Tâche en échec : ${jobLabel(j)}${j.error ? ` (${j.error})` : ''}`]) }, at);
}

// Records on the events of the hub (and every 10 minutes, for the backups that become late with time).
export function startAlerts(log: FastifyBaseLogger) {
  const fail = (err: unknown) => log.warn({ err }, 'alert recording failed');
  const unsubscribe = subscribe((event, data) => {
    if (event === 'host') recordHostId((data as { id: string }).id).catch(fail);
    // a probe changed state: recorded at once, whichever host or equipment it checks
    else if (event === 'probe') {
      const subject = (data as { subject: { kind: string; id: string } }).subject;
      if (subject.kind === 'host') recordHostId(subject.id).catch(fail);
      else if (subject.kind === 'equipment') recordEquipmentId(subject.id).catch(fail);
    }
    else if (event === 'equipment') recordEquipmentId((data as { id: string }).id).catch(fail);
    else if (event === 'backups') recordAll().catch(fail);
    else if (event === 'host.deleted') {
      const id = (data as { id: string }).id;
      if (ObjectId.isValid(id)) hostAlerts.deleteMany({ hostId: new ObjectId(id) }).catch(fail);
    } else if (event === 'equipment.deleted') {
      const id = (data as { id: string }).id;
      if (ObjectId.isValid(id)) equipmentAlerts.deleteMany({ equipmentId: new ObjectId(id) }).catch(fail);
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
