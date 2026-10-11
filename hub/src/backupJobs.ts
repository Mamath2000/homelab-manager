import { ObjectId } from 'mongodb';
import { isOnline, sendToAgent } from './agents.js';
import { parseCalendar, validTimeZone } from './calendar.js';
import { sha256 } from './crypto.js';
import { backupJobs, backups, hosts, jobs } from './db.js';
import { publish } from './events.js';
import { jobDto } from './jobs.js';
import { groupKey, loadPbsSettings, pollPbs } from './pbs.js';
import type { BackupArchive, BackupJobDoc, HostDoc, JobDoc, PbsSettings } from './types.js';

// Backups of directories defined here and run by the agent of each host with proxmox-backup-client:
// the hub sends the whole definition of a host (backup_sync) whenever it changes and at each
// connection; the agent schedules the runs by itself and reports each result (backup_result), which
// the hub acknowledges. The hub creates the job, so it knows the group it writes on the PBS: that
// group is attached to the host by construction.

export const DEFAULT_CLIENT_IMAGE = 'mathmath350/pbs-client:latest';
export const DEFAULT_TIMEZONE = 'Europe/Paris';
// namespace of the backups of the hosts: the only one their token may write (see tokenSetup.ts)
export const HOSTS_NS = 'Hosts';

export const ARCHIVE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const BACKUP_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
export const STORE_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
export const NS_RE = /^([A-Za-z0-9_][A-Za-z0-9._-]{0,31})(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,31}){0,7}$/;
export const TOKEN_ID_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/;
export const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$/;

export interface JobInput {
  name: string;
  archives: BackupArchive[];
  excludes: string[];
  store: string;
  ns?: string; // ignored: always HOSTS_NS
  backupId?: string; // creation only
  schedule: string;
  timezone?: string;
  enabled: boolean;
}

// Absolute, normalised path, without ':' (separator of the archive spec and of docker volumes).
export function validPath(p: string) {
  if (!p.startsWith('/') || /[:\n\0]/.test(p)) return false;
  const parts = p.split('/').slice(1);
  if (p !== '/' && parts.some((x) => x === '' || x === '.' || x === '..')) return false;
  return true;
}

// Error message, or null. Same rules as validateBackupSpec in agent/backup.go.
export function checkJob(j: JobInput, creating: boolean): string | null {
  if (!j.name.trim()) return 'nom requis';
  if (!j.archives.length) return 'au moins un répertoire';
  const names = new Set<string>();
  for (const a of j.archives) {
    if (!ARCHIVE_NAME_RE.test(a.name)) return `nom d'archive invalide : ${a.name} (lettres, chiffres, - et _)`;
    if (names.has(a.name)) return `nom d'archive en double : ${a.name}`;
    names.add(a.name);
    if (!validPath(a.path)) return `chemin invalide : ${a.path} (absolu, sans « : », « .. » ni / final)`;
  }
  for (const e of j.excludes) if (!e || e.length > 256 || /[\n\0]/.test(e)) return 'exclusion invalide';
  if (!STORE_RE.test(j.store)) return 'datastore invalide';
  if (j.ns !== undefined && j.ns !== HOSTS_NS) return `namespace fixé : ${HOSTS_NS}`;
  if (creating && !BACKUP_ID_RE.test(j.backupId ?? '')) return 'identifiant de sauvegarde invalide (lettres, chiffres, . - _)';
  if (!parseCalendar(j.schedule)) return 'planification non reconnue (ex. 03:00, sun 01:00, mon..fri 22:30, daily)';
  if (j.timezone && !validTimeZone(j.timezone)) return 'fuseau horaire inconnu';
  return null;
}

// host:port of the PBS for the repository of the client
export function pbsServer(pbs: Pick<PbsSettings, 'url'>) {
  const u = new URL(pbs.url);
  return `${u.hostname}:${u.port || '8007'}`;
}

// Definition sent to the agent: empty (no job) when there is nothing to run, so that it stops.
export function buildSpec(host: Pick<HostDoc, 'pbsCredential'>, list: BackupJobDoc[], pbs: PbsSettings) {
  const usable = !!host.pbsCredential && !!pbs.url;
  const body = {
    server: usable ? pbsServer(pbs) : '',
    fingerprint: pbs.fingerprint,
    tokenId: usable ? host.pbsCredential!.tokenId : '',
    tokenSecret: usable ? host.pbsCredential!.tokenSecret : '',
    image: pbs.clientImage || DEFAULT_CLIENT_IMAGE,
    jobs: usable
      ? list.map((j) => ({
          id: j._id.toHexString(),
          name: j.name,
          archives: j.archives,
          excludes: j.excludes,
          store: j.store,
          ns: j.ns,
          backupId: j.backupId,
          schedule: j.schedule,
          tz: j.timezone,
          enabled: j.enabled,
        }))
      : [],
  };
  // the hash covers the secret too: a new token is a new definition
  return { hash: sha256(JSON.stringify(body)), ...body };
}

// Sends its definition to the agent of a host, when connected and able to back up.
export async function syncHost(hostId: ObjectId) {
  const host = await hosts.findOne({ _id: hostId });
  // backup_setup: an agent that takes definitions (it may not have the client yet: the image to use)
  const caps = host?.capabilities ?? [];
  if (!host || !(caps.includes('backup_setup') || caps.includes('backup')) || !isOnline(hostId.toHexString())) return false;
  const spec = buildSpec(host, await backupJobs.find({ hostId }).toArray(), await loadPbsSettings());
  return sendToAgent(hostId.toHexString(), { type: 'backup_sync', backup: spec });
}

export async function syncAll() {
  for (const h of await hosts.find({ capabilities: { $in: ['backup', 'backup_setup'] } }, { projection: { _id: 1 } }).toArray()) await syncHost(h._id);
}

// State of the PBS client of a host, from the capabilities of its agent.
export function clientState(caps: string[] = []) {
  return {
    mode: caps.includes('backup:native') ? ('native' as const) : caps.includes('backup:docker') ? ('docker' as const) : null,
    install: (['apt', 'docker'] as const).filter((m) => caps.includes(`backup_install:${m}`)),
    // agent that knows about backups at all (older ones: to update)
    supported: caps.includes('backup_setup') || caps.includes('backup'),
  };
}

// Hash of the definition the hub would send now, to tell whether the agent applied it.
export async function currentHash(host: HostDoc) {
  return buildSpec(host, await backupJobs.find({ hostId: host._id }).toArray(), await loadPbsSettings()).hash;
}

export async function onSynced(hostId: ObjectId, hash: string | undefined, error: string | undefined) {
  await hosts.updateOne({ _id: hostId }, { $set: { backupSync: { hash: error ? '' : (hash ?? ''), at: new Date(), error: error || null } } });
  await refreshManaged();
  publish('backups', {});
}

interface AgentResult {
  id: string;
  jobId: string;
  runId?: string;
  trigger: string;
  start: number;
  end: number;
  ok: boolean;
  error?: string;
  log: string;
}

// Error of a failed run: the last "Error: …" line of the client, more telling than its exit code.
export function runError(r: Pick<AgentResult, 'ok' | 'error' | 'log'>) {
  if (r.ok) return null;
  const lines = r.log.split('\n').map((l) => l.trim()).filter((l) => /^Error: /.test(l));
  return lines.length ? lines[lines.length - 1].slice(7) : (r.error ?? 'échec');
}

export function isResult(r: unknown): r is AgentResult {
  const x = r as AgentResult;
  return (
    !!x &&
    typeof x.id === 'string' &&
    /^[0-9a-f]{32}$/.test(x.id) &&
    typeof x.jobId === 'string' &&
    typeof x.start === 'number' &&
    typeof x.end === 'number' &&
    typeof x.ok === 'boolean' &&
    typeof x.log === 'string'
  );
}

// Result of a run reported by the agent: recorded as a job (Activité) and as the last run of the
// backup job, then acknowledged so that the agent forgets it. A result received twice (lost ack)
// is recorded once.
export async function onResult(host: HostDoc, r: AgentResult) {
  const ack = () => sendToAgent(host._id.toHexString(), { type: 'backup_result_ack', reqId: r.id });
  if (!ObjectId.isValid(r.jobId)) return ack();
  const bj = await backupJobs.findOne({ _id: new ObjectId(r.jobId), hostId: host._id });
  if (!bj) return ack(); // job deleted meanwhile
  const status = r.ok ? 'success' : 'failed';
  const error = runError(r);
  const log = r.log.slice(-64 * 1024);
  let jobId: ObjectId | null = null;
  if (r.runId && ObjectId.isValid(r.runId)) {
    // run on demand: its job exists, possibly closed by a disconnection meanwhile
    jobId = new ObjectId(r.runId);
    const updated = await jobs.findOneAndUpdate(
      { _id: jobId, hostId: host._id, action: 'backup_run' },
      { $set: { status, exitCode: r.ok ? 0 : 1, error: error || undefined, finishedAt: new Date(r.end) } },
      { returnDocument: 'after' },
    );
    if (updated) publish('job', jobDto(updated));
  } else if (!(await jobs.findOne({ resultId: r.id } as never))) {
    const doc: JobDoc & { resultId: string } = {
      _id: new ObjectId(),
      hostId: host._id,
      hostName: host.name,
      action: 'backup_run',
      packages: [],
      backupJobId: bj._id,
      backupJobName: bj.name,
      trigger: 'schedule',
      status,
      createdAt: new Date(r.start),
      finishedAt: new Date(r.end),
      exitCode: r.ok ? 0 : 1,
      ...(error ? { error } : {}),
      log,
      resultId: r.id,
    };
    await jobs.insertOne(doc);
    jobId = doc._id;
    publish('job', jobDto(doc));
  }
  if (!bj.lastRun || r.start >= bj.lastRun.start) {
    await backupJobs.updateOne({ _id: bj._id }, { $set: { lastRun: { start: r.start, end: r.end, ok: r.ok, error, trigger: r.trigger, jobId } } });
  }
  ack();
  await refreshManaged();
  publish('backups', {});
  // the new snapshot is on the PBS: read it now rather than at the next poll
  if (r.ok) pollPbs().catch(() => {});
}

// Groups written by the backup jobs: attached to their host (placeholder until the first snapshot),
// with what the state needs (schedule, last run, definition applied by the agent).
export async function refreshManaged() {
  const list = await backupJobs.find().toArray();
  const hostDocs = new Map((await hosts.find({ _id: { $in: [...new Set(list.map((j) => j.hostId.toHexString()))].map((id) => new ObjectId(id)) } }).toArray()).map((h) => [h._id.toHexString(), h]));
  const pbs = await loadPbsSettings();
  const keys = new Set<string>();
  const hashes = new Map<string, string>();
  for (const j of list) {
    const host = hostDocs.get(j.hostId.toHexString());
    if (!host) continue;
    const hid = host._id.toHexString();
    if (!hashes.has(hid)) hashes.set(hid, buildSpec(host, list.filter((x) => x.hostId.equals(host._id)), pbs).hash);
    const key = groupKey(j.store, j.ns, 'host', j.backupId);
    keys.add(key);
    const managed = {
      jobId: j._id.toHexString(),
      name: j.name,
      tz: j.timezone,
      schedule: j.schedule,
      enabled: j.enabled,
      lastRun: j.lastRun ? { at: j.lastRun.end, ok: j.lastRun.ok, error: j.lastRun.error ?? null } : null,
      synced: !!host.backupSync && host.backupSync.hash === hashes.get(hid),
      since: j.createdAt.getTime(),
    };
    await backups.updateOne(
      { _id: key },
      {
        $set: { hostId: host._id, source: 'managed', managed },
        $unset: { pve: '' },
        $setOnInsert: { store: j.store, ns: j.ns, type: 'host', backupId: j.backupId, count: 0, lastBackup: 0, size: null, verify: null, times: [], seenAt: new Date(0), placeholder: true },
      },
      { upsert: true },
    );
  }
  await backups.deleteMany({ source: 'managed', placeholder: true, _id: { $nin: [...keys] } });
  await backups.updateMany({ source: 'managed', _id: { $nin: [...keys] } }, { $set: { hostId: null }, $unset: { source: '', managed: '' } });
}

// Group a new job would write: refused when it belongs to another host or is attached by hand
// elsewhere (two writers on one group would mix their snapshots).
export async function groupConflict(hostId: ObjectId, store: string, ns: string, backupId: string, exceptJob?: ObjectId) {
  const key = groupKey(store, ns, 'host', backupId);
  const other = await backupJobs.findOne({ store, ns, backupId, ...(exceptJob ? { _id: { $ne: exceptJob } } : {}) });
  if (other) return 'un autre job écrit déjà ce groupe';
  const g = await backups.findOne({ _id: key });
  if (g?.hostId && !g.hostId.equals(hostId)) return 'ce groupe du PBS est rattaché à un autre hôte';
  return null;
}

export function jobView(j: BackupJobDoc) {
  return {
    id: j._id.toHexString(),
    hostId: j.hostId.toHexString(),
    name: j.name,
    archives: j.archives,
    excludes: j.excludes,
    store: j.store,
    ns: j.ns,
    backupId: j.backupId,
    group: groupKey(j.store, j.ns, 'host', j.backupId),
    schedule: j.schedule,
    timezone: j.timezone,
    enabled: j.enabled,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    lastRun: j.lastRun ? { ...j.lastRun, jobId: j.lastRun.jobId ? j.lastRun.jobId.toHexString() : null } : null,
  };
}
