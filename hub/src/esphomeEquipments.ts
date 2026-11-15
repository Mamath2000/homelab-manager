import { ObjectId } from 'mongodb';
import { sameName } from './catalog.js';
import { equipments, esphome, probes } from './db.js';
import { brokerSites, esphomeDevices } from './esphome.js';
import { publish } from './events.js';
import { INTERVAL_RANGE, TIMEOUT_RANGE } from './probes.js';
import { esphomeRole } from './roles.js';
import type { EquipmentDoc, EsphomeDeviceDoc, ProbeDoc } from './types.js';

// ESPHome as a source of equipment (homelab#352). An ESP becomes an equipment only when the admin says so (created, or linked
// to a manual one): (source esphome, externalId <broker>/<unique_id>), type iot, site of its broker, IP from its info, with a
// ping on its IP and a probe on its LWT. Each of its sub-devices (esphome: devices:) chosen becomes an equipment of its own,
// externalId <broker>/<unique_id>/<id>, below the ESP (uplink), with its own probe on the LWT of the ESP. What the source
// provides (site, IP, uplink) follows the device: rewritten when its info or the site of its broker changes.

export class EsphomeLinkError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}

export const subKey = (key: string, subId: string) => `${key}/${subId}`;
export const lwtTopic = (uniqueId: string) => `esphome/${uniqueId}/LWT`;
// the equipments of a device: its own and the ones of its sub-devices (a unique_id never holds a '/': it is a topic level)
const ofDevice = (key: string) => ({ source: 'esphome' as const, $or: [{ externalId: key }, { externalId: { $regex: `^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/` } }] });

// The probes made with an equipment of the device: its LWT (online), and a ping on its IP for the ESP itself. One the
// equipment already has (a manual equipment linked) is not made twice.
export function esphomeProbes(equipmentId: ObjectId, d: Pick<EsphomeDeviceDoc, 'brokerId' | 'uniqueId' | 'info'>, ping: boolean, existing: Pick<ProbeDoc, 'target'>[]): ProbeDoc[] {
  const base = { subject: { kind: 'equipment' as const, id: equipmentId }, runFrom: 'hub' as const, intervalSec: INTERVAL_RANGE.default, timeoutSec: TIMEOUT_RANGE.default, retries: 0 };
  const topic = lwtTopic(d.uniqueId);
  const out: ProbeDoc[] = [];
  if (!existing.some((p) => p.target.type === 'mqtt' && p.target.brokerId === d.brokerId && p.target.topic === topic)) {
    out.push({ _id: new ObjectId(), ...base, name: 'LWT', target: { type: 'mqtt', brokerId: d.brokerId, topic, contains: 'online' }, createdAt: new Date() });
  }
  const ip = d.info?.ip;
  if (ping && ip && !existing.some((p) => p.target.type === 'ping')) out.push({ _id: new ObjectId(), ...base, name: 'Ping', target: { type: 'ping', host: ip }, createdAt: new Date() });
  return out;
}

// What the source provides of the ESP (SOURCE_FIELDS of equipments.ts), and of a sub-device (below the ESP, no address).
export const providedOf = (d: Pick<EsphomeDeviceDoc, 'info'>, siteId: string | null | undefined) => ({ type: 'iot' as const, ...(siteId ? { siteId } : {}), ...(d.info?.ip ? { ip: d.info.ip } : {}) });

// The manual equipments that could be this ESP: same address first, else same name (its name or its unique_id) on its site.
export function candidatesFor(d: Pick<EsphomeDeviceDoc, 'info' | 'uniqueId'>, list: Pick<EquipmentDoc, '_id' | 'name' | 'ip' | 'siteId' | 'source'>[], siteId?: string | null) {
  const free = list.filter((e) => e.source === 'manual');
  const byIp = d.info?.ip ? free.filter((e) => e.ip === d.info!.ip) : [];
  if (byIp.length) return byIp;
  const names = [d.info?.name, d.uniqueId].filter((n): n is string => !!n);
  return free.filter((e) => names.some((n) => sameName(e.name, n)) && (e.siteId ?? '') === (siteId ?? ''));
}

// The names that would be twice on the site: among the equipments there (except the one linked, that keeps its name) and
// among the ones being made. null: none.
export function nameClash(wanted: string[], taken: Pick<EquipmentDoc, 'name'>[]) {
  const seen: string[] = [];
  for (const n of wanted) {
    if (taken.some((e) => sameName(e.name, n)) || seen.some((x) => sameName(x, n))) return n;
    seen.push(n);
  }
  return null;
}

export interface CreateOptions {
  // the name of the ESP when it is created (its name in info, else its unique_id)
  name?: string;
  // a manual equipment that is this ESP: linked instead of made
  equipmentId?: ObjectId;
  // the sub-devices (ids of info.devices) to make equipments of
  devices: string[];
}

// Makes the equipment of an ESP (or links a manual one) and the ones of the sub-devices chosen; an ESP already made only
// gets the sub-devices it lacks. Everything is checked before anything is written.
export async function createEsphomeEquipments(key: string, o: CreateOptions) {
  const d = await esphome.findOne({ _id: key });
  if (!d || !esphomeRole()?.config.brokers.some((b) => b.brokerId === d.brokerId)) throw new EsphomeLinkError('appareil inconnu', 404);
  const siteId = (await brokerSites()).get(d.brokerId) ?? undefined;
  const subs = d.info?.devices ?? [];
  const unknown = o.devices.find((id) => !subs.some((s) => s.id === id));
  if (unknown) throw new EsphomeLinkError(`sous-appareil inconnu : ${unknown}`, 400);
  const mine = await equipments.find(ofDevice(key)).toArray();
  let esp = mine.find((e) => e.externalId === key) ?? null;
  const todo = subs.filter((s) => o.devices.includes(s.id) && !mine.some((e) => e.externalId === subKey(key, s.id)));
  if (esp && !todo.length) throw new EsphomeLinkError('cet appareil et ces sous-appareils sont déjà des équipements');

  let linked: EquipmentDoc | null = null;
  if (!esp && o.equipmentId) {
    linked = await equipments.findOne({ _id: o.equipmentId });
    if (!linked) throw new EsphomeLinkError('équipement introuvable', 404);
    if (linked.source !== 'manual') throw new EsphomeLinkError('cet équipement a déjà une source');
  }
  const espName = !esp && !linked ? o.name?.trim() || d.info?.name || d.uniqueId : null;
  const names = [...(espName ? [espName] : []), ...todo.map((s) => s.name ?? s.id)];
  const taken = await equipments.find({ siteId: siteId ?? { $exists: false }, ...(linked ? { _id: { $ne: linked._id } } : {}) }, { projection: { name: 1 } }).toArray();
  const clash = nameClash(names, taken);
  if (clash) throw new EsphomeLinkError(`un équipement s'appelle déjà « ${clash} » sur ce site${clash === espName ? ' : le relier plutôt' : ''}`);

  const provided = providedOf(d, siteId);
  // the equipments that get the probes of the source: the ESP made or linked now, and the sub-devices made
  const made: EquipmentDoc[] = [];
  if (!esp && linked) {
    const unset: Record<string, ''> = {};
    if (!provided.siteId) unset.siteId = '';
    if (!provided.ip) unset.ip = '';
    esp = (await equipments.findOneAndUpdate({ _id: linked._id }, { $set: { ...provided, source: 'esphome', externalId: key }, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { returnDocument: 'after' }))!;
    made.push(esp);
  } else if (!esp) {
    esp = { _id: new ObjectId(), name: espName!, ...provided, source: 'esphome', externalId: key, createdAt: new Date() };
    await equipments.insertOne(esp);
    made.push(esp);
  }
  const espId = esp._id;
  for (const s of todo) {
    const doc: EquipmentDoc = { _id: new ObjectId(), name: s.name ?? s.id, type: 'iot', ...(siteId ? { siteId } : {}), source: 'esphome', externalId: subKey(key, s.id), uplinkId: espId, createdAt: new Date() };
    await equipments.insertOne(doc);
    made.push(doc);
  }
  // sub-devices made before the ESP was (removed and made again) are below it again
  const orphans = mine.filter((e) => e.externalId !== key && !e.uplinkId?.equals(espId));
  if (orphans.length) await equipments.updateMany({ _id: { $in: orphans.map((e) => e._id) } }, { $set: { uplinkId: espId } });

  const own = await probes.find({ 'subject.kind': 'equipment', 'subject.id': { $in: made.map((e) => e._id) } }).toArray();
  const newProbes = made.flatMap((e) => esphomeProbes(e._id, d, e._id.equals(espId), own.filter((p) => p.subject.id.equals(e._id))));
  if (newProbes.length) await probes.insertMany(newProbes);
  publish('probe.config', {});
  for (const e of [...made, ...orphans]) publish('equipment', { id: e._id.toHexString() });
  return { equipment: esp, linked: !!linked, created: made.length - (linked ? 1 : 0) };
}

// Rewrites what the source provides of the equipments of a device: the site of its broker, the IP of its info (the ping
// made with it follows the address). Returns how many changed.
export async function syncEsphomeEquipments(d: EsphomeDeviceDoc, siteId: string | null | undefined) {
  const list = await equipments.find(ofDevice(d._id)).toArray();
  let changed = 0;
  for (const e of list) {
    const esp = e.externalId === d._id;
    const next = esp ? providedOf(d, siteId) : { ...(siteId ? { siteId } : {}) };
    // an ESP that does not tell its IP (no info) keeps the last one known
    const ip = esp ? (next as { ip?: string }).ip ?? e.ip : undefined;
    if ((e.siteId ?? null) === (siteId ?? null) && (!esp || ip === e.ip)) continue;
    const unset: Record<string, ''> = {};
    if (!siteId) unset.siteId = '';
    await equipments.updateOne({ _id: e._id }, { $set: { ...(siteId ? { siteId } : {}), ...(esp && ip ? { ip } : {}) }, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    if (esp && ip && e.ip && ip !== e.ip) {
      const moved = await probes.updateMany({ 'subject.kind': 'equipment', 'subject.id': e._id, 'target.type': 'ping', 'target.host': e.ip }, { $set: { 'target.host': ip } });
      if (moved.modifiedCount) publish('probe.config', {});
    }
    publish('equipment', { id: e._id.toHexString() });
    changed++;
  }
  return changed;
}

// After the sites of the brokers changed: every device listened to.
export async function syncAllEsphomeEquipments() {
  const sites = await brokerSites();
  for (const d of esphomeDevices()) await syncEsphomeEquipments(d, sites.get(d.brokerId));
}
