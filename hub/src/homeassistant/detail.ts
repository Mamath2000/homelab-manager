// ===============================
// Home Assistant: level of detail of the published entities
// ===============================
// A level is a preset of sections. Sections are published per host (apt, docker, ups, backup, sessions, actions,
// diagnostics) or once for the hub (counters, tops). Alerts and the connectivity of a host are always published
// (unless the host is set to 'none'), whatever the level: they roll up from the registry, not from the sub-devices.
import type { HaDetail, HaHostLevel, HaLevel, HaSection, HostDoc } from '../types.js';

export const HA_SECTIONS: readonly HaSection[] = [
  'counters', 'tops', 'apt', 'docker', 'ups', 'backup', 'sessions', 'actions', 'diagnostics',
];

export const HA_PRESETS: Record<HaLevel, readonly HaSection[]> = {
  minimal: ['tops'],
  standard: ['tops', 'counters', 'apt', 'docker', 'ups', 'backup'],
  full: HA_SECTIONS,
};

export const DEFAULT_DETAIL: HaDetail = { level: 'minimal', sections: [] };

export function sectionsOf(detail: HaDetail): Set<HaSection> {
  return new Set(detail.level === 'custom' ? detail.sections : HA_PRESETS[detail.level]);
}

// level of a host: its own, else the legacy "excluded" flag, else the global one (null: follows the global level)
export function hostLevel(host: Pick<HostDoc, 'haDetail' | 'haExcluded'>): HaHostLevel | null {
  return host.haDetail ?? (host.haExcluded ? 'none' : null);
}

export function hostSections(host: Pick<HostDoc, 'haDetail' | 'haExcluded'>, global: Set<HaSection>): Set<HaSection> {
  const level = hostLevel(host);
  if (level === null) return global;
  return new Set(level === 'none' ? [] : HA_PRESETS[level]);
}

export function normalizeDetail(raw: Partial<HaDetail> | undefined): HaDetail {
  const level = raw?.level;
  if (level !== 'custom' && !(level && level in HA_PRESETS)) return DEFAULT_DETAIL;
  return { level, sections: level === 'custom' ? HA_SECTIONS.filter((s) => raw?.sections?.includes(s)) : [] };
}
