import type { Host, SiteConfig, TagConfig } from './api';
import { connection, needsReinstall, updateState, type Connection, type UpdateState } from './status';

export type HostFilter = 'all' | Connection | Exclude<UpdateState, 'uptodate' | 'unknown'> | 'reboot' | 'cleanup' | 'agent' | 'reinstall';

export const hostFilters: { key: HostFilter; label: string }[] = [
  { key: 'all', label: 'Tous' },
  { key: 'online', label: 'En ligne' },
  { key: 'offline', label: 'Hors ligne' },
  { key: 'pending', label: 'En attente' },
  { key: 'away', label: 'Absents' },
  { key: 'updates', label: 'Mises à jour' },
  { key: 'security', label: 'Sécurité' },
  { key: 'reboot', label: 'Reboot' },
  { key: 'cleanup', label: 'À nettoyer' },
  { key: 'agent', label: 'Agent obsolète' },
  { key: 'reinstall', label: 'À réinstaller' },
];

export function parseHostFilter(value: string | null): HostFilter {
  return hostFilters.find((filter) => filter.key === value)?.key ?? 'all';
}

export function hostMatchesSearch(host: Host, query: string, sites: SiteConfig[], tags: TagConfig[]) {
  const needle = query.toLowerCase();
  if (!needle) return true;
  const siteName = sites.find((site) => site.id === host.siteId)?.name;
  const tagNames = tags.filter((tag) => host.tags.includes(tag.id)).map((tag) => tag.name);
  return [host.name, siteName, ...tagNames, host.info?.hostname, ...(host.info?.ips ?? [])]
    .some((value) => value?.toLowerCase().includes(needle));
}

export function filterHosts(hosts: Host[], query: string, filter: HostFilter, site: string, tag: string, sites: SiteConfig[], tags: TagConfig[]) {
  // by name: the list and the previous / next of a host follow the same order
  return [...hosts].sort((a, b) => a.name.localeCompare(b.name)).filter((host) => {
    if (site && (site === 'none' ? !!host.siteId : host.siteId !== site)) return false;
    if (tag && !host.tags.includes(tag)) return false;
    if (!hostMatchesSearch(host, query, sites, tags)) return false;
    switch (filter) {
      case 'online':
      case 'offline':
      case 'pending':
      case 'away':
        return connection(host) === filter;
      case 'updates':
        return (host.aptSummary?.upgradable ?? 0) > 0;
      case 'security':
        return updateState(host) === 'security';
      case 'agent':
        return !!host.agentOutdated;
      case 'reinstall':
        return needsReinstall(host);
      case 'cleanup':
        return (host.aptSummary?.autoremovable ?? 0) > 0;
      case 'reboot':
        return !!host.aptSummary?.rebootRequired || !!host.aptSummary?.rebootPending;
      default:
        return true;
    }
  });
}
