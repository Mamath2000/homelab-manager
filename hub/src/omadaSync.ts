import type { FastifyBaseLogger } from 'fastify';
import { ObjectId } from 'mongodb';
import { sameName } from './catalog.js';
import { equipments, omada, probes } from './db.js';
import { publish } from './events.js';
import { omadaSnapshot } from './omada.js';
import { INTERVAL_RANGE, TIMEOUT_RANGE } from './probes.js';
import { allRoles } from './roles.js';
import { syncVpnProbes } from './vpnProbes.js';
import type { AlertLevel, EquipmentDoc, EquipmentNative, ProbeDoc, OmadaControllerRole, OmadaDevice, OmadaStateDoc, OmadaVpn } from './types.js';

// Omada as a source of equipment (#231). A poll reads the sites and devices of each omada-controller role and keeps them
// in the collection `omada`. An Omada device becomes an equipment only when the admin says so (created, or linked to a
// manual one): the equipment is then (source omada, externalId = MAC of the device) and each poll rewrites what the
// source provides (type, site, address) and its native checks. A hub equipment has no MAC: a manual one is proposed for
// a device by its address, then by its name.

const omadaRoles = () => allRoles().filter((r): r is OmadaControllerRole => r.type === 'omada-controller');

// Load of a device: warn from 85 %, alert from 95 % (a small switch or AP sits at 50-70 % of memory when idle).
export const LOAD_WARN = 85;
export const LOAD_ALERT = 95;
const loadLevel = (pct: number): AlertLevel => (pct >= LOAD_ALERT ? 'alert' : pct >= LOAD_WARN ? 'warn' : 'ok');

// The site-to-site VPNs a gateway carries: the enabled ones of its site (a disabled tunnel is cut on purpose).
export const vpnsOf = (d: Pick<OmadaDevice, 'type' | 'siteId'>, vpns: OmadaVpn[] = []) => (d.type === 'gateway' ? vpns.filter((v) => v.siteId === d.siteId && v.enabled) : []);

// The native checks of a device: connected to the controller, processor and memory load when it reports them, and for a
// gateway each of its tunnels established (security associations in and out).
export function nativeOf(d: OmadaDevice, now = new Date(), vpns: OmadaVpn[] = []): EquipmentNative {
  const load = (key: string, label: string, pct?: number) => {
    if (pct === undefined) return [];
    const level = loadLevel(pct);
    return [{ key, label, level, ...(level !== 'ok' ? { reason: `${label} à ${pct} %` } : {}) }];
  };
  return {
    syncedAt: now,
    checks: [
      { key: 'connected', label: 'Connecté au contrôleur', level: d.connected ? 'ok' : 'alert', ...(d.connected ? {} : { reason: 'Déconnecté du contrôleur' }) },
      ...load('cpu', 'Processeur', d.cpu),
      ...load('memory', 'Mémoire', d.mem),
      ...vpnsOf(d, vpns).map((v) => ({ key: `vpn:${v.id}`, label: `Tunnel ${v.name}`, level: (v.established ? 'ok' : 'alert') as AlertLevel, ...(v.established ? {} : { reason: `Tunnel ${v.name} non établi` }) })),
    ],
  };
}

// The probes made with the equipment when it has an address: a ping, and the web interface of the device (HTTPS, self-signed
// certificate). One the equipment already has (a manual equipment linked) is not made twice.
export function autoProbes(equipmentId: ObjectId, ip: string | undefined, existing: Pick<ProbeDoc, 'target'>[]): ProbeDoc[] {
  if (!ip) return [];
  const base = { subject: { kind: 'equipment' as const, id: equipmentId }, runFrom: 'hub' as const, intervalSec: INTERVAL_RANGE.default, timeoutSec: TIMEOUT_RANGE.default, retries: 0 };
  const out: ProbeDoc[] = [];
  if (!existing.some((p) => p.target.type === 'ping')) out.push({ _id: new ObjectId(), ...base, name: 'Ping', target: { type: 'ping', host: ip }, createdAt: new Date() });
  if (!existing.some((p) => p.target.type === 'http')) out.push({ _id: new ObjectId(), ...base, name: 'Interface web', target: { type: 'http', url: `https://${ip}/`, insecure: true }, createdAt: new Date() });
  return out;
}

async function addProbes(e: EquipmentDoc) {
  const made = autoProbes(e._id, e.ip, await probes.find({ 'subject.kind': 'equipment', 'subject.id': e._id }).toArray());
  if (!made.length) return;
  await probes.insertMany(made);
  publish('probe.config', {});
}

// What the source provides of an equipment (SOURCE_FIELDS of equipments.ts, except the uplink the list does not give).
export function providedBy(d: OmadaDevice, siteMap: Record<string, string>) {
  const siteId = siteMap[d.siteId];
  return { type: d.type, ...(siteId ? { siteId } : {}), ...(d.ip ? { ip: d.ip } : {}) };
}

// The manual equipments that could be this device: same address first, else same name on the same site. Already linked
// equipments are never offered.
export function candidatesFor(d: OmadaDevice, list: Pick<EquipmentDoc, '_id' | 'name' | 'ip' | 'siteId' | 'source'>[], siteId?: string) {
  const free = list.filter((e) => e.source === 'manual');
  const byIp = d.ip ? free.filter((e) => e.ip === d.ip) : [];
  if (byIp.length) return byIp;
  return free.filter((e) => sameName(e.name, d.name) && (e.siteId ?? '') === (siteId ?? ''));
}

// Rewrites, for each device of the state that is an equipment, what its source provides and its native checks.
export async function syncEquipments(state: OmadaStateDoc) {
  const linked = await equipments.find({ source: 'omada', externalId: { $in: state.devices.map((d) => d.mac) } }).toArray();
  const now = new Date();
  for (const e of linked) {
    const d = state.devices.find((x) => x.mac === e.externalId)!;
    const p = providedBy(d, state.siteMap);
    const unset: Record<string, ''> = {};
    if (!p.siteId) unset.siteId = '';
    if (!p.ip) unset.ip = '';
    await equipments.updateOne({ _id: e._id }, { $set: { ...p, native: nativeOf(d, now, state.vpns) }, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    publish('equipment', { id: e._id.toHexString() });
  }
}

export async function pollRole(role: OmadaControllerRole) {
  const before = await omada.findOne({ _id: role._id });
  try {
    const snap = await omadaSnapshot(role.config);
    // VPNs not read this time: the last ones read are kept (a tunnel is only gone when a read says so)
    const vpns = snap.vpns ?? before?.vpns;
    const state: OmadaStateDoc = {
      _id: role._id,
      omadacId: snap.omadacId,
      sites: snap.sites,
      siteMap: before?.siteMap ?? {},
      devices: snap.devices,
      ...(vpns ? { vpns } : {}),
      ...(snap.vpnError ? { vpnError: snap.vpnError } : {}),
      polledAt: new Date(),
    };
    await omada.replaceOne({ _id: role._id }, state, { upsert: true });
    await syncEquipments(state);
    // only after a read of the VPNs: a failed one removes nothing
    if (snap.vpns) await syncVpnProbes(state);
  } catch (err) {
    await omada.updateOne({ _id: role._id }, { $set: { pollError: (err as Error).message, polledAt: new Date() }, $setOnInsert: { sites: [], siteMap: {}, devices: [] } }, { upsert: true });
  }
  publish('omada', {});
}

let running: Promise<void> | null = null;

// All the controllers, one after the other; a poll already running is the one waited for. The state of a role removed is dropped.
export function pollOmada(log?: FastifyBaseLogger) {
  running ??= (async () => {
    const roles = omadaRoles();
    await omada.deleteMany({ _id: { $nin: roles.map((r) => r._id) } });
    for (const r of roles) await pollRole(r).catch((err) => log?.error({ err, role: r._id }, 'Omada poll failed'));
  })().finally(() => {
    running = null;
  });
  return running;
}

export function startOmadaPoller(log: FastifyBaseLogger) {
  const run = () => pollOmada(log).catch((err) => log.error({ err }, 'Omada poll failed'));
  const first = setTimeout(run, 50_000);
  const timer = setInterval(run, 5 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export class OmadaLinkError extends Error {}

// Creates the equipment of a device, or links a manual equipment to it (it keeps its name, its probes and its uplink,
// and gets what the source provides). equipmentId absent: created, under name (the one of the device by default).
export async function linkDevice(roleId: string, mac: string, equipmentId?: ObjectId, name?: string): Promise<EquipmentDoc> {
  const state = await omada.findOne({ _id: roleId });
  const d = state?.devices.find((x) => x.mac === mac);
  if (!state || !d) throw new OmadaLinkError('appareil inconnu du contrôleur');
  if (await equipments.countDocuments({ source: 'omada', externalId: mac }, { limit: 1 })) throw new OmadaLinkError('cet appareil est déjà un équipement');
  const provided = providedBy(d, state.siteMap);
  if (equipmentId) {
    const cur = await equipments.findOne({ _id: equipmentId });
    if (!cur) throw new OmadaLinkError('équipement introuvable');
    if (cur.source !== 'manual') throw new OmadaLinkError('cet équipement a déjà une source');
    const unset: Record<string, ''> = {};
    if (!provided.siteId) unset.siteId = '';
    if (!provided.ip) unset.ip = '';
    const e = (await equipments.findOneAndUpdate(
      { _id: equipmentId },
      { $set: { ...provided, source: 'omada', externalId: mac, native: nativeOf(d, new Date(), state.vpns) }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { returnDocument: 'after' },
    ))!;
    await addProbes(e);
    if (d.type === 'gateway') await syncVpnProbes(state);
    publish('equipment', { id: e._id.toHexString() });
    return e;
  }
  const siteId = provided.siteId;
  const given = name?.trim() || d.name;
  const taken = await equipments.find({ siteId: siteId ?? { $exists: false } }, { projection: { name: 1 } }).toArray();
  if (taken.some((e) => sameName(e.name, given))) throw new OmadaLinkError(`un équipement s'appelle déjà « ${given} » sur ce site : le relier plutôt`);
  const doc: EquipmentDoc = { _id: new ObjectId(), name: given, ...provided, source: 'omada', externalId: mac, native: nativeOf(d, new Date(), state.vpns), createdAt: new Date() };
  await equipments.insertOne(doc);
  await addProbes(doc);
  if (d.type === 'gateway') await syncVpnProbes(state);
  publish('equipment', { id: doc._id.toHexString() });
  return doc;
}
