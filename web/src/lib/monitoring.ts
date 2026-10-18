import { Activity, BatteryCharging, CloudUpload, Container, DatabaseBackup, Package, Radio, type LucideIcon } from 'lucide-react';
import type { AlertLevel, DomainMeta, DomainStatus, Host, HostAlertDay, StatusView } from './api';
import type { Tone } from './status';

// Reading of the live status given by the hub (monitoring.ts). The list of the domains comes from the
// hub: this file knows how to show a level, not what is followed. Only the icons are mapped here.

const icons: Record<string, LucideIcon> = {
  radio: Radio,
  package: Package,
  container: Container,
  'database-backup': DatabaseBackup,
  'cloud-upload': CloudUpload,
  'battery-charging': BatteryCharging,
};
export const domainIcon = (d: Pick<DomainMeta, 'icon'>): LucideIcon => icons[d.icon] ?? Activity;

// ok / warn / alert: read; unknown: applies but cannot be read now (grey); none: does not apply (nothing drawn).
export type Cell = AlertLevel | 'unknown' | 'none';

export const cellCls: Record<Cell, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  alert: 'bg-red-500',
  unknown: 'bg-zinc-600',
  none: 'bg-transparent',
};
export const cellLabel: Record<Cell, string> = { ok: 'OK', warn: 'avertissement', alert: 'alerte', unknown: 'inconnu', none: 'non applicable' };
export const levelTone: Record<AlertLevel, Tone> = { ok: 'ok', warn: 'warn', alert: 'bad' };

const rank: Record<AlertLevel, number> = { ok: 0, warn: 1, alert: 2 };
export const worse = (a: AlertLevel, b: AlertLevel) => (rank[b] > rank[a] ? b : a);

export const cellOf = (d: DomainStatus | undefined): Cell => d?.level ?? 'none';

// Why a domain is in this state: the elements that are not ok, else the reason it is unknown.
export function domainText(d: DomainStatus | undefined) {
  if (!d) return cellLabel.none;
  const why = d.level === 'unknown' ? d.reason : d.checks.filter((c) => c.level !== 'ok' && c.reason).map((c) => c.reason).join(' · ');
  return why || cellLabel[d.level];
}

// Domains met in at least one host of the list, in the order of the hub.
export function hostsDomains(status: StatusView | undefined, hosts: Pick<Host, 'id'>[]): DomainMeta[] {
  if (!status) return [];
  return status.domains.filter((d) => hosts.some((h) => status.hosts[h.id]?.domains[d.id]));
}

// Worst level of the hosts (a host is the worst of its read domains).
export function worstLevel(status: StatusView | undefined, hosts: Pick<Host, 'id'>[]): AlertLevel {
  return hosts.reduce<AlertLevel>((w, h) => worse(w, status?.hosts[h.id]?.level ?? 'ok'), 'ok');
}

// Cells of one domain across hosts, to count them.
export function domainCells(status: StatusView | undefined, hosts: Pick<Host, 'id'>[], domain: string): Cell[] {
  return hosts.map((h) => cellOf(status?.hosts[h.id]?.domains[domain]));
}

// --- timeline of a site: worst level of the day over its hosts --------------------------------------

export type SiteCell = { level: AlertLevel | 'none'; alert: number; warn: number };

const cellRank = { none: -1, ok: 0, warn: 1, alert: 2 } as const;

// Level of a host today, from the live status: all its domains, or only the filtered one.
function liveLevel(status: StatusView['hosts'][string], filter: string): AlertLevel | 'none' {
  if (!status) return 'none';
  if (filter === 'all') return Object.values(status.domains).some((d) => d && d.level !== 'unknown') ? status.level : 'none';
  const d = status.domains[filter];
  return !d || d.level === 'unknown' ? 'none' : d.level;
}

// Past days come from the history of the hub; today, from the live status, so that the timeline
// always agrees with the squares and the colour of the site.
export function siteDays(hosts: Pick<Host, 'id'>[], days: (HostAlertDay & { hostId: string })[], keys: string[], filter: string, status: StatusView | undefined): SiteCell[] {
  const ids = new Set(hosts.map((h) => h.id));
  const byDay = new Map<string, (AlertLevel | 'none')[]>();
  const today = keys[keys.length - 1];
  for (const d of days) {
    if (!ids.has(d.hostId) || (status?.hosts[d.hostId] && d.day === today)) continue;
    let worst: AlertLevel | 'none' = 'none';
    for (const [dom, a] of Object.entries(d.domains)) {
      if (!a || (filter !== 'all' && dom !== filter)) continue;
      if (cellRank[a.level] > cellRank[worst]) worst = a.level;
    }
    byDay.set(d.day, [...(byDay.get(d.day) ?? []), worst]);
  }
  if (status) byDay.set(today, [...(byDay.get(today) ?? []), ...hosts.map((h) => liveLevel(status.hosts[h.id], filter))]);
  return keys.map((k) => {
    const cell: SiteCell = { level: 'none', alert: 0, warn: 0 };
    for (const l of byDay.get(k) ?? []) {
      if (l === 'alert') cell.alert++;
      if (l === 'warn') cell.warn++;
      if (cellRank[l] > cellRank[cell.level]) cell.level = l;
    }
    return cell;
  });
}
