import { isOnline } from './agents.js';
import { jobs } from './db.js';
import { createJob } from './jobs.js';
import type { AptReport, AutoInstalled, HostDoc, JobDoc } from './types.js';

// Automatic security updates, chosen in the options of each host (homelab#233). The agent applies the choice
// (apt_auto_set: unattended-upgrades restricted to the security origins, or its managed file removed) and its apt
// report says what is in place.

const PKG_RE = /^[a-z0-9][a-z0-9+.\-]*$/;
const version = (v: unknown) => (typeof v === 'string' && v.length <= 128 ? v : '');

// The fields of the report about it, kept in their form only (agents without apt_auto send none).
export function cleanAutoReport(r: AptReport): AptReport {
  const { auto, autoInstalled, ...rest } = r as AptReport & Record<string, unknown>;
  const a = auto as Record<string, unknown> | undefined;
  const installs: AutoInstalled[] = [];
  for (const p of Array.isArray(autoInstalled) ? (autoInstalled as unknown as Record<string, unknown>[]).slice(0, 50) : []) {
    if (!p || typeof p.name !== 'string' || p.name.length > 128 || !PKG_RE.test(p.name) || typeof p.at !== 'number' || !Number.isFinite(p.at)) continue;
    installs.push({ name: p.name, ...(version(p.from) ? { from: version(p.from) } : {}), to: version(p.to), at: p.at });
  }
  return {
    ...rest,
    ...(a && typeof a === 'object' ? { auto: { package: a.package === true, enabled: a.enabled === true, managed: a.managed === true } } : {}),
    ...(Array.isArray(autoInstalled) ? { autoInstalled: installs } : {}),
  };
}

export const canAutoUpgrade = (h: Pick<HostDoc, 'capabilities'>) => !!h.capabilities?.includes('apt_auto');

// The state the host has to be put in when its report differs from its choice (null: in line, or not reported yet).
export function autoUpgradeDrift(h: Pick<HostDoc, 'autoSecurityUpdates' | 'apt' | 'capabilities'>): boolean | null {
  const auto = h.apt?.auto;
  if (!canAutoUpgrade(h) || !auto) return null;
  const want = !!h.autoSecurityUpdates;
  return auto.managed === want ? null : want;
}

// Launches apt_auto_set when the host differs from its choice, online only: an offline host gets it from its next
// report. From a report (retry), an attempt that failed for the same choice is not repeated: saving the options again
// does.
export async function reconcileAutoUpgrade(host: HostDoc, trigger: Extract<JobDoc['trigger'], 'manual' | 'retry'>) {
  const want = autoUpgradeDrift(host);
  if (want === null || !isOnline(host._id.toHexString())) return null;
  const last = await jobs.findOne({ hostId: host._id, action: 'apt_auto_set' }, { sort: { createdAt: -1 }, projection: { status: 1, autoEnabled: 1 } });
  if (last?.status === 'running') return null;
  if (trigger === 'retry' && last?.status === 'failed' && last.autoEnabled === want) return null;
  return createJob(host, 'apt_auto_set', [], trigger, { enabled: want });
}
