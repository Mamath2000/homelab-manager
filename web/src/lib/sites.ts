import type { AlertDomain, AlertLevel, BackupGroup, Host, HostAlertDay, SiteConfig, SiteKind } from './api';
import { hostBackups } from './backups';
import { connection, hasApt, type Tone } from './status';

// Dashboard by site: a site is the group of the hosts, tagged main / VPN / external in the settings.

export const NO_SITE = 'Sans site';

export const siteKindMeta: Record<SiteKind, { label: string; hint: string }> = {
  main: { label: 'Principal', hint: 'Site principal' },
  vpn: { label: 'VPN', hint: 'Site joint par un VPN' },
  external: { label: 'Externe', hint: 'Site externe supervisé' },
};

export interface Site {
  name: string;
  kind: SiteKind | null;
  hosts: Host[];
}

// Sites in the order of the settings, hosts without (known) site last. Sites without host are left out.
export function groupSites(hosts: Host[], config: SiteConfig[]): Site[] {
  const sorted = (list: Host[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));
  const sites = config.map((c) => ({ name: c.name, kind: c.kind, hosts: sorted(hosts.filter((h) => h.siteId === c.id)) }));
  const known = new Set(config.map((c) => c.id));
  const none = hosts.filter((h) => !h.siteId || !known.has(h.siteId));
  return [...sites, { name: NO_SITE, kind: null, hosts: sorted(none) }].filter((s) => s.hosts.length > 0);
}

// Name of the site of a host, for the lists.
export function siteName(h: Host, config: SiteConfig[] | undefined) {
  return config?.find((c) => c.id === h.siteId)?.name ?? NO_SITE;
}

// --- state of a host: system updates (upper half of its square) and backups (lower half) ----------

// na: no APT on the host (Unraid...); offline wins, the last report says nothing of now. Security comes
// first here, it is what the dashboard is read for.
export type AptTile = 'security' | 'reboot' | 'updates' | 'uptodate' | 'offline' | 'unknown' | 'na';

export function aptTile(h: Host): AptTile {
  if (connection(h) === 'offline') return 'offline';
  if (!hasApt(h)) return 'na';
  const s = h.aptSummary;
  if (!s) return 'unknown';
  if (s.security > 0) return 'security';
  if (s.rebootRequired) return 'reboot';
  if (s.upgradable > 0) return 'updates';
  return 'uptodate';
}

export const aptTileMeta: Record<AptTile, { label: string; tone: Tone; cls: string }> = {
  uptodate: { label: 'à jour', tone: 'ok', cls: 'bg-emerald-500' },
  updates: { label: 'mises à jour', tone: 'warn', cls: 'bg-amber-500' },
  security: { label: 'sécurité', tone: 'bad', cls: 'bg-red-500' },
  reboot: { label: 'redémarrage requis', tone: 'info', cls: 'bg-sky-500' },
  offline: { label: 'hors ligne', tone: 'neutral', cls: 'bg-zinc-600' },
  unknown: { label: 'inconnu', tone: 'unknown', cls: 'bg-violet-500/60' },
  na: { label: 'sans APT', tone: 'neutral', cls: 'border-[1.5px] border-dashed border-zinc-600' },
};

// warn: late, gone from the PBS, job disabled or not applied yet; bad: failed; none: not followed
export type BackupTile = 'ok' | 'warn' | 'bad' | 'none';

export function backupTile(groups: BackupGroup[] | undefined, hostId: string): BackupTile {
  const b = hostBackups(groups, hostId);
  if (!b) return 'none';
  if (b.state === 'failed' || b.state === 'task_failed') return 'bad';
  return b.state === 'ok' ? 'ok' : 'warn';
}

export const backupTileMeta: Record<BackupTile, { label: string; tone: Tone; cls: string }> = {
  ok: { label: 'à jour', tone: 'ok', cls: 'bg-emerald-500' },
  warn: { label: 'en retard', tone: 'warn', cls: 'bg-amber-500' },
  bad: { label: 'en échec', tone: 'bad', cls: 'bg-red-500' },
  none: { label: 'non suivie', tone: 'neutral', cls: 'border-[1.5px] border-dashed border-zinc-600' },
};

// none: no Docker on the host, or offline (the last report says nothing of now). Only managed stacks
// count: an unmanaged one has neither problems nor updates to follow.
export type DockerTile = 'problem' | 'updates' | 'ok' | 'none';

export function dockerTile(h: Host): DockerTile {
  if (!h.online || !h.docker) return 'none';
  const stacks = h.docker.stacks.filter((s) => s.managed);
  if (stacks.some((s) => s.problems.length > 0)) return 'problem';
  if (stacks.some((s) => s.updates > 0)) return 'updates';
  return 'ok';
}

export const dockerTileMeta: Record<DockerTile, { label: string; tone: Tone; cls: string }> = {
  problem: { label: 'en problème', tone: 'bad', cls: 'bg-red-500' },
  updates: { label: 'mise à jour disponible', tone: 'warn', cls: 'bg-amber-500' },
  ok: { label: 'à jour', tone: 'ok', cls: 'bg-emerald-500' },
  none: { label: 'non suivi', tone: 'neutral', cls: 'bg-zinc-600' },
};

// Worst state of a site, for its dot: offline, security, failed backup or Docker problem first.
export function siteTone(hosts: Host[], groups: BackupGroup[] | undefined): Tone {
  const apt = hosts.map(aptTile);
  const bak = hosts.map((h) => backupTile(groups, h.id));
  const dck = hosts.map(dockerTile);
  if (apt.includes('offline') || apt.includes('security') || bak.includes('bad') || dck.includes('problem')) return 'bad';
  if (apt.includes('updates') || apt.includes('reboot') || bak.includes('warn') || dck.includes('updates')) return 'warn';
  return 'ok';
}

export function count<T>(list: T[], v: T) {
  return list.filter((x) => x === v).length;
}

// Age of the oldest last backup among the hosts (ms), null: none followed.
export function oldestBackup(hosts: Host[], groups: BackupGroup[] | undefined, now = Date.now()) {
  const lasts = hosts.map((h) => hostBackups(groups, h.id)).filter((b) => b !== null).map((b) => b.last).filter((t) => t > 0);
  return lasts.length ? now - Math.min(...lasts) : null;
}

// --- timeline of the alerts, one row per site ------------------------------------------------------

export type TimelineFilter = 'all' | AlertDomain;
export type SiteCell = { level: AlertLevel | 'none'; alert: number; warn: number };

const rank = { none: -1, ok: 0, warn: 1, alert: 2 } as const;

// Worst level of each day of a site over its hosts, and how many hosts were in alert / warning.
export function siteDays(hosts: Host[], days: (HostAlertDay & { hostId: string })[], keys: string[], filter: TimelineFilter): SiteCell[] {
  const ids = new Set(hosts.map((h) => h.id));
  const domains: AlertDomain[] = filter === 'all' ? ['apt', 'docker', 'backups'] : [filter];
  const byDay = new Map<string, (HostAlertDay & { hostId: string })[]>();
  for (const d of days) if (ids.has(d.hostId)) byDay.set(d.day, [...(byDay.get(d.day) ?? []), d]);
  return keys.map((k) => {
    const cell: SiteCell = { level: 'none', alert: 0, warn: 0 };
    for (const d of byDay.get(k) ?? []) {
      let worst: SiteCell['level'] = 'none';
      for (const dom of domains) {
        const l = d[dom]?.level;
        if (l && rank[l] > rank[worst]) worst = l;
      }
      if (worst === 'alert') cell.alert++;
      if (worst === 'warn') cell.warn++;
      if (rank[worst] > rank[cell.level]) cell.level = worst;
    }
    return cell;
  });
}
