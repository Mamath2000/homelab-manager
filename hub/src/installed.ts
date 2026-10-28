import type { AptReport, InstalledPackage } from './types.js';

export const INSTALLED_TTL_MS = 24 * 3600 * 1000;

// Packages that left the "upgradable" list between two reports were just installed: they are
// kept for a day so that the UI can show them as "installed" instead of silently dropping them.
export function recentlyInstalled(
  prev: AptReport | undefined,
  next: AptReport,
  previous: InstalledPackage[] = [],
  now = Date.now(),
): InstalledPackage[] {
  const pending = new Set(next.upgradable.map((p) => p.name));
  const gone = (prev?.upgradable ?? [])
    .filter((p) => !pending.has(p.name))
    .map((p) => ({ name: p.name, from: p.current, to: p.candidate, at: now }));
  const fresh = new Set(gone.map((p) => p.name));
  const kept = previous.filter((p) => now - p.at < INSTALLED_TTL_MS && !pending.has(p.name) && !fresh.has(p.name));
  return [...gone, ...kept];
}
