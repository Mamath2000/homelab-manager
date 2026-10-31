import type { Equipment, EquipmentType, SiteConfig, StatusView } from './api';
import { EQUIPMENT_TYPES, equipmentTone } from './equipment';
import type { Part } from './hostOverview';
import type { Tone } from './status';

// Figures of the header of the Equipments page, as the one of the Hosts page: state of the equipments and their probes,
// sites × types matrix, what needs action. tone: the state of an equipment (equipmentTone), neutral when not followed.

// short labels of the columns of the matrix
const SHORT: Record<EquipmentType, string> = {
  gateway: 'Gateway',
  switch: 'Switch',
  ap: 'AP',
  coordinator: 'Coord.',
  bridge: 'Passerelle',
  iot: 'Domotique',
  other: 'Autre',
};

export interface TypeColumn {
  key: EquipmentType;
  label: string;
}

// The types that have equipment, in the order of the catalog.
export const typeColumns = (list: Equipment[]): TypeColumn[] => EQUIPMENT_TYPES.filter((t) => list.some((e) => e.type === t)).map((t) => ({ key: t, label: SHORT[t] }));

const rank: Record<Tone, number> = { bad: 4, warn: 3, unknown: 2, neutral: 1, info: 1, ok: 0 };

export const worstEquipmentTone = (list: Equipment[], status: StatusView | undefined): Tone =>
  list.reduce<Tone>((w, e) => {
    const t = equipmentTone(status, e);
    return rank[t] > rank[w] ? t : w;
  }, 'ok');

export interface EquipmentSiteRow {
  id: string;
  name: string;
  items: Equipment[];
}

// Sites of the settings in their order, then the equipments without (known) site; empty ones are left out.
export function equipmentSiteRows(list: Equipment[], sites: SiteConfig[]): EquipmentSiteRow[] {
  const known = new Set(sites.map((s) => s.id));
  return [
    ...sites.map((s) => ({ id: s.id, name: s.name, items: list.filter((e) => e.siteId === s.id) })),
    { id: 'none', name: 'Sans site', items: list.filter((e) => !e.siteId || !known.has(e.siteId)) },
  ].filter((r) => r.items.length > 0);
}

export const inSite = (e: Equipment, siteId: string, sites: SiteConfig[]) =>
  siteId === 'none' ? !e.siteId || !sites.some((s) => s.id === e.siteId) : e.siteId === siteId;

const failing = (e: Equipment) => e.probes.some((p) => p.state === 'down');

export function equipmentOverview(list: Equipment[], status: StatusView | undefined) {
  const tone = (t: Tone) => list.filter((e) => equipmentTone(status, e) === t).length;
  const fleet: Part[] = [
    { n: tone('ok'), label: 'OK', tone: 'ok' },
    { n: tone('warn'), label: 'en avertissement', tone: 'warn' },
    { n: tone('bad'), label: 'en alerte', tone: 'bad' },
    { n: tone('neutral'), label: 'non suivis', tone: 'neutral' },
  ];
  const probes = list.flatMap((e) => e.probes);
  const probeParts: Part[] = [
    { n: probes.filter((p) => p.state === 'up').length, label: 'en ligne', tone: 'ok' },
    { n: probes.filter((p) => p.state === 'down').length, label: 'hors service', tone: 'bad' },
    { n: probes.filter((p) => p.state === 'unknown').length, label: 'inconnues', tone: 'unknown' },
  ];
  return { fleet, ok: fleet[0].n, probes: probeParts, probesUp: probeParts[0].n, probeCount: probes.length };
}

// What needs action: each one is a filter of the list (f=…).
export const equipmentTodo: { key: string; label: string; short: string; tone: Tone; test: (e: Equipment, status: StatusView | undefined) => boolean }[] = [
  { key: 'alert', label: 'En alerte', short: 'Alerte', tone: 'bad', test: (e, s) => equipmentTone(s, e) === 'bad' },
  { key: 'warn', label: 'En avertissement', short: 'Avertissement', tone: 'warn', test: (e, s) => equipmentTone(s, e) === 'warn' },
  { key: 'probes', label: 'Une sonde au moins hors service', short: 'Sondes', tone: 'bad', test: failing },
  { key: 'unfollowed', label: 'Ni sonde ni source automatique : pas suivi', short: 'Non suivis', tone: 'neutral', test: (e, s) => equipmentTone(s, e) === 'neutral' },
];
