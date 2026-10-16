import { agentAlerts, aptAlerts, dockerAlerts } from './homeassistant/alerts.js';
import { dockerView } from './docker.js';
import { hostDto } from './hostDto.js';
import type { HostDoc } from './types.js';

// Global counters, same rules as the root device of Home Assistant (hosts excluded from HA are left out).
// Backups are not counted: see /api/backups.
export function summarize(all: HostDoc[], now = Date.now()) {
  const list = all.filter((h) => !h.haExcluded).map((h) => ({ doc: h, dto: hostDto(h) }));
  let alerts = 0;
  let critical = 0;
  for (const { doc, dto } of list) {
    const found = [
      ...agentAlerts(doc, dto.online, dto.agentOutdated),
      ...aptAlerts(doc, dto.online, now),
      ...(dockerView(doc)?.stacks.filter((st) => st.managed).flatMap(dockerAlerts) ?? []),
    ];
    alerts += found.length;
    critical += found.filter((a) => a.level === 'critical').length;
  }
  return {
    hosts: list.length,
    // a roaming host is expected to be offline
    hostsOffline: list.filter(({ dto }) => !dto.online && !dto.roaming).length,
    updates: list.reduce((n, { dto }) => n + (dto.aptSummary?.upgradable ?? 0), 0),
    security: list.reduce((n, { dto }) => n + (dto.aptSummary?.security ?? 0), 0),
    hostsToUpdate: list.filter(({ dto }) => dto.aptSummary?.upgradable).length,
    hostsToReboot: list.filter(({ dto }) => dto.aptSummary?.rebootRequired).length,
    hostsToClean: list.filter(({ dto }) => dto.aptSummary?.autoremovable).length,
    agentsOutdated: list.filter(({ dto }) => dto.agentOutdated).length,
    stacks: list.reduce((n, { dto }) => n + (dto.dockerSummary?.stacks ?? 0), 0),
    stacksToUpdate: list.reduce((n, { dto }) => n + (dto.dockerSummary?.updates ?? 0), 0),
    alerts,
    critical,
  };
}
