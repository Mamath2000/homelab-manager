import type { FastifyBaseLogger } from 'fastify';
import { sha256 } from './crypto.js';
import { backups, hosts, settings } from './db.js';
import { publish } from './events.js';
import { appendJobLog, finishJob, startHubJob } from './jobs.js';
import { HISTORY, loadPbsSettings, pbsCall } from './pbs.js';
import type { BackupDoc, BackupOffsite, BackupSnapshot, JobDoc, PbsRemoteSettings } from './types.js';

// Copy of chosen backups to a secondary PBS ("copie déportée"). The secondary pulls from the main PBS:
// a remote entry (REMOTE_NAME) with a read-only token of the main PBS, and one sync job per group copied,
// owned by the token of the hub, which can neither delete a snapshot nor create a namespace. The hub only
// touches its own remote and the sync jobs named hlm-*; the purges stay the business of the PBS.

export const REMOTE_NAME = 'hlm-main';
export const JOB_PREFIX = 'hlm-';
// one snapshot per run, the last one: the backup is on both PBS, the secondary prunes with its own retention
export const TRANSFER_LAST = 1;
export const OFFSITE_DEFAULTS = { schedule: '06:00', rateIn: null } as const;
export const RATE_RE = /^\d{1,6}(\.\d{1,3})?\s?(B|KB|MB|GB|KiB|MiB|GiB)$/;

export const DEFAULT_REMOTE: PbsRemoteSettings = {
  _id: 'pbs-remote',
  enabled: false,
  url: '',
  fingerprint: '',
  store: '',
  tokenId: '',
  tokenSecret: '',
  readerTokenId: '',
  readerTokenSecret: '',
};

export async function loadRemoteSettings(): Promise<PbsRemoteSettings> {
  return { ...DEFAULT_REMOTE, ...((await settings.findOne({ _id: 'pbs-remote' })) as PbsRemoteSettings | null), _id: 'pbs-remote' };
}

// the secondary can be used: address, token of the hub, target datastore, reader token
export const remoteReady = (r: PbsRemoteSettings) => !!(r.enabled && r.url && r.store && r.tokenId && r.tokenSecret && r.readerTokenId && r.readerTokenSecret);

const ROLE = 'DatastoreBackup + DatastoreAudit sur le datastore cible et RemoteAdmin sur /remote';
const call = <T>(r: PbsRemoteSettings, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => pbsCall<T>(r, method, path, body, ROLE);

// --- what can be copied -------------------------------------------------------------------

// Groups of Home Assistant are not on the PBS; a placeholder has never been written.
export function notCopiable(b: Pick<BackupDoc, 'source' | 'placeholder'>) {
  if (b.source === 'haos') return 'sauvegarde Home Assistant : elle n’est pas sur le PBS';
  if (b.placeholder) return 'sauvegarde jamais écrite sur le PBS';
  return null;
}

export const syncJobId = (groupKey: string) => `${JOB_PREFIX}${sha256(groupKey).slice(0, 12)}`;

// The same group (namespace + type/id) copied from two datastores would land in the same target group.
export function sameGroupElsewhere(b: Pick<BackupDoc, '_id' | 'ns' | 'type' | 'backupId'>, enabled: Pick<BackupDoc, '_id' | 'store' | 'ns' | 'type' | 'backupId'>[]) {
  return enabled.find((o) => o._id !== b._id && o.ns === b.ns && o.type === b.type && o.backupId === b.backupId) ?? null;
}

// --- sync jobs ----------------------------------------------------------------------------

// Fields of a sync job the hub sets; the others (comment aside) are left to the PBS.
export interface SyncJobConfig {
  id: string;
  store: string;
  ns?: string;
  remote: string;
  'remote-store': string;
  'remote-ns'?: string;
  'max-depth': number;
  'group-filter': string[];
  'remove-vanished': boolean;
  owner: string;
  schedule: string;
  'transfer-last'?: number;
  'rate-in'?: string;
  comment: string;
}

const OPTIONAL: (keyof SyncJobConfig)[] = ['ns', 'remote-ns', 'transfer-last', 'rate-in'];
const COMPARED: (keyof SyncJobConfig)[] = ['store', 'ns', 'remote', 'remote-store', 'remote-ns', 'max-depth', 'group-filter', 'remove-vanished', 'owner', 'schedule', 'transfer-last', 'rate-in', 'comment'];

// Sync job of one group: target namespace = source namespace (no level per datastore: a backup moved from
// a datastore to another stays one target group), never recursive, always exactly one group.
export function desiredJob(b: Pick<BackupDoc, '_id' | 'store' | 'ns' | 'type' | 'backupId' | 'comment'>, o: Pick<BackupOffsite, 'schedule' | 'rateIn'>, r: Pick<PbsRemoteSettings, 'store' | 'tokenId'>): SyncJobConfig {
  if (!b.type || !b.backupId) throw new Error(`groupe incomplet : ${b._id}`);
  return {
    id: syncJobId(b._id),
    store: r.store,
    ...(b.ns ? { ns: b.ns } : {}),
    remote: REMOTE_NAME,
    'remote-store': b.store,
    ...(b.ns ? { 'remote-ns': b.ns } : {}),
    'max-depth': 0,
    'group-filter': [`group:${b.type}/${b.backupId}`],
    'remove-vanished': false,
    owner: r.tokenId,
    schedule: o.schedule,
    'transfer-last': TRANSFER_LAST,
    ...(o.rateIn ? { 'rate-in': o.rateIn } : {}),
    comment: `Homelab Manager : ${b._id}`,
  };
}

const norm = (v: unknown) => JSON.stringify(v ?? null);

// What to do on the secondary: create the missing jobs, update the ones that differ, remove the hlm-* jobs
// no longer wanted. The other jobs of the PBS are never touched.
export function planSync(desired: SyncJobConfig[], existing: Partial<SyncJobConfig>[]) {
  for (const d of desired) if (d['group-filter'].length !== 1) throw new Error(`job ${d.id} : un seul groupe par job`);
  const mine = new Map(existing.filter((e) => e.id?.startsWith(JOB_PREFIX)).map((e) => [e.id!, e]));
  const create: SyncJobConfig[] = [];
  const update: SyncJobConfig[] = [];
  for (const d of desired) {
    const e = mine.get(d.id);
    if (!e) create.push(d);
    else if (COMPARED.some((k) => norm(d[k]) !== norm(e[k]))) update.push(d);
    mine.delete(d.id);
  }
  return { create, update, remove: [...mine.keys()] };
}

// PUT of a sync job: the fields, and the optional ones to clear
export function updateBody(d: SyncJobConfig) {
  const { id, ...fields } = d;
  void id;
  const del = OPTIONAL.filter((k) => d[k] === undefined);
  return { ...fields, ...(del.length ? { delete: del } : {}) };
}

// --- remote entry -------------------------------------------------------------------------

export function remoteEntry(main: { url: string; fingerprint: string }, r: Pick<PbsRemoteSettings, 'readerTokenId' | 'readerTokenSecret'>) {
  const u = new URL(main.url);
  const entry = {
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: Number(u.port || 8007),
    'auth-id': r.readerTokenId,
    ...(main.fingerprint ? { fingerprint: main.fingerprint } : {}),
  };
  // the secret is part of the hash: a new reader token rewrites the entry
  return { entry, hash: sha256(JSON.stringify({ ...entry, secret: sha256(r.readerTokenSecret) })) };
}

async function ensureRemote(r: PbsRemoteSettings) {
  const main = await loadPbsSettings();
  if (!main.url) throw new Error('PBS principal non configuré');
  const { entry, hash } = remoteEntry(main, r);
  if (r.remoteHash === hash) return;
  const exists = await call(r, 'GET', `/config/remote/${REMOTE_NAME}`).then(
    () => true,
    (err: Error) => (/HTTP 404|HTTP 400/.test(err.message) ? false : Promise.reject(err)),
  );
  const body = { ...entry, password: r.readerTokenSecret, comment: 'Homelab Manager : PBS principal' };
  if (exists) await call(r, 'PUT', `/config/remote/${REMOTE_NAME}`, { ...body, ...(entry.fingerprint ? {} : { delete: ['fingerprint'] }) });
  else await call(r, 'POST', '/config/remote', { name: REMOTE_NAME, ...body });
  await settings.updateOne({ _id: 'pbs-remote' }, { $set: { remoteHash: hash } });
}

// --- reconciliation -----------------------------------------------------------------------

type Copied = Pick<BackupDoc, '_id' | 'store' | 'ns' | 'type' | 'backupId' | 'comment' | 'offsite' | 'hostId' | 'managed'>;

async function enabledGroups(): Promise<Copied[]> {
  return backups
    .find(
      { 'offsite.enabled': true },
      { projection: { _id: 1, store: 1, ns: 1, type: 1, backupId: 1, comment: 1, offsite: 1, source: 1, placeholder: 1, hostId: 1, managed: 1 } },
    )
    .toArray();
}

// Remote entry, then the hlm-* sync jobs made to match the groups copied. An error on one job is kept on
// its group (offsite.error), the others go on.
export async function reconcile(r: PbsRemoteSettings, log?: FastifyBaseLogger) {
  await ensureRemote(r);
  const groups = (await enabledGroups()).filter((g) => !notCopiable(g as BackupDoc));
  const desired = groups.map((g) => desiredJob(g, g.offsite!, r));
  const existing = await call<Partial<SyncJobConfig>[]>(r, 'GET', '/config/sync');
  const plan = planSync(desired, existing);
  const errors = new Map<string, string>();
  for (const d of plan.create) await call(r, 'POST', '/config/sync', d).catch((err: Error) => errors.set(d.id, err.message));
  for (const d of plan.update) await call(r, 'PUT', `/config/sync/${d.id}`, updateBody(d)).catch((err: Error) => errors.set(d.id, err.message));
  for (const id of plan.remove) await call(r, 'DELETE', `/config/sync/${id}`).catch((err: Error) => log?.warn({ err, id }, 'sync job not removed'));
  for (const g of groups) {
    const error = errors.get(g.offsite!.jobId) ?? null;
    if ((g.offsite!.error ?? null) !== error) await backups.updateOne({ _id: g._id }, { $set: { 'offsite.error': error } });
  }
  if (plan.create.length || plan.update.length || plan.remove.length) log?.info({ create: plan.create.length, update: plan.update.length, remove: plan.remove.length }, 'offsite sync jobs reconciled');
}

// --- poll of the secondary ----------------------------------------------------------------

interface SyncJobStatus {
  id: string;
  'last-run-upid'?: string;
  'last-run-state'?: string; // "OK" or the error
  'last-run-endtime'?: number;
  'next-run'?: number;
}
interface ApiGroup {
  'backup-type': string;
  'backup-id': string;
  'last-backup': number;
  'backup-count': number;
}
interface ApiSnapshot {
  'backup-type': string;
  'backup-id': string;
  'backup-time': number;
  size?: number;
  verification?: { state: string };
}

type Copy = Required<Pick<BackupOffsite, 'lastBackup' | 'count' | 'verify' | 'size' | 'times'>>;

const verifyOf = (s: ApiSnapshot | undefined): BackupSnapshot['verify'] => (s?.verification?.state === 'ok' ? 'ok' : s?.verification?.state === 'failed' ? 'failed' : null);

// Groups of one namespace of the secondary (key type/id): their last snapshot and the last HISTORY ones
// (the timeline of the copy, same window as the one of the main PBS).
export function copiedGroups(list: ApiGroup[], snaps: ApiSnapshot[]) {
  const times = new Map<string, ApiSnapshot[]>();
  for (const s of snaps) {
    const k = `${s['backup-type']}/${s['backup-id']}`;
    times.set(k, [...(times.get(k) ?? []), s]);
  }
  const out = new Map<string, Copy>();
  for (const g of list) {
    const k = `${g['backup-type']}/${g['backup-id']}`;
    const sorted = (times.get(k) ?? []).sort((a, b) => a['backup-time'] - b['backup-time']);
    const last = sorted[sorted.length - 1];
    out.set(k, {
      lastBackup: g['last-backup'] * 1000,
      count: g['backup-count'],
      verify: verifyOf(last),
      size: last?.size ?? null,
      times: sorted.slice(-HISTORY).map((s) => ({ t: s['backup-time'] * 1000, verify: verifyOf(s), size: s.size ?? null })),
    });
  }
  return out;
}

// Start time of a task, from its UPID (UPID:node:pid:pstart:taskid:starttime:...; hexadecimal seconds).
export function upidStart(upid: string | undefined) {
  const f = upid?.split(':');
  const t = f && f[0] === 'UPID' && f.length > 6 ? parseInt(f[5], 16) : NaN;
  return Number.isFinite(t) ? t * 1000 : null;
}

export function lastRunOf(s: SyncJobStatus | undefined): BackupOffsite['lastRun'] {
  if (!s?.['last-run-endtime'] || !s['last-run-state']) return null;
  const end = s['last-run-endtime'] * 1000;
  const ok = s['last-run-state'] === 'OK';
  return { start: upidStart(s['last-run-upid']) ?? end, end, ok, ...(ok ? {} : { error: s['last-run-state'] }) };
}

let running: Promise<void> | null = null;
let queued: Promise<void> | null = null;

// One poll at a time; a change made during a poll gets a poll of its own once it ends (the requests made
// meanwhile share that one).
export function pollOffsite(log?: FastifyBaseLogger): Promise<void> {
  if (!running) {
    running = doPoll(log).finally(() => (running = null));
    return running;
  }
  queued ??= running.then(() => {
    queued = null;
    return pollOffsite(log);
  });
  return queued;
}

async function doPoll(log?: FastifyBaseLogger) {
  const r = await loadRemoteSettings();
  if (!remoteReady(r)) return;
  try {
    await reconcile(r, log);
    const status = new Map((await call<SyncJobStatus[]>(r, 'GET', '/admin/sync')).map((s) => [s.id, s]));
    const groups = (await enabledGroups()).filter((g) => !notCopiable(g as BackupDoc));
    const e = encodeURIComponent(r.store);
    const seen = new Map<string, Copy>();
    for (const ns of new Set(groups.map((g) => g.ns))) {
      const q = ns ? `?ns=${encodeURIComponent(ns)}` : '';
      // a namespace missing on the secondary: its groups show as never copied
      const [list, snaps] = await Promise.all([
        call<ApiGroup[]>(r, 'GET', `/admin/datastore/${e}/groups${q}`).catch(() => []),
        call<ApiSnapshot[]>(r, 'GET', `/admin/datastore/${e}/snapshots${q}`).catch(() => []),
      ]);
      for (const [k, c] of copiedGroups(list, snaps)) seen.set(`${ns}/${k}`, c);
    }
    // only offsite.* is written: the poll of the main PBS owns the rest of the group
    for (const g of groups) {
      const copy = seen.get(`${g.ns}/${g.type}/${g.backupId}`);
      const st = status.get(g.offsite!.jobId);
      // a run the hub did not see (hub stopped meanwhile): recorded as a job too, with its log
      const upid = st?.['last-run-upid'];
      if (upid && upid !== g.offsite!.recordedUpid && upid !== g.offsite!.running?.upid && !following.has(upid)) followTask(r, g, upid, 'schedule', log).catch(() => {});
      await backups.updateOne(
        { _id: g._id },
        {
          $set: {
            'offsite.lastBackup': copy?.lastBackup ?? null,
            'offsite.count': copy?.count ?? 0,
            'offsite.verify': copy?.verify ?? null,
            'offsite.size': copy?.size ?? null,
            'offsite.times': copy?.times ?? [],
            'offsite.lastRun': lastRunOf(st),
            'offsite.nextRun': st?.['next-run'] ? st['next-run'] * 1000 : null,
          },
        },
      );
    }
    const usage = (await call<{ store: string; total?: number; used?: number; avail?: number }[]>(r, 'GET', '/status/datastore-usage').catch(() => [])).find(
      (u) => u.store === r.store && typeof u.total === 'number',
    );
    await settings.updateOne(
      { _id: 'pbs-remote' },
      { $set: { polledAt: new Date(), pollError: null, usage: usage ? { store: usage.store, total: usage.total!, used: usage.used ?? 0, avail: usage.avail ?? 0 } : null } },
    );
    log?.info({ groups: groups.length }, 'secondary PBS polled');
  } catch (err) {
    await settings.updateOne({ _id: 'pbs-remote' }, { $set: { polledAt: new Date(), pollError: (err as Error).message } });
    log?.warn({ err }, 'secondary PBS poll failed');
  }
  publish('backups', {});
}

export function startOffsitePoller(log: FastifyBaseLogger) {
  const run = () => pollOffsite(log).catch((err) => log.error({ err }, 'secondary PBS poll failed'));
  const watch = () => watchTasks(log).catch((err) => log.warn({ err }, 'secondary PBS tasks not read'));
  // after the first poll of the main PBS (30 s)
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, 15 * 60_000);
  // copies started by the schedule of the secondary: seen within WATCH_MS, then followed
  const watcher = setInterval(watch, WATCH_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    clearInterval(watcher);
  };
}

// --- runs of the copy: tasks of the secondary, followed as jobs of the hub -----------------

const WATCH_MS = 30_000;
const FOLLOW_MS = 2_000;
const LOG_PAGE = 500;

interface ApiTask {
  upid: string;
  worker_type?: string;
  worker_id?: string;
  endtime?: number;
}
interface ApiTaskLine {
  n: number;
  t: string;
}

const taskPath = (upid: string) => `/nodes/${encodeURIComponent(upid.split(':')[1] || 'localhost')}/tasks/${encodeURIComponent(upid)}`;

// "OK" and "WARNINGS: n" end well; anything else is the error of the task
export const taskOk = (exit: string) => exit === 'OK' || /^WARNINGS: \d+$/.test(exit);

// The group a running sync task belongs to: its worker id ends with the id of the job (hlm-<hash>).
export function taskGroup<T extends Pick<Copied, 'offsite'>>(t: ApiTask, groups: T[]) {
  const w = t.worker_id ?? t.upid;
  return groups.find((g) => g.offsite?.jobId && (w === g.offsite.jobId || w.endsWith(`:${g.offsite.jobId}`))) ?? null;
}

const copyLabel = (b: Pick<Copied, 'managed' | 'comment' | 'type' | 'backupId'>) => b.managed?.name ?? (b.comment ? `${b.comment} (${b.type}/${b.backupId})` : `${b.type}/${b.backupId}`);

const following = new Set<string>();
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

// Follows a task of the secondary until it ends: a job of the hub on the host of the group (console,
// Activité) with the log of the task, offsite.running meanwhile, then the result and a poll. A job left
// running by a previous hub process is taken up again. Returns the id of the job.
export async function followTask(r: PbsRemoteSettings, b: Copied, upid: string, trigger: JobDoc['trigger'], log?: FastifyBaseLogger) {
  if (following.has(upid)) return b.offsite?.running?.upid === upid ? b.offsite.running.jobId : null;
  following.add(upid);
  try {
    const host = b.hostId ? await hosts.findOne({ _id: b.hostId }, { projection: { _id: 1, name: 1 } }) : null;
    const start = upidStart(upid) ?? Date.now();
    const again = b.offsite?.running?.upid === upid ? b.offsite.running.jobId : undefined;
    const job = host ? await startHubJob(host, 'offsite_run', trigger, { backupJobName: copyLabel(b), createdAt: new Date(start) }, again) : null;
    const jobId = job?._id.toHexString() ?? '';
    const hostId = host?._id.toHexString() ?? '';
    await backups.updateOne({ _id: b._id }, { $set: { 'offsite.running': { upid, start, jobId } } });
    publish('backups', {});
    void track(r, b, upid, start, { jobId, hostId, lines: job?.log ? job.log.split('\n').length - 1 : 0 }, log);
    return jobId || null;
  } catch (err) {
    following.delete(upid);
    throw err;
  }
}

async function track(r: PbsRemoteSettings, b: Copied, upid: string, start: number, job: { jobId: string; hostId: string; lines: number }, log?: FastifyBaseLogger) {
  let n = job.lines;
  const read = async () => {
    for (;;) {
      const lines = await call<ApiTaskLine[]>(r, 'GET', `${taskPath(upid)}/log?start=${n}&limit=${LOG_PAGE}`);
      n += lines.length;
      if (job.jobId && lines.length) appendJobLog(job.jobId, job.hostId, lines.map((l) => `${l.t}\n`).join(''));
      if (lines.length < LOG_PAGE) return;
    }
  };
  let exit = '';
  let fails = 0;
  while (!exit) {
    try {
      await read();
      const st = await call<{ status: string; exitstatus?: string }>(r, 'GET', `${taskPath(upid)}/status`);
      fails = 0;
      if (st.status === 'stopped') {
        await read();
        exit = st.exitstatus || 'fin inconnue';
        break;
      }
    } catch (err) {
      if (++fails >= 5) exit = `suivi de la tâche impossible : ${(err as Error).message}`;
    }
    if (!exit) await sleep(FOLLOW_MS);
  }
  const ok = taskOk(exit);
  try {
    if (job.jobId) await finishJob(job.jobId, job.hostId, ok ? 0 : 1, ok ? undefined : exit);
    await backups.updateOne(
      { _id: b._id },
      { $set: { 'offsite.running': null, 'offsite.recordedUpid': upid, 'offsite.lastRun': { start, end: Date.now(), ok, ...(ok ? {} : { error: exit }) } } },
    );
  } finally {
    following.delete(upid);
  }
  log?.info({ group: b._id, upid, ok }, 'offsite copy ended');
  // the copy is on the secondary: read it now
  await pollOffsite(log).catch(() => {});
}

// Copies running on the secondary that the hub does not follow yet: started by its schedule, or left by a
// previous hub process.
async function watchTasks(log?: FastifyBaseLogger) {
  const r = await loadRemoteSettings();
  if (!remoteReady(r)) return;
  const groups = (await enabledGroups()).filter((g) => !notCopiable(g as BackupDoc));
  if (!groups.length) return;
  for (const g of groups) if (g.offsite?.running && !following.has(g.offsite.running.upid)) await followTask(r, g, g.offsite.running.upid, 'schedule', log);
  const tasks = await call<ApiTask[]>(r, 'GET', '/nodes/localhost/tasks?running=1&typefilter=syncjob&limit=100');
  for (const t of tasks) {
    if (t.endtime || following.has(t.upid)) continue;
    const g = taskGroup(t, groups);
    if (g) await followTask(r, g, t.upid, 'schedule', log);
  }
}

// --- state --------------------------------------------------------------------------------

// ok: the last snapshot of the main PBS older than the last run is on the secondary; pending: enabled,
// never run yet; late: such a snapshot did not arrive; failed: the last run failed. null: not copied.
export type OffsiteState = 'ok' | 'pending' | 'late' | 'failed';

export function offsiteState(b: Pick<BackupDoc, 'offsite' | 'times' | 'lastBackup'>): OffsiteState | null {
  const o = b.offsite;
  if (!o?.enabled) return null;
  if (o.error) return 'failed';
  if (!o.lastRun) return 'pending';
  if (!o.lastRun.ok) return 'failed';
  // snapshots of the main PBS older than the start of the last run
  const before = [...(b.times ?? []).map((s) => s.t), b.lastBackup].filter((t) => t && t <= o.lastRun!.start);
  if (!before.length) return 'ok';
  return (o.lastBackup ?? 0) >= Math.max(...before) ? 'ok' : 'late';
}

// --- actions ------------------------------------------------------------------------------

// Namespaces of the target datastore: the sync job cannot create them (no Datastore.Modify).
export async function targetNamespaces(r: PbsRemoteSettings) {
  const list = await call<{ ns: string }[]>(r, 'GET', `/admin/datastore/${encodeURIComponent(r.store)}/namespace`);
  return list.map((n) => n.ns);
}

export async function runSyncJob(r: PbsRemoteSettings, jobId: string) {
  return call<string>(r, 'POST', `/admin/sync/${encodeURIComponent(jobId)}/run`);
}
