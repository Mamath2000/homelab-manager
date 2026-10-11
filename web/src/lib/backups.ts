import type { BackupGroup, BackupState } from './api';

export const backupStateMeta: Record<BackupState, { label: string; tone: 'ok' | 'warn' | 'bad' | 'unknown' | 'neutral' }> = {
  ok: { label: 'à jour', tone: 'ok' },
  stale: { label: 'en retard', tone: 'warn' },
  failed: { label: 'vérification en échec', tone: 'bad' },
  ignored: { label: 'ignorée', tone: 'neutral' },
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
  const mine = (groups ?? []).filter((g) => g.hostId === hostId && g.state !== 'ignored' && g.state !== 'gone');
  if (!mine.length) return null;
  const order: BackupState[] = ['failed', 'stale', 'ok'];
  const state = order.find((s) => mine.some((g) => g.state === s)) ?? 'ok';
  return { state, last: Math.max(...mine.map((g) => g.lastBackup)), count: mine.length, late: mine.filter((g) => g.state !== 'ok').length };
}
