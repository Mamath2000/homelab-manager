// ===============================
// Home Assistant: level of detail of the published entities
// ===============================
// A level is a preset of sections, set on each home-assistant role for all it publishes. Sections are published per host
// (apt, docker, ups, backup, probes, sessions, actions, diagnostics) or once for the hub (counters, tops, equipments).
// Alerts and the connectivity of a host are always published, whatever the level: they roll up from the registry, not
// from the sub-devices.
import type { HaDetail, HaLevel, HaSection } from '../types.js';

export const HA_SECTIONS: readonly HaSection[] = [
  'counters', 'tops', 'equipments', 'apt', 'docker', 'ups', 'backup', 'probes', 'sessions', 'actions', 'diagnostics',
];

export const HA_PRESETS: Record<HaLevel, readonly HaSection[]> = {
  minimal: ['tops'],
  standard: ['tops', 'counters', 'equipments', 'apt', 'docker', 'ups', 'backup', 'probes'],
  full: HA_SECTIONS,
};

export const DEFAULT_DETAIL: HaDetail = { level: 'minimal', sections: [] };

export function sectionsOf(detail: HaDetail): Set<HaSection> {
  return new Set(detail.level === 'custom' ? detail.sections : HA_PRESETS[detail.level]);
}

export function normalizeDetail(raw: Partial<HaDetail> | undefined): HaDetail {
  const level = raw?.level;
  if (level !== 'custom' && !(level && level in HA_PRESETS)) return DEFAULT_DETAIL;
  return { level, sections: level === 'custom' ? HA_SECTIONS.filter((s) => raw?.sections?.includes(s)) : [] };
}
