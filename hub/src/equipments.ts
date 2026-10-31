import { isIP } from 'node:net';
import type { ObjectId } from 'mongodb';
import { equipments, probes } from './db.js';
import { publish } from './events.js';
import { carriedBy } from './roles.js';
import type { EquipmentDoc, EquipmentType, ProbeDoc } from './types.js';

// Equipment: what is followed without an agent (network gear, gateways, home automation modules...). Like a host
// it has native checks, reported by its source (none for a manual one), and probes (probes.ts, subject equipment).
//
// Contract of the automatic sources (Omada first, #231): a source creates and updates its equipment by
// (source, externalId) and writes `native` at each synchronisation (monitoring.ts reads it for the connection
// domain). The fields it provides are not edited by hand: only the name is.

export const SOURCE_FIELDS = ['type', 'siteId', 'ip', 'uplinkId'] as const;

export const TYPE_LABELS: Record<EquipmentType, string> = {
  gateway: 'Gateway',
  switch: 'Switch',
  ap: "Point d'accès",
  coordinator: 'Coordinateur',
  bridge: 'Passerelle',
  iot: 'Module domotique',
  other: 'Autre',
};

export function equipmentDto(e: EquipmentDoc, own: ProbeDoc[] = []) {
  return {
    id: e._id.toHexString(),
    name: e.name,
    type: e.type,
    siteId: e.siteId ?? null,
    ip: e.ip ?? null,
    source: e.source,
    externalId: e.externalId ?? null,
    uplinkId: e.uplinkId?.toHexString() ?? null,
    native: e.native ?? null,
    // roles of the hub it carries (an Omada controller), never a secret
    roles: carriedBy(e._id).map((r) => ({ id: r._id, type: r.type, name: r.name })),
    createdAt: e.createdAt,
    // what the lists and the dashboard show of its probes, one square each
    probes: own.map((p) => ({ id: p._id.toHexString(), name: p.name, state: p.state ?? 'unknown', message: p.message ?? null })),
  };
}

export const ipError = (ip: string) => (isIP(ip) ? null : 'adresse IP invalide');

// The upstream chain of an equipment must end: no equipment upstream of itself. upOf: the uplink of an equipment,
// null when it does not exist. null: valid, else why not.
export function uplinkError(id: string | null, uplinkId: string, upOf: (id: string) => string | undefined | null): string | null {
  if (upOf(uplinkId) === null) return 'équipement amont introuvable';
  const seen = new Set(id ? [id] : []);
  for (let cur: string | undefined | null = uplinkId; cur; cur = upOf(cur)) {
    if (seen.has(cur)) return 'boucle : cet équipement serait en amont de lui-même';
    seen.add(cur);
  }
  return null;
}

// Its probes and its history go with it; the equipment below it lose their uplink.
export async function removeEquipment(_id: ObjectId) {
  const below = await equipments.find({ uplinkId: _id }, { projection: { _id: 1 } }).toArray();
  await probes.deleteMany({ 'subject.kind': 'equipment', 'subject.id': _id });
  await equipments.updateMany({ uplinkId: _id }, { $unset: { uplinkId: '' } });
  await equipments.deleteOne({ _id });
  publish('probe.config', {});
  publish('equipment.deleted', { id: _id.toHexString() });
  for (const e of below) publish('equipment', { id: e._id.toHexString() });
}
