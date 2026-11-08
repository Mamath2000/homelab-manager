import type { FastifyBaseLogger } from 'fastify';
import { agentRequest, isOnline } from './agents.js';
import { agentDatabase, CONTAINER_RE, DB_NAME_RE, MONGO_USER_RE } from './backupJobs.js';
import { backups, backupJobs, hosts, parseId } from './db.js';
import { createJob } from './jobs.js';
import { groupSnapshots, mount, mountableGroups, PbsMountError, unmount } from './pbsMount.js';
import { loadPbsSettings } from './pbs.js';
import type { BackupJobDoc, DatabaseDump, DbRestoreInfo, HostDoc, PbsMountSource } from './types.js';

// Restore of a database dump into a NEW database on another host (#210). The dump is read through the
// read-only mount of #209 (pbsMount.ts: one mount in all the hub, so one restore at a time). Nothing is ever
// overwritten: a target name that already exists is refused here (the check shown to the user) and again by
// the agent right before it restores. The restore itself is a job of the agent (db_restore, log in Activité);
// the mount is removed and the token revoked once the job is over (pbsMount.ts, restoreJobId).
// MongoDB first; PostgreSQL follows with the same flow.

export class DbRestoreError extends Error {}

export type DbKind = 'mongodb' | 'postgres';
export const SUPPORTED: DbKind[] = ['mongodb'];

export const DB_ARCHIVE_RE = /^(pg|mongo)-([A-Za-z0-9_][A-Za-z0-9_-]{0,47})\.pxar\.didx$/;

// A dump archive of a database job: pg-<base> or mongo-<base> (pg-globals is the role dump, not a database).
export function dbArchive(name: string) {
  const m = DB_ARCHIVE_RE.exec(name);
  if (!m || (m[1] === 'pg' && m[2] === 'globals')) return null;
  const kind: DbKind = m[1] === 'pg' ? 'postgres' : 'mongodb';
  return { kind, database: m[2], supported: SUPPORTED.includes(kind) };
}

// --- what can be restored ------------------------------------------------------------------

// Backups written by a database job (postgres or mongodb), among the ones that can be mounted.
export async function restorableGroups(source: PbsMountSource) {
  const list = await mountableGroups(source);
  const docs = await backups.find({ _id: { $in: list.map((g) => g.id) } }, { projection: { managed: 1 } }).toArray();
  const kinds = new Map(docs.map((d) => [d._id, d.managed?.kind]));
  return list
    .filter((g) => {
      const k = kinds.get(g.id);
      return k === 'mongodb' || k === 'postgres';
    })
    .map((g) => ({ ...g, kind: kinds.get(g.id) as DbKind, supported: SUPPORTED.includes(kinds.get(g.id) as DbKind) }));
}

// Snapshots of a group with only their database dumps (one archive per database).
export async function restorableSnapshots(source: PbsMountSource, groupId: string) {
  const snaps = await groupSnapshots(source, groupId);
  return snaps
    .map((s) => ({
      ...s,
      archives: s.archives.flatMap((a) => {
        const d = dbArchive(a.name);
        return d ? [{ ...a, kind: d.kind, database: d.database, supported: d.supported }] : [];
      }),
    }))
    .filter((s) => s.archives.length > 0);
}

// --- targets -------------------------------------------------------------------------------

export interface RestoreContainer {
  container: string;
  image: string | null;
  jobId: string | null; // backup job of the host whose credentials are reused (null: to be given)
  jobName: string | null;
  authenticated: boolean;
}

interface AgentCandidates {
  candidates?: { container: string; image: string }[];
}

const canRestore = (h: Pick<HostDoc, 'capabilities'>) => !!h.capabilities?.includes('pbs_mount') && !!h.capabilities?.includes('backup_database');

// Hosts that can receive a dump of this kind, each tested now, with the reason when they cannot.
export async function restoreTargets(kind: DbKind) {
  if (!SUPPORTED.includes(kind)) throw new DbRestoreError(`restauration ${kind} pas encore disponible`);
  const list = await hosts.find({ capabilities: 'pbs_mount' }).sort({ name: 1 }).toArray();
  const jobs = await backupJobs.find({ hostId: { $in: list.map((h) => h._id) }, kind: 'mongodb' }).toArray();
  return Promise.all(
    list.map(async (h) => {
      const id = h._id.toHexString();
      const base = { id, name: h.name, siteId: h.siteId ?? null };
      if (!canRestore(h)) return { ...base, online: isOnline(id), containers: [] as RestoreContainer[], reason: `l'agent de ${h.name} ne sait pas restaurer une base (agent à mettre à jour)` };
      if (!isOnline(id)) return { ...base, online: false, containers: [] as RestoreContainer[], reason: 'hôte hors ligne' };
      try {
        const r = await agentRequest<AgentCandidates>(id, 'db_restore_check', { backupKind: kind, database: {} }, 60_000);
        const mine = jobs.filter((j) => j.hostId.equals(h._id) && j.database?.container);
        const containers: RestoreContainer[] = (r.candidates ?? []).map((c) => {
          const j = mine.find((x) => x.database?.container === c.container);
          return { container: c.container, image: c.image, jobId: j ? j._id.toHexString() : null, jobName: j?.name ?? null, authenticated: !!j?.database?.username };
        });
        return { ...base, online: true, containers, reason: containers.length ? null : 'aucun conteneur MongoDB avec mongorestore' };
      } catch (err) {
        return { ...base, online: true, containers: [] as RestoreContainer[], reason: (err as Error).message };
      }
    }),
  );
}

// --- connection to the target server -------------------------------------------------------

export interface TargetInput {
  hostId: string;
  container: string;
  // reuse the credentials of a backup job of this host (preferred), or give them (kept in memory for the call only)
  jobId?: string;
  username?: string;
  password?: string;
  authSource?: string;
}

// The settings sent to the agent. Never logged, never stored.
async function connection(input: TargetInput): Promise<{ host: HostDoc; database: DatabaseDump }> {
  const hostId = parseId(input.hostId);
  const host = hostId ? await hosts.findOne({ _id: hostId }) : null;
  if (!host) throw new DbRestoreError('hôte cible introuvable');
  if (!canRestore(host)) throw new DbRestoreError(`l'agent de ${host.name} ne sait pas restaurer une base`);
  if (!CONTAINER_RE.test(input.container)) throw new DbRestoreError('conteneur invalide');
  if (input.jobId) {
    const jobId = parseId(input.jobId);
    const job: BackupJobDoc | null = jobId ? await backupJobs.findOne({ _id: jobId, hostId: host._id, kind: 'mongodb' }) : null;
    if (!job || job.database?.container !== input.container) throw new DbRestoreError('job de sauvegarde introuvable pour ce conteneur');
    const d = agentDatabase(job, 'mongodb')!;
    return { host, database: { databases: [], workDir: '', keep: 0, container: d.container, username: d.username, password: d.password, authSource: d.authSource } };
  }
  const { username = '', password = '', authSource = '' } = input;
  if (!!username !== !!password) throw new DbRestoreError('utilisateur et mot de passe requis ensemble');
  if (username && !MONGO_USER_RE.test(username)) throw new DbRestoreError('utilisateur invalide');
  if (password && (password.length > 1024 || /[\r\n\0]/.test(password))) throw new DbRestoreError('mot de passe invalide');
  if (authSource && !DB_NAME_RE.test(authSource)) throw new DbRestoreError('authSource invalide');
  return {
    host,
    database: { databases: [], workDir: '', keep: 0, container: input.container, ...(username ? { username, password, authSource: authSource || undefined } : {}) },
  };
}

export interface RestoreCheck {
  ok: boolean;
  tools: string;
  databases: { name: string; size: number }[];
  exists: boolean;
  free: number;
  error: string | null;
}

// Access to the server, name clash, free space: what the dialog shows before the restore.
export async function checkRestore(input: TargetInput & { target: string; size?: number }): Promise<RestoreCheck> {
  if (!DB_NAME_RE.test(input.target)) throw new DbRestoreError('nom de base invalide');
  const { host, database } = await connection(input);
  if (!isOnline(host._id.toHexString())) throw new DbRestoreError(`${host.name} est hors ligne`);
  try {
    const r = await agentRequest<{ tools: string; databases: { name: string; size: number }[]; exists: boolean; free: number }>(
      host._id.toHexString(),
      'db_restore_check',
      { backupKind: 'mongodb', database, restoreTarget: input.target },
      75_000,
    );
    const short = input.size && r.free >= 0 && r.free < input.size ? 'place libre insuffisante' : null;
    const error = r.exists ? `la base ${input.target} existe déjà sur ${input.container} : rien n'est écrasé` : short;
    return { ok: !error, tools: r.tools, databases: r.databases, exists: r.exists, free: r.free, error };
  } catch (err) {
    return { ok: false, tools: '', databases: [], exists: false, free: -1, error: (err as Error).message };
  }
}

// --- restore -------------------------------------------------------------------------------

export interface RestoreInput extends TargetInput {
  source: PbsMountSource;
  groupId: string;
  time: number;
  archive: string;
  target: string;
}

export async function startRestore(input: RestoreInput, log?: FastifyBaseLogger) {
  const arch = dbArchive(input.archive);
  if (!arch || !arch.supported) throw new DbRestoreError('archive de base non restaurable (pg-<base> ou mongo-<base>, MongoDB pour l’instant)');
  // the group must be a database backup of this kind
  const group = (await restorableGroups(input.source)).find((g) => g.id === input.groupId);
  if (!group || group.kind !== arch.kind) throw new DbRestoreError('sauvegarde de base introuvable');
  // checked again now, whatever the dialog showed
  const check = await checkRestore(input);
  if (!check.ok) throw new DbRestoreError(check.error ?? 'vérification de la cible en échec');
  const { host, database } = await connection(input);
  const hostId = host._id.toHexString();

  try {
    await mount({ source: input.source, groupId: input.groupId, time: input.time, archive: input.archive, hostId }, log);
  } catch (err) {
    throw err instanceof PbsMountError ? new DbRestoreError(err.message) : err;
  }
  const info: DbRestoreInfo = { kind: 'mongodb', source: arch.database, target: input.target, container: input.container };
  try {
    const mountRoot = (await loadPbsSettings()).mountRoot ?? '/srv/pbs-restore';
    const job = await createJob(host, 'db_restore', [], 'manual', {
      dbRestoreInfo: info,
      dbRestore: { kind: 'mongodb', database, source: arch.database, target: input.target, mountRoot },
    });
    await hosts.updateOne({ _id: host._id }, { $set: { 'pbsMount.restoreJobId': job._id } });
    log?.info({ host: host.name, source: arch.database, target: input.target }, 'database restore started');
    // the job could not even start (agent gone): nothing will read the mount
    if (job.status !== 'running') await unmount(log).catch(() => null);
    return { jobId: job._id.toHexString(), status: job.status };
  } catch (err) {
    await unmount(log).catch(() => null);
    throw err;
  }
}
