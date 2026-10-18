import type { BackupGroup, BackupOffsite, BackupOffsiteInput, BackupState, DatabaseDump, DatabaseKind, DumpInfo, OffsiteSeriesView } from './api';
import { timeAgo } from './format';

export const backupStateMeta: Record<BackupState, { label: string; tone: 'ok' | 'warn' | 'bad' | 'unknown' | 'neutral' }> = {
  ok: { label: 'à jour', tone: 'ok' },
  stale: { label: 'en retard', tone: 'warn' },
  failed: { label: 'vérification en échec', tone: 'bad' },
  gone: { label: 'disparue du PBS', tone: 'unknown' },
  task_failed: { label: 'dernière exécution en échec', tone: 'bad' },
  disabled: { label: 'job désactivé', tone: 'warn' },
  not_synced: { label: "pas encore appliquée par l'agent", tone: 'warn' },
};

export function formatBytes(n: number | null | undefined) {
  if (n === null || n === undefined) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${units[i]}`.replace('.', ',');
}

// "CT 171 · pve1" style label of a host's Proxmox VE guest
export function guestLabel(p: { type: 'lxc' | 'qemu'; vmid: number }) {
  return `${p.type === 'lxc' ? 'CT' : 'VM'} ${p.vmid}`;
}

// Jobs of a vzdump group, in words: "tous les jours à 06:00 (pbs-ds0)"
export function scheduleLabel(g: Pick<BackupGroup, 'pve' | 'managed' | 'ha'>) {
  if (g.managed) return `${g.managed.scheduleText}${g.managed.enabled ? '' : ' (désactivé)'}`;
  if (g.ha) return g.ha.scheduleText ?? 'pas de sauvegarde automatique vers cette destination';
  const jobs = g.pve?.jobs ?? [];
  return jobs.map((j) => `${j.scheduleText}${j.enabled ? '' : ' (désactivé)'}`).join(' · ');
}

// Label of a group: the name of the job of the hub that writes it, the destination of Home Assistant
// backups, else "host/pve-docker01" style
export function groupLabel(g: Pick<BackupGroup, 'type' | 'backupId' | 'comment'> & { managed?: BackupGroup['managed'] }) {
  if (g.managed) return g.managed.name;
  if (g.type === 'ha') return g.backupId;
  if (g.type === 'host') return g.backupId;
  // guest of Proxmox VE: its name first (comment of the group), then ct/<vmid>
  return g.comment ? `${g.comment} (${g.type}/${g.backupId})` : `${g.type}/${g.backupId}`;
}

// Summary of the groups of one host: worst state and most recent backup.
export function hostBackups(groups: BackupGroup[] | undefined, hostId: string) {
  const mine = (groups ?? []).filter((g) => g.hostId === hostId);
  if (!mine.length) return null;
  const order: BackupState[] = ['failed', 'task_failed', 'gone', 'stale', 'not_synced', 'disabled', 'ok'];
  const state = order.find((s) => mine.some((g) => g.state === s)) ?? 'ok';
  return { state, last: Math.max(...mine.map((g) => g.lastBackup)), count: mine.length, late: mine.filter((g) => g.state !== 'ok').length };
}

const HOUR = 3600_000;

// "quotidien", "toutes les 6 h", "hebdomadaire"...
export function rhythmLabel(ms: number | null) {
  if (!ms) return null;
  const h = ms / HOUR;
  const near = (v: number) => Math.abs(h - v) / v < 0.15;
  if (near(1)) return 'horaire';
  if (near(24)) return 'quotidien';
  if (near(24 * 7)) return 'hebdomadaire';
  if (near(24 * 30.5)) return 'mensuel';
  return h < 48 ? `toutes les ${Math.round(h)} h` : `tous les ${Math.round(h / 24)} j`;
}

export const thresholdSourceLabel = { manual: 'manuel', learned: 'appris', retention: 'rétention', schedule: 'planification', none: 'aucun rythme connu' } as const;

export function hoursLabel(h: number) {
  return h >= 48 ? `${Math.round((h / 24) * 10) / 10} j`.replace('.', ',') : `${Math.round(h * 10) / 10} h`.replace('.', ',');
}

// Last `days` days (oldest first): the snapshots of each day and their verification: failed if any snapshot
// failed, else the state of the day's latest snapshot (earlier ones are superseded). Without verification
// (Home Assistant backups), a day with a backup is ok.
export type DayVerify = 'ok' | 'unverified' | 'failed';

export function timeline(times: BackupGroup['times'], days = 30, now = Date.now(), verified = true) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const first = start.getTime() - (days - 1) * 24 * HOUR;
  const out = Array.from({ length: days }, (_, i) => ({ day: first + i * 24 * HOUR, count: 0, verify: 'ok' as DayVerify }));
  const latest = out.map(() => -Infinity);
  for (const s of times ?? []) {
    const i = Math.floor((s.t - first) / (24 * HOUR));
    if (i < 0 || i >= days) continue;
    const c = out[i];
    c.count++;
    if (s.verify === 'failed') c.verify = 'failed';
    else if (c.verify !== 'failed' && s.t > latest[i]) {
      latest[i] = s.t;
      c.verify = verified && s.verify === null ? 'unverified' : 'ok';
    }
  }
  return out;
}

// Copy of a group to the secondary PBS: why it cannot be (same rules as hub offsite.ts notCopiable), else null
export function offsiteNotCopiable(g: Pick<BackupGroup, 'source' | 'placeholder'>) {
  if (g.source === 'haos') return 'sauvegarde Home Assistant : elle n’est pas sur le PBS';
  if (g.placeholder) return 'sauvegarde jamais écrite sur le PBS';
  return null;
}

// Lane of the copy under the timeline, day by day: copied (a snapshot of that day is on the secondary),
// missing (a snapshot of the main PBS that the last run should have brought is not there; failed when that
// run failed), none. A snapshot is expected when older than the start of the last run and not older than
// the oldest copy (the secondary prunes on its own; before the first copy, only the last one is expected).
// A copied day carries the worst verification of its snapshots on the secondary (unverified, verify_failed).
// null: not copiable; off: copy not enabled.
export type OffsiteDay = 'copied' | 'unverified' | 'verify_failed' | 'missing' | 'failed' | 'running' | 'none';

export function offsiteLane(g: Pick<BackupGroup, 'times' | 'offsite' | 'source' | 'placeholder'>, days = 30, now = Date.now()) {
  if (offsiteNotCopiable(g)) return null;
  const o = g.offsite;
  const cells = timeline(o?.enabled ? o.times : [], days, now);
  if (!o?.enabled) return { off: true, cells: cells.map((c) => ({ day: c.day, state: 'none' as OffsiteDay })) };
  const until = o.lastRun?.start ?? -Infinity;
  const before = (g.times ?? []).map((s) => s.t).filter((t) => t <= until);
  const from = o.times?.length ? o.times[0].t : before.length ? Math.max(...before) : Infinity;
  const expected = timeline(before.filter((t) => t >= from).map((t) => ({ t, verify: null })), days, now, false);
  const miss: OffsiteDay = o.state === 'failed' ? 'failed' : 'missing';
  const last = cells.length - 1;
  const copied: Record<DayVerify, OffsiteDay> = { ok: 'copied', unverified: 'unverified', failed: 'verify_failed' };
  // this backup being copied: today's cell shows it
  return {
    off: false,
    cells: cells.map((c, i) => ({ day: c.day, state: (o.running?.current && i === last ? 'running' : c.count ? copied[c.verify] : expected[i].count ? miss : 'none') as OffsiteDay })),
  };
}

// Copy in the window of a backup: enabled or not (when: the daily series of the secondary, see seriesRule)
export interface OffsiteForm {
  enabled: boolean;
}

export const offsiteForm = (o: BackupOffsite | null | undefined): OffsiteForm => ({ enabled: !!o?.enabled });

// What to send for the copy when the window is saved; null: nothing changed.
export function offsiteInput(before: OffsiteForm, after: OffsiteForm): BackupOffsiteInput | null {
  return before.enabled === after.enabled ? null : { enabled: after.enabled };
}

// Rule of the series in words: "chaque jour à 04:00, une copie à la fois"
export const seriesRule = (s: Pick<OffsiteSeriesView, 'startTime'>) => `chaque jour à ${s.startTime}, un namespace après l’autre, une copie à la fois`;

// Where a copied group stands in the series, in words (null: nothing to say)
export function seriesText(o: Pick<BackupOffsite, 'running'>, s: Pick<OffsiteSeriesView, 'active' | 'nextStart'> | null | undefined) {
  if (o.running) return o.running.current ? 'copie en cours' : 'copie de son namespace en cours';
  if (!s?.active) return null;
  return s.nextStart ? `prochaine série ${timeAgo(s.nextStart)}` : null;
}

// PBS client of a host, from the capabilities of its agent (see hub backupJobs.ts clientState)
export function backupClient(caps: string[]) {
  const mode = caps.includes('backup:native') ? 'native' : caps.includes('backup:docker') ? 'docker' : null;
  const supported = caps.includes('backup_setup') || caps.includes('backup');
  return { mode, supported } as const;
}

// Kind of a backup: full image of the guest (vzdump of Proxmox VE), directories run by the agent (job
// of the hub), backup of Home Assistant (HAOS), or made by something else and attached by hand
// (backup_pbs_scripts...).
export type BackupKind = 'image' | 'directories' | 'database' | 'nextcloud' | 'ha' | 'external';

export const backupKinds: Record<BackupKind, { label: string; title: string }> = {
  image: { label: 'image PVE', title: 'Image complète du CT / de la VM, sauvegardée par un job vzdump de Proxmox VE' },
  directories: { label: 'répertoires', title: "Sauvegarde de répertoires définie ici et lancée par l'agent de l'hôte" },
  database: { label: 'base de données', title: "Dump de bases PostgreSQL ou MongoDB fait par l'agent de l'hôte, envoyé sur le PBS" },
  nextcloud: { label: 'Nextcloud AIO', title: 'Sauvegarde générée par le plugin Nextcloud AIO (base, configuration ou données d’un utilisateur) : modifiable depuis le plugin seulement' },
  ha: { label: 'Home Assistant', title: 'Sauvegarde faite par Home Assistant (une ligne par destination), lue par l’agent HAOS ; hors PBS' },
  external: { label: 'externe', title: 'Sauvegarde faite hors Homelab Manager (scripts…), rattachée à la main' },
};

export const databaseKindLabel: Record<DatabaseKind, string> = { postgres: 'PostgreSQL', mongodb: 'MongoDB' };

export function backupKindOf(g: Pick<BackupGroup, 'source' | 'managed'>): BackupKind {
  if (g.source === 'managed') {
    if (g.managed?.plugin?.name === 'nextcloud') return 'nextcloud';
    return g.managed?.kind === 'postgres' || g.managed?.kind === 'mongodb' ? 'database' : 'directories';
  }
  return g.source === 'vzdump' ? 'image' : g.source === 'haos' ? 'ha' : 'external';
}

export function backupKind(g: Pick<BackupGroup, 'source' | 'managed'>) {
  const k = backupKinds[backupKindOf(g)];
  const db = g.managed?.kind;
  return db === 'postgres' || db === 'mongodb' ? { ...k, label: `base ${databaseKindLabel[db]}` } : k;
}

// --- database jobs (dumps sent on the PBS, agent/database.go) -----------------------------------

// Archives of a database job: same names as dumpArchives (hub/src/backupJobs.ts, agent/database.go).
export function dumpArchives(kind: DatabaseKind, d: DatabaseDump) {
  const names = kind === 'postgres' ? (d.mode === 'cluster' ? ['pg-cluster'] : ['pg-globals', ...d.databases.map((x) => `pg-${x}`)]) : d.databases.map((x) => `mongo-${x}`);
  return names.map((name) => ({ name, path: `${d.workDir}/${name}` }));
}

export function databaseSummary(kind: DatabaseKind, d: DatabaseDump) {
  if (kind === 'postgres') return d.mode === 'cluster' ? 'cluster PostgreSQL complet (pg_basebackup)' : `pg_dump de ${d.databases.join(', ')}`;
  return `mongodump de ${d.databases.join(', ')} (conteneur ${d.container})`;
}

export function keepText(keep: number) {
  return keep === 0 ? "dump supprimé de l'hôte après l'envoi" : keep === 1 ? "dernier dump gardé sur l'hôte" : `${keep} derniers dumps gardés sur l'hôte`;
}

// "canicoif : base 120 Mo, dump 80 Mo" for each dump of the last run (globals left out)
export function dumpsText(list: DumpInfo[] | undefined) {
  if (!list?.length) return null;
  return list
    .filter((d) => d.archive !== 'pg-globals')
    .map((d) => `${d.database ?? 'cluster'} : base ${d.dbSize < 0 ? '?' : formatBytes(d.dbSize)}, dump ${d.dumpSize < 0 ? '?' : formatBytes(d.dumpSize)}`)
    .join(' · ');
}

// Line of a database job in the lists: what it dumps, where, what stays on the host, sizes of the last run.
export function databaseJobText(m: { kind?: string; database?: DatabaseDump | null; lastRun?: { dumps?: DumpInfo[] } | null }) {
  if (m.kind === 'nextcloud' && m.database) {
    const sizes = dumpsText(m.lastRun?.dumps?.filter((d) => d.archive !== 'nc-config'));
    const what = m.database.mode === 'config' ? 'config/, compose, appdata sans caches' : 'pg_dump de la base (conteneur)';
    return `Nextcloud : ${what} dans ${m.database.workDir} · ${keepText(m.database.keep)}${sizes ? ` · ${sizes}` : ''}`;
  }
  if ((m.kind !== 'postgres' && m.kind !== 'mongodb') || !m.database) return null;
  const sizes = dumpsText(m.lastRun?.dumps);
  return `${databaseSummary(m.kind, m.database)} dans ${m.database.workDir} · ${keepText(m.database.keep)}${sizes ? ` · ${sizes}` : ''}`;
}
