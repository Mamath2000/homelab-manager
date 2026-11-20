import { isIP } from 'node:net';
import type { ObjectId } from 'mongodb';
import { equipments, probes } from './db.js';
import { publish } from './events.js';
import { esphomeDevice } from './esphome.js';
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

// An equipment of ESPHome: the name its lines carry (hostname of the Logs page) and its sub-device (null: the ESP itself).
export function esphomeOf(e: Pick<EquipmentDoc, 'source' | 'externalId'>) {
  if (e.source !== 'esphome' || !e.externalId) return null;
  const [broker, uniqueId, device] = e.externalId.split('/');
  if (!broker || !uniqueId) return null;
  const d = esphomeDevice(`${broker}/${uniqueId}`);
  return { key: `${broker}/${uniqueId}`, hostname: d?.info?.name ?? uniqueId, device: device ?? null, logs: !!d?.logs };
}

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
    esphome: esphomeOf(e),
    // roles of the hub it carries (an Omada controller), never a secret
    roles: carriedBy(e._id).map((r) => ({ id: r._id, type: r.type, name: r.name })),
    createdAt: e.createdAt,
    // what the lists and the dashboard show of its probes, one square each
    // vpn: the probe of a site-to-site tunnel (vpnProbes.ts), configured once its source and target are chosen
    probes: own.map((p) => ({ id: p._id.toHexString(), name: p.name, state: p.state ?? 'unknown', message: p.message ?? null, vpn: p.target.type === 'vpn' ? { configured: p.runFrom !== 'hub' && !!p.target.host } : null })),
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
