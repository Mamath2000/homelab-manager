import type { Host, SiteConfig } from './api';
import { connection, connectionMeta, hasApt, needsReinstall, updateState, type Tone } from './status';

// Figures of the header of the Hosts page: health of the fleet, sites × systems matrix, what needs action.

export const OS_OTHER = 'autres';
// The matrix shows this many distributions, the others go in one column.
const OS_COLUMNS = 3;

const distroLabels: Record<string, string> = { haos: 'Home Assistant OS', unraid: 'Unraid', windows: 'Windows' };

// Distribution of a host (version and variant such as WSL left out), '' when unknown.
export function osKey(h: Host) {
  return h.info?.osId || (h.osFamily === 'windows' ? 'windows' : '');
}

export function osName(key: string) {
  if (!key) return 'Inconnu';
  return distroLabels[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

export interface OsColumn {
  key: string;
  label: string;
  // distributions gathered in the 'autres' column
  merged?: string[];
}

// The most frequent distributions, then the others together.
export function osColumns(hosts: Host[]): OsColumn[] {
  const count = new Map<string, number>();
  for (const h of hosts) count.set(osKey(h), (count.get(osKey(h)) ?? 0) + 1);
  const sorted = [...count.entries()].sort((a, b) => b[1] - a[1] || osName(a[0]).localeCompare(osName(b[0]), 'fr'));
  const shown = sorted.length > OS_COLUMNS + 1 ? sorted.slice(0, OS_COLUMNS) : sorted;
  const columns: OsColumn[] = shown.map(([key]) => ({ key, label: osName(key) }));
  const rest = sorted.slice(shown.length);
  if (rest.length) columns.push({ key: OS_OTHER, label: 'Autres', merged: rest.map(([key]) => osName(key)) });
  return columns;
}

export const inColumn = (h: Host, col: OsColumn, columns: OsColumn[]) =>
  col.key === OS_OTHER ? !columns.some((c) => c.key === osKey(h)) : osKey(h) === col.key;

const rank: Record<Tone, number> = { bad: 4, warn: 3, unknown: 2, neutral: 1, info: 1, ok: 0 };

// Worst state of a host: connection first, then what is pending on it.
export function hostTone(h: Host): Tone {
  const tones: Tone[] = [connectionMeta(h).tone];
  const state = updateState(h);
  if (hasApt(h)) tones.push(state === 'security' ? 'bad' : state === 'updates' || state === 'reboot' ? 'warn' : 'ok');
  if (h.agentOutdated || h.dockerSummary?.updates) tones.push('warn');
  return tones.reduce((w, t) => (rank[t] > rank[w] ? t : w), 'ok' as Tone);
}

export const worstTone = (hosts: Host[]): Tone => hosts.reduce<Tone>((w, h) => (rank[hostTone(h)] > rank[w] ? hostTone(h) : w), 'ok');

export interface Part {
  n: number;
  label: string;
  tone: Tone;
}

const count = (hosts: Host[], f: (h: Host) => boolean) => hosts.filter(f).length;

export function overview(hosts: Host[]) {
  const apt = hosts.filter(hasApt);
  const state = (s: ReturnType<typeof updateState>) => count(apt, (h) => updateState(h) === s);
  const fleet: Part[] = [
    { n: count(hosts, (h) => connection(h) === 'online'), label: 'en ligne', tone: 'ok' },
    { n: count(hosts, (h) => connection(h) === 'away'), label: 'absents', tone: 'neutral' },
    { n: count(hosts, (h) => connection(h) === 'offline'), label: 'hors ligne', tone: 'bad' },
    { n: count(hosts, (h) => connection(h) === 'pending'), label: 'en attente', tone: 'unknown' },
  ];
  const updates: Part[] = [
    { n: state('uptodate'), label: 'à jour', tone: 'ok' },
    { n: state('updates'), label: 'avec MAJ', tone: 'warn' },
    { n: state('security'), label: 'sécurité', tone: 'bad' },
    { n: state('reboot'), label: 'reboot', tone: 'info' },
    { n: state('unknown'), label: 'inconnu', tone: 'unknown' },
  ];
  const packages = apt.reduce((a, h) => a + (h.aptSummary?.upgradable ?? 0), 0);
  const security = apt.reduce((a, h) => a + (h.aptSummary?.security ?? 0), 0);
  return { fleet, updates, aptHosts: apt.length, packages, security };
}

// What needs action: each one is a filter of the list.
export const todoItems: { key: string; label: string; short: string; tone: Tone; test: (h: Host) => boolean }[] = [
  { key: 'offline', label: 'Hors ligne', short: 'Hors ligne', tone: 'bad', test: (h) => connection(h) === 'offline' },
  { key: 'security', label: 'Mises à jour de sécurité', short: 'Sécurité', tone: 'bad', test: (h) => updateState(h) === 'security' },
  { key: 'reboot', label: 'Redémarrage requis ou à prévoir', short: 'Reboot', tone: 'info', test: (h) => !!h.aptSummary?.rebootRequired || !!h.aptSummary?.rebootPending },
  { key: 'agent', label: 'Agent obsolète', short: 'Agents', tone: 'warn', test: (h) => !!h.agentOutdated },
  { key: 'docker', label: 'Image Docker à mettre à jour', short: 'Docker', tone: 'warn', test: (h) => (h.dockerSummary?.updates ?? 0) > 0 },
  { key: 'reinstall', label: 'Agent à réinstaller', short: 'Réinstaller', tone: 'warn', test: needsReinstall },
];

export interface SiteRow {
  id: string;
  name: string;
  hosts: Host[];
}

// Sites of the settings, in their order, then the hosts without site; empty ones are left out.
export function siteRows(hosts: Host[], sites: SiteConfig[]): SiteRow[] {
  const rows = sites.map((s) => ({ id: s.id, name: s.name, hosts: hosts.filter((h) => h.siteId === s.id) }));
  rows.push({ id: 'none', name: 'Sans site', hosts: hosts.filter((h) => !h.siteId) });
  return rows.filter((r) => r.hosts.length > 0);
}
