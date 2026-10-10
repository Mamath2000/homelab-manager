import { SETUP_MODULES, type AptReport, type AptSummary, type HostDoc } from './types.js';
import { isOnline } from './agents.js';
import { needsReboot } from './reboot.js';
import { INSTALLED_TTL_MS } from './installed.js';
import { agentBinary, agentOutdated } from './agentBinaries.js';
import { dockerSummary, dockerView } from './docker.js';

export function summarize(report: AptReport): AptSummary {
  return {
    upgradable: report.upgradable.length,
    security: report.upgradable.filter((p) => p.security).length,
    held: report.held.length,
    rebootRequired: report.rebootRequired,
    rebootPending: report.upgradable.filter((p) => needsReboot(p.name)).length,
    autoremovable: report.autoremovable ? report.autoremovable.length : null,
  };
}

// last conformity check with the standard configuration; drift counts the modules to re-apply
export function setupDto(h: HostDoc) {
  if (!h.setup) return null;
  // checks of a removed module (stored before the upgrade) are dropped
  const modules = h.setup.modules.filter((m) => SETUP_MODULES.includes(m.module));
  return { ...h.setup, modules, drift: modules.filter((m) => m.state === 'drift' || m.state === 'error').length };
}

export function hostDto(h: HostDoc) {
  const docker = dockerView(h);
  return {
    id: h._id.toHexString(),
    name: h.name,
    group: h.group ?? '',
    createdAt: h.createdAt,
    enrolledAt: h.enrolledAt ?? null,
    lastSeenAt: h.lastSeenAt ?? null,
    online: isOnline(h._id.toHexString()),
    agentVersion: h.agentVersion ?? null,
    // cert: TLS client certificate; legacy: plain-text token of the first versions, to reinstall
    agentAuth: h.certFingerprint ? 'cert' : h.tokenHash ? 'legacy' : 'none',
    certIssuedAt: h.certIssuedAt ?? null,
    enrollExpiresAt: h.enrollExpiresAt && h.enrollExpiresAt > new Date() ? h.enrollExpiresAt : null,
    capabilities: h.capabilities ?? [],
    recentlyInstalled: (h.recentlyInstalled ?? [])
      .filter((p) => Date.now() - p.at < INSTALLED_TTL_MS)
      // still waiting for the reboot that makes it effective
      .map((p) => ({ ...p, rebootRequired: !!h.apt?.rebootRequired && needsReboot(p.name) })),
    agentOutdated: agentOutdated(h),
    latestAgentVersion: agentBinary(h.info?.arch)?.version ?? null,
    info: h.info ?? null,
    // computed on read so that reports stored by older hub versions are covered too
    apt: h.apt ? { ...h.apt, upgradable: h.apt.upgradable.map((p) => ({ ...p, reboot: needsReboot(p.name) })) } : null,
    aptSummary: h.apt ? summarize(h.apt) : null,
    // compose stacks, with the update state of each service (null without Docker)
    docker,
    dockerSummary: dockerSummary(docker),
    setupUser: h.setupUser ?? null,
    setup: setupDto(h),
  };
}
