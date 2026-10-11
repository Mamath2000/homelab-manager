import type { BackupGroup, BackupState } from './api';

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
export function scheduleLabel(g: Pick<BackupGroup, 'pve' | 'managed'>) {
  if (g.managed) return `${g.managed.scheduleText}${g.managed.enabled ? '' : ' (désactivé)'}`;
  const jobs = g.pve?.jobs ?? [];
  return jobs.map((j) => `${j.scheduleText}${j.enabled ? '' : ' (désactivé)'}`).join(' · ');
}

// Label of a group: the name of the job of the hub that writes it, else "host/pve-docker01" style
export function groupLabel(g: Pick<BackupGroup, 'type' | 'backupId' | 'comment'> & { managed?: BackupGroup['managed'] }) {
  if (g.managed) return g.managed.name;
  return g.type === 'host' ? g.backupId : `${g.type}/${g.backupId}${g.comment ? ` (${g.comment})` : ''}`;
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

// Last `days` days (oldest first): did a snapshot happen that day?
export function timeline(times: number[] | undefined, days = 30, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const first = start.getTime() - (days - 1) * 24 * HOUR;
  const out = Array.from({ length: days }, (_, i) => ({ day: first + i * 24 * HOUR, count: 0 }));
  for (const t of times ?? []) {
    const i = Math.floor((t - first) / (24 * HOUR));
    if (i >= 0 && i < days) out[i].count++;
  }
  return out;
}

// PBS client of a host, from the capabilities of its agent (see hub backupJobs.ts clientState)
export function backupClient(caps: string[]) {
  const mode = caps.includes('backup:native') ? 'native' : caps.includes('backup:docker') ? 'docker' : null;
  const supported = caps.includes('backup_setup') || caps.includes('backup');
  return { mode, supported } as const;
}

// Kind of a backup: full image of the guest (vzdump of Proxmox VE), directories run by the agent (job
// of the hub), or made by something else and attached by hand (backup_pbs_scripts...).
export type BackupKind = 'image' | 'directories' | 'external';

export const backupKinds: Record<BackupKind, { label: string; title: string }> = {
  image: { label: 'image PVE', title: 'Image complète du CT / de la VM, sauvegardée par un job vzdump de Proxmox VE' },
  directories: { label: 'répertoires', title: "Sauvegarde de répertoires définie ici et lancée par l'agent de l'hôte" },
  external: { label: 'externe', title: 'Sauvegarde faite hors Homelab Manager (scripts…), rattachée à la main' },
};

export function backupKindOf(g: Pick<BackupGroup, 'source'>): BackupKind {
  return g.source === 'vzdump' ? 'image' : g.source === 'managed' ? 'directories' : 'external';
}

export function backupKind(g: Pick<BackupGroup, 'source'>) {
  return backupKinds[backupKindOf(g)];
}
