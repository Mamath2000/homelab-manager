import { ObjectId } from 'mongodb';
import { BACKUP_ID_RE, HOSTS_NS, STORE_RE, checkDatabase, jobKind } from './backupJobs.js';
import { parseCalendar } from './calendar.js';
import type { BackupArchive, BackupJobDoc, BackupJobKind, DatabaseDump, JobPlugin, NextcloudPlugin } from './types.js';

// Nextcloud AIO plugin of the backups (homelab#148). Its settings (on the host) say what is backed up and
// where; the hub generates the jobs from them, and only the plugin changes or removes those jobs:
//   - database: kind nextcloud, mode database (pg_dump in the database container, agent/nextcloud.go);
//   - config: kind nextcloud, mode config (config/, compose files, data root files, appdata without caches);
//   - user:<id>: a directories job of the directory of the user.
// A directories job that already backs up the directory of a user (made by hand before the plugin) is
// taken over: same group on the PBS, its history goes on.

// What the agent found of the instance (NextcloudAIO in agent/nextcloud.go).
export interface NextcloudDiscovery {
  containers: Record<string, string>;
  version: string;
  database: string;
  dbSize: number;
  dbTools?: string;
  dataDir: string;
  configDir: string;
  instanceId: string;
  composeFiles: string[];
  users: { id: string; name: string; path?: string; exists: boolean; error?: string }[];
  free: number;
}

export type PluginInput = Omit<NextcloudPlugin, 'dataDir' | 'updatedAt'>;

export const isPluginJob = (j: Pick<BackupJobDoc, 'plugin'>) => j.plugin?.name === 'nextcloud';

export const userPart = (id: string) => `user:${id}`;

// Group of a user on the PBS: nextcloud-user-<id>, like the jobs made by hand before the plugin.
export function userBackupId(id: string) {
  return `nextcloud-user-${id.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`.slice(0, 64);
}

const PART_LABEL: Record<string, string> = { database: 'base', config: 'configuration' };

export interface WantedJob {
  part: string;
  name: string;
  backupId: string;
  store: string;
  kind: BackupJobKind;
  archives: BackupArchive[];
  database: DatabaseDump | null;
}

// Error message, or null.
export function checkPlugin(p: PluginInput, d: NextcloudDiscovery, datastores: string[]): string | null {
  const wd = checkDatabase('nextcloud', { mode: 'database', databases: [], workDir: p.workDir, keep: p.keep });
  if (wd) return wd;
  if (!parseCalendar(p.schedule)) return 'planification non reconnue (ex. 03:00, sun 01:00, mon..fri 22:30, daily)';
  const stores = [p.database, p.config, ...p.users.map((u) => u.store)].filter((s): s is string => s !== null);
  if (!stores.length) return 'rien à sauvegarder : choisir un datastore pour au moins une ligne';
  for (const s of stores) {
    if (!STORE_RE.test(s) || (datastores.length && !datastores.includes(s))) return `datastore inconnu : ${s}`;
  }
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (const u of p.users) {
    const found = d.users.find((x) => x.id === u.id);
    if (!found) return `utilisateur inconnu de Nextcloud : ${u.id}`;
    if (found.error || !found.path) return `${u.id} : ${found.error ?? 'pas de répertoire'}`;
    if (!found.exists) return `${u.id} : pas encore de répertoire (jamais connecté ?)`;
    if (ids.has(u.id)) return `utilisateur en double : ${u.id}`;
    ids.add(u.id);
    const id = userBackupId(u.id);
    if (!BACKUP_ID_RE.test(id) || seen.has(id)) return `${u.id} : identifiant de sauvegarde en double ou invalide (${id})`;
    seen.add(id);
  }
  return null;
}

// The jobs the settings ask for.
export function wantedJobs(p: PluginInput, d: Pick<NextcloudDiscovery, 'users'>): WantedJob[] {
  const out: WantedJob[] = [];
  for (const part of ['database', 'config'] as const) {
    const store = p[part];
    if (!store) continue;
    out.push({
      part,
      name: `Nextcloud · ${PART_LABEL[part]}`,
      backupId: part === 'database' ? 'nextcloud-db' : 'nextcloud-config',
      store,
      kind: 'nextcloud',
      archives: [],
      // one work directory each: the history of their dumps is kept apart
      database: { mode: part, databases: [], workDir: `${p.workDir}/${part}`, keep: p.keep },
    });
  }
  for (const u of p.users) {
    const path = d.users.find((x) => x.id === u.id)?.path;
    if (!path) continue;
    out.push({
      part: userPart(u.id),
      name: `Nextcloud · ${u.id}`,
      backupId: userBackupId(u.id),
      store: u.store,
      kind: 'directories',
      archives: [{ name: 'data', path }],
      database: null,
    });
  }
  return out;
}

// Job of a part: the one the plugin generated, else (user) a directories job of the directory alone.
export function jobOfPart(part: string, path: string | undefined, list: BackupJobDoc[]) {
  const own = list.find((j) => isPluginJob(j) && j.plugin!.part === part);
  if (own) return { job: own, adopted: false };
  if (!path) return null;
  const hand = list.find((j) => !isPluginJob(j) && jobKind(j) === 'directories' && j.archives.length === 1 && j.archives[0].path === path);
  return hand ? { job: hand, adopted: true } : null;
}

export interface Plan {
  create: BackupJobDoc[];
  update: { job: BackupJobDoc; set: Partial<BackupJobDoc> }[];
  remove: BackupJobDoc[];
}

// Writes that turn the jobs of a host into what the settings ask for.
export function planJobs(hostId: ObjectId, p: PluginInput, d: Pick<NextcloudDiscovery, 'users'>, list: BackupJobDoc[], timezone: string, now = new Date()): Plan {
  const plan: Plan = { create: [], update: [], remove: [] };
  const kept = new Set<string>();
  for (const w of wantedJobs(p, d)) {
    const plugin: JobPlugin = { name: 'nextcloud', part: w.part };
    const fields = { name: w.name, archives: w.archives, excludes: [], store: w.store, schedule: p.schedule, enabled: p.enabled, kind: w.kind, database: w.database, plugin };
    const cur = jobOfPart(w.part, w.archives[0]?.path, list);
    if (cur) {
      kept.add(cur.job._id.toHexString());
      plan.update.push({ job: cur.job, set: { ...fields, updatedAt: now } });
    } else {
      plan.create.push({ _id: new ObjectId(), hostId, ...fields, ns: HOSTS_NS, backupId: w.backupId, timezone, createdAt: now, updatedAt: now, lastRun: null });
    }
  }
  for (const j of list) if (isPluginJob(j) && !kept.has(j._id.toHexString())) plan.remove.push(j);
  return plan;
}
