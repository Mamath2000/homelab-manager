import type { Equipment, EquipmentSource, EquipmentType, ProbeState, StatusView } from './api';
import { levelTone } from './monitoring';
import { useSites } from './queries';
import type { Tone } from './status';

// Equipment (hub/src/equipments.ts): what is followed without an agent. Labels and levels of the lists.

export const TYPE_LABELS: Record<EquipmentType, string> = {
  gateway: 'Gateway',
  switch: 'Switch',
  ap: "Point d'accès",
  coordinator: 'Coordinateur',
  bridge: 'Passerelle',
  iot: 'Module domotique',
  other: 'Autre',
};
export const EQUIPMENT_TYPES = Object.keys(TYPE_LABELS) as EquipmentType[];

export const SOURCE_LABELS: Record<EquipmentSource, string> = { manual: 'Manuel', omada: 'Omada' };

// Level of an equipment: its worst read domain; neutral when nothing is followed (no probe yet) or nothing can be read.
export function equipmentTone(status: StatusView | undefined, e: Pick<Equipment, 'id'>): Tone {
  const s = status?.equipments[e.id];
  if (!s || !Object.values(s.domains).some((d) => d && d.level !== 'unknown')) return 'neutral';
  return levelTone[s.level];
}

export const probeCls: Record<ProbeState, string> = { up: 'bg-emerald-500', down: 'bg-red-500', unknown: 'bg-zinc-600' };
const probeLabel: Record<ProbeState, string> = { up: 'up', down: 'down', unknown: 'inconnu' };

export const probeText = (p: Equipment['probes'][number]) => `${p.name} : ${probeLabel[p.state]}${p.state !== 'up' && p.message ? ` (${p.message})` : ''}`;

// Name of the site of an equipment, for the lists.
export function useSiteName() {
  const { data: sites } = useSites();
  return (siteId: string | null) => sites?.find((s) => s.id === siteId)?.name ?? null;
}
