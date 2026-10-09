import type { AptReport, AptSummary, HostDoc } from './types.js';
import { isOnline } from './agents.js';

export function summarize(report: AptReport): AptSummary {
  return {
    upgradable: report.upgradable.length,
    security: report.upgradable.filter((p) => p.security).length,
    held: report.held.length,
    rebootRequired: report.rebootRequired,
  };
}

export function hostDto(h: HostDoc) {
  return {
    id: h._id.toHexString(),
    name: h.name,
    group: h.group ?? '',
    createdAt: h.createdAt,
    enrolledAt: h.enrolledAt ?? null,
    lastSeenAt: h.lastSeenAt ?? null,
    online: isOnline(h._id.toHexString()),
    agentVersion: h.agentVersion ?? null,
    info: h.info ?? null,
    apt: h.apt ?? null,
    aptSummary: h.aptSummary ?? null,
  };
}
