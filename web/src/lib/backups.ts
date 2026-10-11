import type { BackupGroup, BackupState } from './api';

export const backupStateMeta: Record<BackupState, { label: string; tone: 'ok' | 'warn' | 'bad' | 'unknown' | 'neutral' }> = {
  ok: { label: 'à jour', tone: 'ok' },
  stale: { label: 'en retard', tone: 'warn' },
  failed: { label: 'vérification en échec', tone: 'bad' },
  gone: { label: 'disparue du PBS', tone: 'unknown' },
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

// "Hosts › host/pve-docker01" style label of a group
export function groupLabel(g: Pick<BackupGroup, 'type' | 'backupId' | 'comment'>) {
  return g.type === 'host' ? g.backupId : `${g.type}/${g.backupId}${g.comment ? ` (${g.comment})` : ''}`;
}

// Summary of the groups of one host: worst state and most recent backup.
export function hostBackups(groups: BackupGroup[] | undefined, hostId: string) {
  const mine = (groups ?? []).filter((g) => g.hostId === hostId);
  if (!mine.length) return null;
  const order: BackupState[] = ['failed', 'gone', 'stale', 'ok'];
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

export const thresholdSourceLabel = { manual: 'manuel', learned: 'appris', retention: 'rétention', default: 'défaut' } as const;

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
