import type { FastifyBaseLogger } from 'fastify';
import { ObjectId } from 'mongodb';
import { isOnline } from './agents.js';
import { backups, hostAlerts, hosts, jobs } from './db.js';
import { dockerView } from './docker.js';
import { subscribe } from './events.js';
import { jobDto } from './jobs.js';
import { backupState } from './pbs.js';
import { upsAlert } from './ups.js';
import { agentAlerts } from './homeassistant/alerts.js';
import type { AlertDomain, AlertLevel, BackupDoc, DayAlert, HostAlertDoc, HostDoc, JobDoc } from './types.js';

// Alerts of the host page over the last days, for the agent, APT, Docker, backups and UPS.
// Each day keeps the latest observed state in each domain, with its reasons.

const STALE_LISTS_MS = 2 * 24 * 3600 * 1000;
export const ALERT_DAYS = 30;
const MAX_REASONS = 8;
const day = (lvl: AlertLevel, reasons: string[]): DayAlert => ({ level: lvl, reasons });

// Day of a date in the time zone of the hub (TZ of the container), YYYY-MM-DD.
export function dayKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// null: not followed (no APT on the host, never reported)
export function aptAlert(h: Pick<HostDoc, 'apt' | 'roaming'>, online: boolean, now = Date.now()): DayAlert | null {
  const r = h.apt;
  if (!r) return null;
  const security = r.upgradable.filter((p) => p.security).map((p) => p.name);
  if (security.length) return day('alert', [`Mises à jour de sécurité : ${security.join(', ')}`]);
  const out: string[] = [];
  if (r.rebootRequired) out.push(`Redémarrage requis${r.rebootPkgs.length ? ` (${r.rebootPkgs.join(', ')})` : ''}`);
  if (r.upgradable.length) out.push(`${r.upgradable.length} paquet(s) à mettre à jour`);
  // roaming host away: its lists can only be refreshed once it is back
  if (!(h.roaming && !online) && now - r.listsUpdatedAt > STALE_LISTS_MS) out.push('Listes de paquets périmées');
  return out.length ? day('warn', out) : day('ok', []);
}

export function dockerAlert(h: HostDoc): DayAlert | null {
  const v = dockerView(h);
  if (!v) return null;
  const alerts: string[] = [];
  const warns: string[] = [];
  for (const st of v.stacks) {
    if (!st.managed) continue;
    if (st.problems.length) alerts.push(`${st.name} : ${st.problems.join(', ')}`);
    if (st.updates > 0) warns.push(`${st.name} : ${st.updates} image(s) à mettre à jour`);
  }
  return alerts.length ? day('alert', alerts) : warns.length ? day('warn', warns) : day('ok', []);
}

export function backupsAlert(groups: BackupDoc[], now = Date.now()): DayAlert | null {
  if (!groups.length) return null;
  const alerts: string[] = [];
  const warns: string[] = [];
  for (const b of groups) {
    const name = b.managed?.name ?? b.comment ?? b.backupId;
    const s = backupState(b, now);
    if (s === 'failed') alerts.push(`${name} : vérification en échec`);
    else if (s === 'task_failed') alerts.push(`${name} : dernière exécution en échec`);
    else if (s === 'stale') warns.push(`${name} : en retard`);
    else if (s === 'gone') warns.push(`${name} : disparue du PBS`);
    else if (s === 'disabled') warns.push(`${name} : job désactivé`);
    else if (s === 'not_synced') warns.push(`${name} : pas encore appliquée par l'agent`);
  }
  return alerts.length ? day('alert', alerts) : warns.length ? day('warn', warns) : day('ok', []);
}

// Domain a failed job counts in (null: none, e.g. an agent update).
export function jobDomain(action: JobDoc['action']): AlertDomain | null {
  if (action.startsWith('apt_') || action === 'reboot') return 'apt';
  if (action.startsWith('docker_')) return 'docker';
  if (action.startsWith('backup_')) return 'backups';
  return null;
}

// A new observation replaces the previous state for this domain and day.
export function latestDay(next: DayAlert): DayAlert {
  return { level: next.level, reasons: next.reasons.slice(0, MAX_REASONS) };
}

export function agentAlert(h: HostDoc, online: boolean): DayAlert {
  const alerts = agentAlerts(h, online);
  if (!alerts.length) return day('ok', []);
  return day(
    alerts.some((alert) => alert.level === 'critical') ? 'alert' : 'warn',
    alerts.map((alert) => alert.message),
  );
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

// APT, Docker and UPS only while connected (the last report of a host off for days says nothing of
// those days); agent connectivity and backups are always followed by the hub.
export async function recordHost(h: HostDoc, now = new Date()) {
  const online = isOnline(h._id.toHexString());
  const groups = await backups.find({ hostId: h._id }).toArray();
  await record(
    h._id,
    {
      agent: agentAlert(h, online),
      apt: online ? aptAlert(h, online, now.getTime()) : null,
      docker: online ? dockerAlert(h) : null,
      backups: backupsAlert(groups, now.getTime()),
      ups: online ? upsAlert(h) : null,
    },
    now,
  );
}

export async function recordAll(now = new Date()) {
  for (const h of await hosts.find({}).toArray()) await recordHost(h, now);
}

async function recordHostId(id: string) {
  const _id = ObjectId.isValid(id) ? new ObjectId(id) : null;
  const h = _id && (await hosts.findOne({ _id }));
  if (h) await recordHost(h);
}

// Days of a host, oldest first; the missing days are left out (nothing known).
export async function hostAlertDays(hostId: ObjectId, days = ALERT_DAYS, now = new Date()) {
  const from = new Date(now);
  from.setDate(from.getDate() - (days - 1));
  const list = await hostAlerts.find({ hostId, day: { $gte: dayKey(from) } }).sort({ day: 1 }).toArray();
  return list.map((d: HostAlertDoc) => ({ day: d.day, agent: d.agent ?? null, apt: d.apt ?? null, docker: d.docker ?? null, backups: d.backups ?? null, ups: d.ups ?? null }));
}

// Days of every host (dashboard, one row per site), oldest first.
export async function allAlertDays(days = ALERT_DAYS, now = new Date()) {
  const from = new Date(now);
  from.setDate(from.getDate() - (days - 1));
  const list = await hostAlerts.find({ day: { $gte: dayKey(from) } }).sort({ day: 1 }).toArray();
  return list.map((d: HostAlertDoc) => ({ hostId: d.hostId.toHexString(), day: d.day, agent: d.agent ?? null, apt: d.apt ?? null, docker: d.docker ?? null, backups: d.backups ?? null, ups: d.ups ?? null }));
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
  backfill().catch(fail);
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
  docker_check: 'vérification des images',
  docker_up: 'démarrage',
  docker_stop: 'arrêt',
  docker_restart: 'redémarrage',
  docker_update: 'mise à jour',
  backup_run: 'sauvegarde',
  backup_install: 'installation du client PBS',
};

export function jobLabel(j: { action: JobDoc['action']; stack?: string | null; backupJobName?: string | null }) {
  const label = actionLabel[j.action] ?? j.action;
  if (j.backupJobName) return `${label} ${j.backupJobName}`;
  if (j.stack) return `${label} ${j.stack}`;
  return label;
}
