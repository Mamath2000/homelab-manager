import type { FastifyBaseLogger } from 'fastify';
import { backups, settings } from './db.js';
import { publish } from './events.js';
import { describeCalendar, nextRun, parseCalendar, previousRun } from './calendar.js';
import { ApiError, apiGet, FINGERPRINT_RE, SERVER_URL_RE, fetchFingerprint, normalizeFingerprint } from './tlsApi.js';
import type { BackupDoc, HostDoc, PbsDatastoreUsage, PbsSettings } from './types.js';

// Backups kept on a Proxmox Backup Server, read through its API with a read-only token
// (DatastoreAudit). Nothing runs on the hosts: the PBS is the source of truth.

export const DEFAULT_PBS: PbsSettings = {
  _id: 'pbs',
  enabled: false,
  url: '',
  fingerprint: '',
  tokenId: '',
  tokenSecret: '',
  staleHours: 26,
};

export const PBS_URL_RE = SERVER_URL_RE;
export const TOKEN_ID_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/;
export { ApiError as PbsError, FINGERPRINT_RE, fetchFingerprint, normalizeFingerprint };

export async function loadPbsSettings(): Promise<PbsSettings> {
  return { ...DEFAULT_PBS, ...((await settings.findOne({ _id: 'pbs' })) as PbsSettings | null), _id: 'pbs' };
}

type Conn = Pick<PbsSettings, 'url' | 'fingerprint' | 'tokenId' | 'tokenSecret'>;

// GET on the PBS API (see tlsApi.ts).
export function pbsGet<T>(c: Conn, path: string, timeoutMs = 20_000): Promise<T> {
  return apiGet<T>(
    {
      url: c.url,
      fingerprint: c.fingerprint,
      authorization: `PBSAPIToken=${c.tokenId}:${c.tokenSecret}`,
      defaultPort: 8007,
      denied: { 401: 'jeton refusé (401) : vérifie l’identifiant et le secret', 403: 'accès refusé (403) : le jeton doit avoir le rôle DatastoreAudit' },
      unreachable: 'le PBS ne répond pas',
    },
    path,
    timeoutMs,
  );
}

// --- API answers (subset) ---------------------------------------------------------------

interface ApiDatastore {
  store: string;
}
interface ApiNamespace {
  ns: string;
}
interface ApiGroup {
  'backup-type': string;
  'backup-id': string;
  'last-backup': number; // unix s
  'backup-count': number;
  owner?: string;
  comment?: string;
}
interface ApiSnapshot {
  'backup-type': string;
  'backup-id': string;
  'backup-time': number;
  size?: number;
  verification?: { state: string };
}
interface ApiUsage {
  store: string;
  total?: number;
  used?: number;
  avail?: number;
}

export const groupKey = (store: string, ns: string, type: string, id: string) => `${store}/${ns}/${type}/${id}`;

// Groups of one namespace, with the size and verification of their last snapshot.
export const HISTORY = 30;

export function mergeGroups(store: string, ns: string, groups: ApiGroup[], snapshots: ApiSnapshot[]) {
  const last = new Map<string, ApiSnapshot>();
  const times = new Map<string, number[]>();
  for (const s of snapshots) {
    const k = `${s['backup-type']}/${s['backup-id']}`;
    const cur = last.get(k);
    if (!cur || s['backup-time'] > cur['backup-time']) last.set(k, s);
    times.set(k, [...(times.get(k) ?? []), s['backup-time'] * 1000]);
  }
  return groups.map((g) => {
    const s = last.get(`${g['backup-type']}/${g['backup-id']}`);
    const verify = s?.verification?.state === 'ok' ? 'ok' : s?.verification?.state === 'failed' ? 'failed' : null;
    return {
      _id: groupKey(store, ns, g['backup-type'], g['backup-id']),
      store,
      ns,
      type: g['backup-type'],
      backupId: g['backup-id'],
      ...(g.comment ? { comment: g.comment } : {}),
      ...(g.owner ? { owner: g.owner } : {}),
      count: g['backup-count'],
      lastBackup: g['last-backup'] * 1000,
      size: s?.size ?? null,
      verify,
      // dates of the last snapshots, oldest first: the rhythm of the backups and the timeline
      times: (times.get(`${g['backup-type']}/${g['backup-id']}`) ?? []).sort((a, b) => a - b).slice(-HISTORY),
    } as const;
  });
}

// --- rhythm and threshold ------------------------------------------------------------------

const HOUR = 3600_000;

// Usual interval between two backups of a group: median of the last intervals (at least 3 of them).
export function learnedInterval(times: number[]): number | null {
  const t = [...new Set(times)].sort((a, b) => a - b);
  if (t.length < 4) return null;
  const gaps = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

// Finest period a prune policy keeps: backups are expected at least that often.
export interface KeepOptions {
  'keep-hourly'?: number;
  'keep-daily'?: number;
  'keep-weekly'?: number;
  'keep-monthly'?: number;
  'keep-yearly'?: number;
}

export function retentionInterval(k: KeepOptions): number | null {
  if (k['keep-hourly']) return HOUR;
  if (k['keep-daily']) return 24 * HOUR;
  if (k['keep-weekly']) return 7 * 24 * HOUR;
  if (k['keep-monthly']) return 31 * 24 * HOUR;
  if (k['keep-yearly']) return 366 * 24 * HOUR;
  return null;
}

export type ThresholdSource = 'manual' | 'learned' | 'retention' | 'default' | 'schedule';

// a scheduled backup is expected at most this long after its start time
export const SCHEDULE_GRACE = 2 * HOUR;

type StateInput = Pick<BackupDoc, 'lastBackup' | 'verify' | 'staleHours' | 'gone' | 'times' | 'retention' | 'pve' | 'managed'>;

// Schedule of a group: the PVE jobs writing it, or the backup job of the hub; with the last run.
export function planOf(b: Pick<BackupDoc, 'pve' | 'managed'>) {
  if (b.pve) return { tz: b.pve.tz, jobs: b.pve.jobs, last: b.pve.lastTask ?? null };
  if (b.managed) return { tz: b.managed.tz, jobs: [{ schedule: b.managed.schedule, enabled: b.managed.enabled }], last: b.managed.lastRun ?? null };
  return null;
}

// Expected snapshot of a scheduled group: the last start of its enabled jobs, more than the grace
// period ago (a job that just started has until then). null: no enabled job with a schedule this hub
// understands (the group then falls back to its rhythm).
export function scheduleExpectation(b: Pick<BackupDoc, 'pve' | 'managed'>, now = Date.now()) {
  const plan = planOf(b);
  if (!plan?.jobs.length) return null;
  const enabled = plan.jobs.filter((j) => j.enabled);
  if (!enabled.length) return { disabled: true as const };
  let expected: number | null = null;
  let period: number | null = null;
  for (const j of enabled) {
    const spec = parseCalendar(j.schedule);
    if (!spec) continue;
    const prev = previousRun(spec, now - SCHEDULE_GRACE, plan.tz);
    if (prev === null) continue;
    const next = nextRun(spec, prev, plan.tz);
    if (expected === null || prev > expected) expected = prev;
    if (next !== null && (period === null || next - prev < period)) period = next - prev;
  }
  return expected === null ? null : { disabled: false as const, expected, period: period ?? 24 * HOUR };
}

// Age after which a group is late: its own threshold; else, written by PVE jobs, one period of its
// schedule plus the grace; else 1.5 x its rhythm (2 h of margin at least), the rhythm being learned from
// its history, else given by the retention, else the default threshold.
export function effectiveThreshold(b: Pick<BackupDoc, 'staleHours' | 'times' | 'retention' | 'pve' | 'managed'>, defaultHours: number, now = Date.now()) {
  const learned = learnedInterval(b.times ?? []);
  if (b.staleHours) return { hours: b.staleHours, source: 'manual' as ThresholdSource, interval: learned };
  const sched = scheduleExpectation(b, now);
  if (sched && !sched.disabled) {
    return { hours: Math.round(((sched.period + SCHEDULE_GRACE) / HOUR) * 10) / 10, source: 'schedule' as ThresholdSource, interval: sched.period };
  }
  const interval = learned ?? b.retention ?? null;
  if (!interval) return { hours: defaultHours, source: 'default' as ThresholdSource, interval: null };
  const ms = Math.max(1.5 * interval, interval + 2 * HOUR);
  return { hours: Math.round((ms / HOUR) * 10) / 10, source: (learned ? 'learned' : 'retention') as ThresholdSource, interval };
}

// task_failed: the last run (vzdump task, or run of the agent) failed after the last snapshot;
// disabled: every job writing the group is disabled; not_synced: the agent has not applied the
// current definition of a backup job of the hub.
export type BackupState = 'ok' | 'stale' | 'failed' | 'gone' | 'task_failed' | 'disabled' | 'not_synced';

export function backupState(b: StateInput, defaultHours: number, now = Date.now()): BackupState {
  if (b.gone) return 'gone';
  if (b.verify === 'failed') return 'failed';
  const last = planOf(b)?.last;
  if (last && !last.ok && last.at > b.lastBackup) return 'task_failed';
  if (b.managed && !b.managed.synced) return 'not_synced';
  const sched = b.staleHours ? null : scheduleExpectation(b, now);
  if (sched?.disabled) return 'disabled';
  if (sched) return b.lastBackup < sched.expected ? 'stale' : 'ok';
  return now - b.lastBackup > effectiveThreshold(b, defaultHours, now).hours * HOUR ? 'stale' : 'ok';
}

export function backupDto(b: BackupDoc, defaultHours: number, now = Date.now()) {
  const { _id, hostId, seenAt, ...rest } = b;
  const t = effectiveThreshold(b, defaultHours, now);
  return {
    id: _id,
    ...rest,
    hostId: hostId ? hostId.toHexString() : null,
    seenAt,
    state: backupState(b, defaultHours, now),
    threshold: t.hours,
    thresholdSource: t.source,
    interval: t.interval,
    // PVE jobs and backup job of the hub, with their schedule in words
    pve: b.pve ? { ...b.pve, jobs: b.pve.jobs.map((j) => ({ ...j, scheduleText: describeCalendar(j.schedule) })) } : null,
    managed: b.managed ? { ...b.managed, scheduleText: describeCalendar(b.managed.schedule) } : null,
  };
}

// Group of no host: just enough to recognise it and attach it from the host page.
export function orphanDto(b: BackupDoc) {
  return { id: b._id, store: b.store, ns: b.ns, type: b.type, backupId: b.backupId, comment: b.comment ?? null, lastBackup: b.lastBackup, count: b.count, gone: !!b.gone };
}

// Prune jobs (PBS 2.2+) and the keep-* options of the datastores (older ones): the finest
// period kept per "<store>/<ns>". A job also covers the namespaces below its own.
export function retentionMap(
  jobs: ({ store: string; ns?: string; disable?: boolean } & KeepOptions)[],
  stores: ({ name: string } & KeepOptions)[],
) {
  const out: { store: string; ns: string; interval: number }[] = [];
  for (const d of stores) {
    const i = retentionInterval(d);
    if (i) out.push({ store: d.name, ns: '', interval: i });
  }
  for (const j of jobs) {
    const i = retentionInterval(j);
    if (i && !j.disable) out.push({ store: j.store, ns: j.ns ?? '', interval: i });
  }
  return (store: string, ns: string) => {
    let best: { len: number; interval: number } | null = null;
    for (const r of out) {
      const covers = r.store === store && (r.ns === '' || ns === r.ns || ns.startsWith(`${r.ns}/`));
      if (covers && (!best || r.ns.length > best.len || (r.ns.length === best.len && r.interval < best.interval))) best = { len: r.ns.length, interval: r.interval };
    }
    return best?.interval ?? null;
  };
}

// --- poll ---------------------------------------------------------------------------------

let polling: Promise<void> | null = null;

export function pollPbs(log?: FastifyBaseLogger) {
  // one poll at a time: a refresh during a poll waits for it
  polling ??= doPoll(log).finally(() => (polling = null));
  return polling;
}

async function doPoll(log?: FastifyBaseLogger) {
  const s = await loadPbsSettings();
  if (!s.enabled || !s.url || !s.tokenId) return;
  try {
    const stores = await pbsGet<ApiDatastore[]>(s, '/admin/datastore');
    const found: ReturnType<typeof mergeGroups>[number][] = [];
    for (const { store } of stores) {
      const e = encodeURIComponent(store);
      // namespaces need PBS 2.2+; without them, only the root namespace
      const nss = await pbsGet<ApiNamespace[]>(s, `/admin/datastore/${e}/namespace`).catch(() => [{ ns: '' }]);
      for (const { ns } of nss) {
        const q = ns ? `?ns=${encodeURIComponent(ns)}` : '';
        const [groups, snapshots] = await Promise.all([
          pbsGet<ApiGroup[]>(s, `/admin/datastore/${e}/groups${q}`),
          pbsGet<ApiSnapshot[]>(s, `/admin/datastore/${e}/snapshots${q}`),
        ]);
        found.push(...mergeGroups(store, ns, groups, snapshots));
      }
    }
    // retention: read when the token may (Datastore.Audit is not always enough), ignored otherwise
    const jobs = await pbsGet<Parameters<typeof retentionMap>[0]>(s, '/config/prune').catch(() => []);
    const storeConfs = await pbsGet<Parameters<typeof retentionMap>[1]>(s, '/config/datastore').catch(() => []);
    const retention = retentionMap(jobs, storeConfs);
    const usage = await pbsGet<ApiUsage[]>(s, '/status/datastore-usage').catch(() => []);
    const datastores: PbsDatastoreUsage[] = usage
      .filter((u) => typeof u.total === 'number')
      .map((u) => ({ store: u.store, total: u.total!, used: u.used ?? 0, avail: u.avail ?? 0 }));

    const now = new Date();
    // the host of a group is only ever chosen by hand, from the host page
    for (const g of found) {
      await backups.updateOne(
        { _id: g._id },
        { $set: { ...g, retention: retention(g.store, g.ns), seenAt: now }, $setOnInsert: { hostId: null }, $unset: { gone: '', placeholder: '' } },
        { upsert: true },
      );
    }
    // groups pruned from the PBS are kept as gone: an attached one is reported, an orphan can be forgotten
    // placeholders of PVE jobs (never backed up yet) are not on the PBS by definition
    await backups.updateMany({ seenAt: { $lt: now }, placeholder: { $ne: true } }, { $set: { gone: true } });
    await settings.updateOne({ _id: 'pbs' }, { $set: { polledAt: now, pollError: null, datastores } }, { upsert: true });
    log?.info({ groups: found.length }, 'PBS polled');
  } catch (err) {
    await settings.updateOne({ _id: 'pbs' }, { $set: { polledAt: new Date(), pollError: (err as Error).message } }, { upsert: true });
    log?.warn({ err }, 'PBS poll failed');
  }
  publish('backups', {});
}

// Groups of a deleted host become orphans.
export async function forgetHost(hostId: HostDoc['_id']) {
  await backups.deleteMany({ hostId, placeholder: true });
  await backups.updateMany({ hostId }, { $set: { hostId: null }, $unset: { source: '', pve: '', managed: '' } });
}

export function startPbsPoller(log: FastifyBaseLogger) {
  const run = () => pollPbs(log).catch((err) => log.error({ err }, 'PBS poll failed'));
  const first = setTimeout(run, 30_000);
  const timer = setInterval(run, 15 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
