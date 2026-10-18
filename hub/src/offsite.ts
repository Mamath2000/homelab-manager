import type { FastifyBaseLogger } from 'fastify';
import type { ObjectId } from 'mongodb';
import { isOnline, sendToAgent } from './agents.js';
import { DEFAULT_TIMEZONE } from './backupJobs.js';
import { sha256 } from './crypto.js';
import { backups, hosts, parseId, settings } from './db.js';
import { publish } from './events.js';
import { appendJobLog, finishJob, startHubJob } from './jobs.js';
import { HISTORY, loadPbsSettings, pbsCall } from './pbs.js';
import type { BackupDoc, BackupOffsite, BackupSnapshot, JobDoc, OffsiteSeriesReport, PbsRemoteSettings } from './types.js';

// Copy of chosen backups to a secondary PBS ("copie déportée"). The secondary pulls from the main PBS:
// a remote entry (REMOTE_NAME) with a read-only token of the main PBS, and one sync job per datastore and
// namespace copied (the group filter of PBS ignores the namespace: a job per namespace keeps it exact),
// owned by the token of the hub, which can neither delete a snapshot nor create a namespace. The hub only
// touches its own remote and the sync jobs named hlm-*; the purges stay the business of the PBS.
// The sync jobs have no schedule: every day at the start time, the agent of the secondary starts them one
// after the other (agent offsite.go, #186) from the definition the hub sends it (offsite_sync); the hub
// configures, follows and alerts.

export const REMOTE_NAME = 'hlm-main';
export const JOB_PREFIX = 'hlm-';
// one snapshot per run, the last verified one: the backup is on both PBS, the secondary prunes with its own retention
export const TRANSFER_LAST = 1;
// the main backups start at 02:30 and are verified right after (verify-new)
export const DEFAULT_START = '04:00';
// a verified snapshot not copied after this: a daily series missed it
export const LATE_HOURS = 30;
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const DEFAULT_REMOTE: PbsRemoteSettings = {
  _id: 'pbs-remote',
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

export const startOf = (r: Pick<PbsRemoteSettings, 'startTime'>) => (r.startTime && HHMM_RE.test(r.startTime) ? r.startTime : DEFAULT_START);

// the secondary can be used: address, token of the hub, target datastore, reader token
export const remoteReady = (r: PbsRemoteSettings) => !!(r.url && r.store && r.tokenId && r.tokenSecret && r.readerTokenId && r.readerTokenSecret);

const ROLE = 'DatastoreBackup + DatastoreAudit sur le datastore cible et RemoteAdmin sur /remote';
const call = <T>(r: PbsRemoteSettings, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => pbsCall<T>(r, method, path, body, ROLE);

// --- what can be copied -------------------------------------------------------------------

// Groups of Home Assistant are not on the PBS; a placeholder has never been written.
export function notCopiable(b: Pick<BackupDoc, 'source' | 'placeholder'>) {
  if (b.source === 'haos') return 'sauvegarde Home Assistant : elle n’est pas sur le PBS';
  if (b.placeholder) return 'sauvegarde jamais écrite sur le PBS';
  return null;
}

// Sync job of a datastore and namespace of the main PBS: hlm-<store>[-<ns, / as .>], readable; a hash when
// it would exceed the 32 characters of a job id of PBS.
export function syncJobId(store: string, ns: string) {
  const id = `${JOB_PREFIX}${store}${ns ? `-${ns.replace(/\//g, '.')}` : ''}`;
  return id.length <= 32 ? id : `${JOB_PREFIX}${sha256(`${store}/${ns}`).slice(0, 12)}`;
}

export const jobLabel = (store: string, ns: string) => `${store} › ${ns || 'racine'}`;

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
  'transfer-last': number;
  'verified-only': boolean;
  'resync-corrupt': boolean;
  'worker-threads': number;
  comment: string;
  // set before #186, cleared
  schedule?: string;
  'rate-in'?: string;
}

const OPTIONAL: (keyof SyncJobConfig)[] = ['ns', 'remote-ns', 'schedule', 'rate-in'];
const COMPARED: (keyof SyncJobConfig)[] = [
  'store',
  'ns',
  'remote',
  'remote-store',
  'remote-ns',
  'max-depth',
  'group-filter',
  'remove-vanished',
  'owner',
  'transfer-last',
  'verified-only',
  'resync-corrupt',
  'worker-threads',
  'schedule',
  'rate-in',
  'comment',
];

type JobGroup = Pick<BackupDoc, '_id' | 'store' | 'ns' | 'type' | 'backupId'>;

// Sync jobs of the groups copied: one per datastore and namespace, target namespace = source namespace (no
// level per datastore: a backup moved from a datastore to another stays one target group), never recursive,
// the groups by an exact filter (sorted: stable). Only verified snapshots, the last one, corrupted copies
// pulled again, one group at a time; no schedule (the agent of the secondary), no limit of rate (the
// secondary is limited by its CPU).
export function desiredJobs(groups: JobGroup[], r: Pick<PbsRemoteSettings, 'store' | 'tokenId'>): SyncJobConfig[] {
  const by = new Map<string, { store: string; ns: string; filters: Set<string> }>();
  for (const g of groups) {
    if (!g.type || !g.backupId) throw new Error(`groupe incomplet : ${g._id}`);
    const id = syncJobId(g.store, g.ns);
    const j = by.get(id) ?? { store: g.store, ns: g.ns, filters: new Set<string>() };
    j.filters.add(`group:${g.type}/${g.backupId}`);
    by.set(id, j);
  }
  return [...by.entries()]
    .map(([id, j]) => ({
      id,
      store: r.store,
      ...(j.ns ? { ns: j.ns } : {}),
      remote: REMOTE_NAME,
      'remote-store': j.store,
      ...(j.ns ? { 'remote-ns': j.ns } : {}),
      'max-depth': 0,
      'group-filter': [...j.filters].sort(),
      'remove-vanished': false,
      owner: r.tokenId,
      'transfer-last': TRANSFER_LAST,
      'verified-only': true,
      'resync-corrupt': true,
      'worker-threads': 1,
      comment: `Homelab Manager : ${jobLabel(j.store, j.ns)}`,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const norm = (v: unknown) => JSON.stringify(v ?? null);

// What to do on the secondary: create the missing jobs, update the ones that differ, remove the hlm-* jobs
// no longer wanted (the jobs of one group of before #186 among them). The other jobs of the PBS are never
// touched.
export function planSync(desired: SyncJobConfig[], existing: Partial<SyncJobConfig>[]) {
  // an empty filter would copy the whole namespace
  for (const d of desired) if (!d['group-filter'].length) throw new Error(`job ${d.id} : aucun groupe`);
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
  const list = await backups
    .find(
      { 'offsite.enabled': true },
      { projection: { _id: 1, store: 1, ns: 1, type: 1, backupId: 1, comment: 1, offsite: 1, source: 1, placeholder: 1, hostId: 1, managed: 1 } },
    )
    .toArray();
  return list.filter((g) => !notCopiable(g as BackupDoc));
}

// Remote entry, then the hlm-* sync jobs made to match the groups copied. An error on one job is kept on
// its groups (offsite.error), the others go on; the job of each group is set again (ids of before #186).
export async function reconcile(r: PbsRemoteSettings, log?: FastifyBaseLogger) {
  await ensureRemote(r);
  const groups = await enabledGroups();
  const desired = desiredJobs(groups, r);
  const existing = await call<Partial<SyncJobConfig>[]>(r, 'GET', '/config/sync');
  const plan = planSync(desired, existing);
  const errors = new Map<string, string>();
  for (const d of plan.create) await call(r, 'POST', '/config/sync', d).catch((err: Error) => errors.set(d.id, err.message));
  for (const d of plan.update) await call(r, 'PUT', `/config/sync/${d.id}`, updateBody(d)).catch((err: Error) => errors.set(d.id, err.message));
  for (const id of plan.remove) await call(r, 'DELETE', `/config/sync/${id}`).catch((err: Error) => log?.warn({ err, id }, 'sync job not removed'));
  for (const g of groups) {
    const jobId = syncJobId(g.store, g.ns);
    const error = errors.get(jobId) ?? null;
    if ((g.offsite!.error ?? null) !== error || g.offsite!.jobId !== jobId) await backups.updateOne({ _id: g._id }, { $set: { 'offsite.error': error, 'offsite.jobId': jobId } });
  }
  if (plan.create.length || plan.update.length || plan.remove.length) log?.info({ create: plan.create.length, update: plan.update.length, remove: plan.remove.length }, 'offsite sync jobs reconciled');
}

// --- daily series started by the agent of the secondary -----------------------------------

// Host of the agent of the secondary, when it can start the series.
async function seriesHost(r: Pick<PbsRemoteSettings, 'agent'>) {
  const _id = r.agent?.hostId ? parseId(r.agent.hostId) : null;
  if (!_id) return null;
  const h = await hosts.findOne({ _id }, { projection: { _id: 1, name: 1, capabilities: 1 } });
  return h?.capabilities?.includes('offsite_series') ? h : null;
}

export interface OffsiteSpec {
  hash: string;
  container: string;
  jobs: string[];
  start: string;
  tz: string;
}

// Definition of the series for the agent; no job when the copy is disabled (the agent empties its series).
export function offsiteSpec(r: PbsRemoteSettings, groups: JobGroup[], tz = DEFAULT_TIMEZONE): OffsiteSpec {
  const body = {
    container: r.agent?.mode === 'container' ? (r.agent.container ?? '') : '',
    jobs: remoteReady(r) ? [...new Set(groups.filter((g) => g.type && g.backupId).map((g) => syncJobId(g.store, g.ns)))].sort() : [],
    start: startOf(r),
    tz,
  };
  return { hash: sha256(JSON.stringify(body)), ...body };
}

// Sends the definition to the agent of the secondary when it differs from the one it applied (force: at
// its connection).
export async function syncOffsiteAgent(force = false) {
  const r = await loadRemoteSettings();
  const host = await seriesHost(r);
  if (!host || !isOnline(host._id.toHexString())) return false;
  const spec = offsiteSpec(r, await enabledGroups());
  if (!force && spec.hash === r.agentAck) return false;
  return sendToAgent(host._id.toHexString(), { type: 'offsite_sync', offsite: spec });
}

// Disconnection of the secondary (disconnect.ts), r being its settings read before: the agent empties its
// series, then the hlm-* sync jobs and the remote entry of the hub go. The copies stay on the secondary.
export async function clearSecondary(r: PbsRemoteSettings) {
  const host = await seriesHost(r);
  if (host && isOnline(host._id.toHexString())) sendToAgent(host._id.toHexString(), { type: 'offsite_sync', offsite: offsiteSpec({ ...r, tokenSecret: '' }, []) });
  if (!r.url || !r.tokenSecret) return { syncJobs: 0, remote: false };
  const existing = await call<Partial<SyncJobConfig>[]>(r, 'GET', '/config/sync');
  const mine = existing.map((e) => e.id).filter((id): id is string => !!id?.startsWith(JOB_PREFIX));
  for (const id of mine) await call(r, 'DELETE', `/config/sync/${id}`);
  const remote = await call(r, 'DELETE', `/config/remote/${REMOTE_NAME}`).then(
    () => true,
    (err: Error) => (/HTTP 404|HTTP 400/.test(err.message) ? false : Promise.reject(err)),
  );
  return { syncJobs: mine.length, remote };
}

export async function onOffsiteHello(hostId: ObjectId) {
  const r = await loadRemoteSettings();
  if (r.agent?.hostId === hostId.toHexString()) await syncOffsiteAgent(true);
}

// The agent applied (or refused) the definition.
export async function onOffsiteSynced(hostId: ObjectId, hash: string | undefined, error: string | undefined, log?: FastifyBaseLogger) {
  const r = await loadRemoteSettings();
  if (r.agent?.hostId !== hostId.toHexString()) return;
  await settings.updateOne({ _id: 'pbs-remote' }, { $set: error ? { agentError: error } : { agentAck: hash ?? '', agentError: null } });
  if (error) log?.warn({ error }, 'offsite series definition refused by the agent');
  publish('backups', {});
}

// What the interface shows of the series: start, whether the agent runs it, and its last report.
export async function seriesView(r: PbsRemoteSettings) {
  const host = await seriesHost(r);
  const rep = r.agentReport ?? null;
  const labels = new Map((await enabledGroups()).map((g) => [syncJobId(g.store, g.ns), jobLabel(g.store, g.ns)]));
  const run = rep?.running ?? null;
  return {
    startTime: startOf(r),
    tz: DEFAULT_TIMEZONE,
    jobs: labels.size,
    // the agent of the secondary starts the series (else: agent to update, no copy)
    active: !!r.agentAck && !!host,
    agentOnline: !!host && isOnline(host._id.toHexString()),
    error: r.agentError || rep?.error || null,
    day: rep?.day || null,
    total: rep?.total ?? 0,
    pending: rep?.pending.length ?? 0,
    // running: a job of the hub (its label), or another sync task of the secondary
    running: run ? (run.jobId ? (labels.get(run.jobId) ?? run.jobId) : 'autre synchronisation') : null,
    nextStart: rep?.nextStart || null,
  };
}

export function isSeriesReport(v: unknown): v is OffsiteSeriesReport {
  const o = v as OffsiteSeriesReport;
  return !!o && typeof o.hash === 'string' && typeof o.day === 'string' && Array.isArray(o.pending) && typeof o.nextStart === 'number';
}

// State of the series from the agent: kept for the settings; the copy it started is followed at once
// (watchTasks would see it within 30 s).
export async function onOffsiteReport(hostId: ObjectId, report: OffsiteSeriesReport, log?: FastifyBaseLogger) {
  const r = await loadRemoteSettings();
  if (r.agent?.hostId !== hostId.toHexString()) return;
  await settings.updateOne({ _id: 'pbs-remote' }, { $set: { agentReport: { ...report, receivedAt: new Date() } } });
  const t = report.running;
  if (remoteReady(r) && t?.jobId && !following.has(t.upid)) {
    followTask(r, t.jobId, t.upid, 'schedule', log).catch((err) => log?.warn({ err, upid: t.upid }, 'offsite copy not followed'));
  }
  publish('backups', {});
}

// --- poll of the secondary ----------------------------------------------------------------

interface SyncJobStatus {
  id: string;
  'last-run-upid'?: string;
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
    await syncOffsiteAgent().catch((err) => log?.warn({ err }, 'offsite series definition not sent'));
    const status = await call<SyncJobStatus[]>(r, 'GET', '/admin/sync');
    const groups = await enabledGroups();
    // a run the hub did not see (hub stopped meanwhile): recorded as a job too, with its log
    for (const s of status) {
      const upid = s['last-run-upid'];
      const mine = groups.filter((g) => g.offsite!.jobId === s.id);
      if (!upid || !mine.length || following.has(upid)) continue;
      if (mine.some((g) => g.offsite!.recordedUpid !== upid && g.offsite!.running?.upid !== upid && (upidStart(upid) ?? 0) >= (g.offsite!.since ?? 0))) {
        followTask(r, s.id, upid, 'schedule', log).catch(() => {});
      }
    }
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
      await backups.updateOne(
        { _id: g._id },
        {
          $set: {
            'offsite.lastBackup': copy?.lastBackup ?? null,
            'offsite.count': copy?.count ?? 0,
            'offsite.verify': copy?.verify ?? null,
            'offsite.size': copy?.size ?? null,
            'offsite.times': copy?.times ?? [],
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

// Fields of before #186 (queue of the agent, one job per group), removed once.
async function migrate() {
  await settings.updateOne({ _id: 'pbs-remote' }, { $unset: { queue: '', queueAck: '', queueError: '', queueReport: '' } });
  await backups.updateMany({ offsite: { $exists: true } }, { $unset: { 'offsite.queued': '', 'offsite.rateIn': '', 'offsite.schedule': '', 'offsite.nextRun': '' } });
}

export function startOffsitePoller(log: FastifyBaseLogger) {
  migrate().catch((err) => log.warn({ err }, 'offsite settings not migrated'));
  const run = () => pollOffsite(log).catch((err) => log.error({ err }, 'secondary PBS poll failed'));
  const watch = () => watchTasks(log).catch((err) => log.warn({ err }, 'secondary PBS tasks not read'));
  // after the first poll of the main PBS (30 s)
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, 15 * 60_000);
  // copies started on the secondary: seen within WATCH_MS, then followed
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

// The sync job a running task belongs to: its worker id (remote:store:target:ns:job) ends with the job.
export function taskJob(t: Pick<ApiTask, 'upid' | 'worker_id'>, jobIds: Iterable<string>) {
  const w = t.worker_id ?? t.upid;
  for (const id of jobIds) if (w === id || w.endsWith(`:${id}`)) return id;
  return null;
}

// Lines of the log of a sync task about a group (type/id), in a namespace: its snapshots
// ("vm/100/2026-10-18T00:30:00Z: sync archive…"), the re-sync of one, its failure ("sync group vm/100
// failed - …"). The lines may start with their time ("2026-10-18T04:00:01+02:00: ").
const GROUP_LINE = /(?:^|: )(?:re-sync snapshot |sync group )?((?:vm|ct|host)\/[^/\s:]+)/;
const GROUP_FAILED = /sync group ((?:vm|ct|host)\/[^/\s:]+) failed - (.*)$/;

export function lineGroup(line: string) {
  return GROUP_LINE.exec(line)?.[1] ?? null;
}

// Result of a run for each group of its job: the failure of the group when the log has one; else the end of
// the task (a task in error with no group named: all failed, e.g. namespace missing on the secondary).
export function groupResults(lines: string[], groups: string[], exit: string) {
  const failed = new Map<string, string>();
  for (const l of lines) {
    const m = GROUP_FAILED.exec(l);
    if (m) failed.set(m[1], m[2].trim());
  }
  const ok = taskOk(exit);
  return new Map(groups.map((k) => [k, failed.has(k) ? { ok: false, error: failed.get(k)! } : ok || failed.size ? { ok: true } : { ok: false, error: exit }]));
}

const following = new Set<string>();
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const groupKey = (g: Pick<BackupDoc, 'type' | 'backupId'>) => `${g.type}/${g.backupId}`;

// Follows a task of the secondary until it ends: a job of the hub on the host of the secondary (console,
// Activité) with the log of the task, offsite.running on the groups of its sync job meanwhile (current: the
// one being copied), then the result of each group and a poll. A job left running by a previous hub process
// is taken up again. Returns the id of the job of the hub.
export async function followTask(r: PbsRemoteSettings, syncJob: string, upid: string, trigger: JobDoc['trigger'], log?: FastifyBaseLogger) {
  const groups = (await enabledGroups()).filter((g) => g.offsite!.jobId === syncJob);
  const again = groups.find((g) => g.offsite!.running?.upid === upid)?.offsite!.running?.jobId;
  if (following.has(upid)) return again ?? null;
  following.add(upid);
  try {
    const hostId = r.agent?.hostId ? parseId(r.agent.hostId) : null;
    const host = hostId ? await hosts.findOne({ _id: hostId }, { projection: { _id: 1, name: 1 } }) : null;
    const start = upidStart(upid) ?? Date.now();
    const label = groups.length ? jobLabel(groups[0].store, groups[0].ns) : syncJob;
    const job = host ? await startHubJob(host, 'offsite_run', trigger, { backupJobName: label, createdAt: new Date(start) }, again) : null;
    const jobId = job?._id.toHexString() ?? '';
    await backups.updateMany({ _id: { $in: groups.map((g) => g._id) } }, { $set: { 'offsite.running': { upid, start, jobId, current: false } } });
    publish('backups', {});
    void track(r, syncJob, upid, start, { jobId, hostId: host?._id.toHexString() ?? '', lines: job?.log ? job.log.split('\n').length - 1 : 0 }, log);
    return jobId || null;
  } catch (err) {
    following.delete(upid);
    throw err;
  }
}

async function track(r: PbsRemoteSettings, syncJob: string, upid: string, start: number, job: { jobId: string; hostId: string; lines: number }, log?: FastifyBaseLogger) {
  // the whole log is read (the results of the groups need it), only the lines not in the job yet are added
  const lines: string[] = [];
  let current: string | null = null;
  const read = async () => {
    for (;;) {
      const page = await call<ApiTaskLine[]>(r, 'GET', `${taskPath(upid)}/log?start=${lines.length}&limit=${LOG_PAGE}`);
      const from = lines.length;
      lines.push(...page.map((l) => l.t));
      const fresh = lines.slice(Math.max(from, job.lines));
      if (job.jobId && fresh.length) appendJobLog(job.jobId, job.hostId, fresh.map((l) => `${l}\n`).join(''));
      if (page.length < LOG_PAGE) break;
    }
    const last = lines.reduce<string | null>((cur, l) => lineGroup(l) ?? cur, current);
    if (last !== current) {
      current = last;
      await backups.updateMany({ 'offsite.running.upid': upid }, { $set: { 'offsite.running.current': false } });
      const [type, backupId] = last!.split('/');
      await backups.updateMany({ 'offsite.running.upid': upid, type, backupId }, { $set: { 'offsite.running.current': true } });
      publish('backups', {});
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
  const end = Date.now();
  try {
    if (job.jobId) await finishJob(job.jobId, job.hostId, ok ? 0 : 1, ok ? undefined : exit);
    // the groups of the job when it started (a group enabled since was not in its filter)
    const groups = (await enabledGroups()).filter((g) => g.offsite!.jobId === syncJob && (g.offsite!.since ?? 0) <= start);
    const results = groupResults(lines, groups.map(groupKey), exit);
    for (const g of groups) {
      const res = results.get(groupKey(g))!;
      await backups.updateOne({ _id: g._id }, { $set: { 'offsite.running': null, 'offsite.recordedUpid': upid, 'offsite.lastRun': { start, end, ...res } } });
    }
    await backups.updateMany({ 'offsite.running.upid': upid }, { $set: { 'offsite.running': null } });
  } finally {
    following.delete(upid);
  }
  log?.info({ syncJob, upid, ok }, 'offsite copy ended');
  // the copy is on the secondary: read it now
  await pollOffsite(log).catch(() => {});
}

// Sync tasks running on the secondary (any: one of another job keeps the copies waiting too).
export async function runningSyncTasks(r: PbsRemoteSettings) {
  return (await call<ApiTask[]>(r, 'GET', '/nodes/localhost/tasks?running=1&typefilter=syncjob&limit=100')).filter((t) => !t.endtime);
}

// Copies running on the secondary that the hub does not follow yet: started by the agent, or left by a
// previous hub process.
async function watchTasks(log?: FastifyBaseLogger) {
  const r = await loadRemoteSettings();
  if (!remoteReady(r)) return;
  const groups = await enabledGroups();
  if (!groups.length) return;
  for (const g of groups) if (g.offsite?.running && !following.has(g.offsite.running.upid)) await followTask(r, g.offsite.jobId, g.offsite.running.upid, 'schedule', log);
  const jobIds = new Set(groups.map((g) => g.offsite!.jobId));
  for (const t of await runningSyncTasks(r)) {
    if (following.has(t.upid)) continue;
    const id = taskJob(t, jobIds);
    if (id) await followTask(r, id, t.upid, 'schedule', log);
  }
}

// --- state --------------------------------------------------------------------------------

// failed: the sync job could not be set, or the last run failed for this group; pending: the main PBS has
// a verified snapshot more recent than the copy (only verified ones are copied), or nothing is copied yet;
// late: that snapshot (or the enabling of the copy, if later) is older than LATE_HOURS, a daily series
// missed it; ok: the rest. null: not copied.
export type OffsiteState = 'ok' | 'pending' | 'late' | 'failed';

const HOUR = 3600_000;

// Last verified snapshot of the main PBS (unix ms), 0: none.
export function lastVerified(b: Pick<BackupDoc, 'times' | 'lastBackup' | 'verify'>) {
  const t = (b.times ?? []).filter((s) => s.verify === 'ok').reduce((m, s) => Math.max(m, s.t), 0);
  return t || (b.verify === 'ok' ? b.lastBackup : 0);
}

export function offsiteState(b: Pick<BackupDoc, 'offsite' | 'lastBackup' | 'times' | 'verify'>, now = Date.now()): OffsiteState | null {
  const o = b.offsite;
  if (!o?.enabled) return null;
  if (o.error || o.lastRun?.ok === false) return 'failed';
  const want = lastVerified(b);
  const copied = o.lastBackup ?? 0;
  if (want > copied) return now - Math.max(want, o.since ?? 0) > LATE_HOURS * HOUR ? 'late' : 'pending';
  return copied ? 'ok' : 'pending';
}

// --- actions ------------------------------------------------------------------------------

// Namespaces of the target datastore: the sync job cannot create them (no Datastore.Modify).
export async function targetNamespaces(r: PbsRemoteSettings) {
  const list = await call<{ ns: string }[]>(r, 'GET', `/admin/datastore/${encodeURIComponent(r.store)}/namespace`);
  return list.map((n) => n.ns);
}
