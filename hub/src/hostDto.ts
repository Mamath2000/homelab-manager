import { SETUP_OPTIONS, type AptReport, type AptSummary, type HostDoc } from './types.js';
import { isOnline } from './agents.js';
import { needsReboot } from './reboot.js';
import { INSTALLED_TTL_MS } from './installed.js';
import { agentOutdated, hostBinary, hostOs } from './agentBinaries.js';
import { dockerSummary, dockerView } from './docker.js';
import { healthWithSilenced } from './healthSilence.js';
import { sessionSummary } from './sessions.js';

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
  // checks of options that no longer exist (stored before an upgrade) are dropped
  const modules = h.setup.modules.filter((m) => SETUP_OPTIONS.includes(m.module));
  return { ...h.setup, modules, drift: modules.filter((m) => m.state === 'drift' || m.state === 'error').length };
}

export function hostDto(h: HostDoc) {
  const docker = dockerView(h);
  return {
    id: h._id.toHexString(),
    name: h.name,
    siteId: h.siteId ?? null,
    tags: h.tags ?? [],
    createdAt: h.createdAt,
    enrolledAt: h.enrolledAt ?? null,
    lastSeenAt: h.lastSeenAt ?? null,
    online: isOnline(h._id.toHexString()),
    roaming: !!h.roaming,
    critical: !!h.critical,
    haExcluded: !!h.haExcluded,
    accessNetwork: h.accessNetwork ?? 'lan',
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
    latestAgentVersion: hostBinary(h)?.version ?? null,
    info: h.info ?? null,
    osFamily: hostOs(h),
    // Windows: path of the backup CLI set in the options (checked by the agent: capability backup:cli)
    backupClientPath: h.backupClientPath ?? null,
    // Windows: user sessions, and what they mean (someone logged on, all locked)
    sessions: h.sessions ?? null,
    sessionSummary: sessionSummary(h.sessions),
    // computed on read so that reports stored by older hub versions are covered too
    apt: h.apt ? { ...h.apt, upgradable: h.apt.upgradable.map((p) => ({ ...p, reboot: needsReboot(p.name) })) } : null,
    aptSummary: h.apt ? summarize(h.apt) : null,
    // compose stacks, with the update state of each service (null without Docker)
    docker,
    dockerSummary: dockerSummary(docker),
    // UPS monitored by NUT on the host (null: none)
    ups: h.ups ?? null,
    health: healthWithSilenced(h.health, h.healthSilenced),
    smartDevices: h.smartDevices ?? [],
    setupOverrides: h.setupOverrides ?? {},
    setup: setupDto(h),
    // Proxmox VE guest this host is (see pve.ts)
    pve: h.pve ?? null,
    // snapshot of a PBS mounted here (pbsMount.ts); the agent link stays in the hub
    pbsMount: h.pbsMount ? (({ link, ...m }) => ({ ...m, pbsHostId: link.hostId }))(h.pbsMount) : null,
  };
}
