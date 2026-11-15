import type { FastifyBaseLogger } from 'fastify';
import { esphome, hosts } from './db.js';
import { publish, subscribe } from './events.js';
import type { MqttPool, Wanted } from './mqttPool.js';
import { LogShipper, parseLine, recordOf } from './esphomeLogs.js';
import { probeEngine } from './probes.js';
import { allRoles, esphomeRole } from './roles.js';
import type { EsphomeDeviceDoc, EsphomeInfo, EsphomeSubDevice, MqttBrokerRole } from './types.js';

// ESPHome (homelab#352): the devices seen on the brokers the esphome role listens to. Each device publishes, under
// esphome/<unique_id>/ (the unique_id substitution of its YAML, in lower case):
//   LWT        online / offline, retained (birth, will and shutdown messages)
//   info       JSON retained, published on each connection: name, ip, mac, version and its sub-devices (devices:)
//   log_level  the level of its logger, retained (changed through log_level/set, never retained)
//   logs       the lines of its logger (mqtt.log_topic): forwarded to the log server once its logs are on (esphomeLogs.ts)
// A device is keyed <broker>/<unique_id>: two brokers may show the same one (a bridge). It is kept when it is no longer
// seen; its site is the one of its broker (the host of the broker, or the site set for it in the role).

export const ESPHOME_TOPICS = ['LWT', 'info', 'log_level'] as const;
type Kind = (typeof ESPHOME_TOPICS)[number];

export const deviceKey = (brokerId: string, uniqueId: string) => `${brokerId}/${uniqueId}`;

// esphome/<id>/<kind> -> its parts (null: not a topic of a device)
export function parseTopic(topic: string): { uniqueId: string; kind: Kind | 'logs' } | null {
  const m = /^esphome\/([^/]+)\/(LWT|info|log_level|logs)$/.exec(topic);
  return m ? { uniqueId: m[1], kind: m[2] as Kind | 'logs' } : null;
}

const str = (v: unknown, max = 128) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

// The info payload of a device: the fields known, of the expected types; the others are ignored (the JSON is meant to grow).
export function parseInfo(payload: string): { info: EsphomeInfo } | { error: string } {
  let o: unknown;
  try {
    o = JSON.parse(payload);
  } catch {
    return { error: 'info : JSON invalide' };
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'info : objet JSON attendu' };
  const r = o as Record<string, unknown>;
  const info: EsphomeInfo = {};
  for (const k of ['name', 'ip', 'mac', 'version'] as const) {
    const v = str(r[k]);
    if (v) info[k] = v;
  }
  if (r.devices !== undefined) {
    if (!Array.isArray(r.devices)) return { error: 'info : devices doit être une liste' };
    const devices: EsphomeSubDevice[] = [];
    for (const d of r.devices.slice(0, 64)) {
      const id = str((d as Record<string, unknown> | null)?.id, 64);
      if (!id || devices.some((x) => x.id === id)) continue;
      const x = d as Record<string, unknown>;
      const name = str(x.name);
      const tags = Array.isArray(x.tags) ? [...new Set(x.tags.map((t) => str(t, 64)).filter((t): t is string => !!t))].slice(0, 32) : [];
      devices.push({ id, ...(name ? { name } : {}), ...(tags.length ? { tags } : {}) });
    }
    info.devices = devices;
  }
  return { info };
}

// What a message changes on a device (null: nothing to record).
export function applyMessage(doc: EsphomeDeviceDoc | undefined, brokerId: string, uniqueId: string, kind: Kind, payload: string, now: Date): EsphomeDeviceDoc | null {
  const base: EsphomeDeviceDoc = doc ?? { _id: deviceKey(brokerId, uniqueId), brokerId, uniqueId, lwt: null, firstSeenAt: now, lastSeenAt: now };
  const text = payload.trim();
  switch (kind) {
    case 'LWT': {
      // an empty retained message clears the LWT: the device is no longer announced
      const lwt = text === 'online' ? 'online' : text === 'offline' ? 'offline' : null;
      if (doc && doc.lwt === lwt) return null;
      if (!doc && !lwt) return null;
      return { ...base, lwt, lwtAt: now, lastSeenAt: now };
    }
    case 'info': {
      if (!text) return null;
      const r = parseInfo(text);
      if ('error' in r) {
        if (doc?.infoError === r.error) return null;
        return { ...base, infoError: r.error, infoAt: now, lastSeenAt: now };
      }
      if (doc && !doc.infoError && JSON.stringify(doc.info ?? {}) === JSON.stringify(r.info)) return null;
      const { infoError: _drop, ...rest } = base;
      return { ...rest, info: r.info, infoAt: now, lastSeenAt: now };
    }
    case 'log_level': {
      const level = text.toUpperCase().slice(0, 16);
      if (!level || doc?.level === level) return null;
      return { ...base, level, levelAt: now, lastSeenAt: now };
    }
  }
}

// --- state ----------------------------------------------------------------------------------------------------------

const devices = new Map<string, EsphomeDeviceDoc>();
const listened = () => new Set(esphomeRole()?.config.brokers.map((b) => b.brokerId) ?? []);
export const esphomeDevice = (key: string) => devices.get(key) ?? null;
// the site of the devices of each broker, as brokerSites last gave it (the lines carry it)
let sites = new Map<string, string | null>();
// the last line received from each device whose logs are on (time, ms)
const lastLines = new Map<string, number>();
export const lastLineOf = (key: string) => lastLines.get(key) ?? null;
// what the engine runs again when the subscriptions must change (the logs of a device turned on or off)
let resync: (() => void) | null = null;
// the lines on their way to the log server (null: the engine is not running)
let shipper: LogShipper | null = null;
export const esphomeShipper = () => shipper;

// The devices of the brokers listened to, by name.
export function esphomeDevices(brokerId?: string) {
  const ids = listened();
  return [...devices.values()].filter((d) => ids.has(d.brokerId) && (!brokerId || d.brokerId === brokerId)).sort((a, b) => (a.info?.name ?? a.uniqueId).localeCompare(b.info?.name ?? b.uniqueId));
}
export const esphomeCount = () => esphomeDevices().length;

// The site of the devices of a broker: the one set in the role, else the one of the host of the broker.
export async function brokerSites(): Promise<Map<string, string | null>> {
  const role = esphomeRole();
  const brokers = allRoles().filter((r): r is MqttBrokerRole => r.type === 'mqtt-broker');
  const carriers = await hosts.find({ _id: { $in: brokers.map((b) => b.carrier.id) } }, { projection: { siteId: 1 } }).toArray();
  const siteOf = new Map(carriers.map((h) => [h._id.toHexString(), h.siteId ?? null]));
  return new Map(brokers.map((b) => [b._id, role?.config.brokers.find((x) => x.brokerId === b._id)?.siteId ?? siteOf.get(b.carrier.id.toHexString()) ?? null]));
}

// Forgets the devices of the brokers no longer listened to (a broker removed from the role, the role removed).
export async function forgetDevices(keep: Set<string>) {
  for (const [k, d] of devices) if (!keep.has(d.brokerId)) devices.delete(k);
  await esphome.deleteMany({ brokerId: { $nin: [...keep] } });
}

// the topics the role wants, by broker; the lines only on the brokers with a device whose logs are on
export function wantedTopics(brokerIds: Iterable<string>, withLogs: Set<string> = new Set()): Wanted {
  return new Map([...brokerIds].map((id) => [id, new Set([...ESPHOME_TOPICS.map((k) => `esphome/+/${k}`), ...(withLogs.has(id) ? ['esphome/+/logs'] : [])])]));
}

// Turns the logs of a device on or off (the lines it sends are forwarded or dropped).
export async function setDeviceLogs(key: string, on: boolean) {
  const d = devices.get(key);
  if (!d) return null;
  const next = { ...d, logs: on };
  devices.set(key, next);
  if (!on) lastLines.delete(key);
  await esphome.updateOne({ _id: key }, on ? { $set: { logs: true } } : { $unset: { logs: '' } });
  resync?.();
  publish('esphome', {});
  return next;
}

// --- engine ---------------------------------------------------------------------------------------------------------

// the UI is told at most once a second (a broker sends all its retained messages at once on connection)
const NOTIFY_MS = 1000;

// onInfo: a device told another info (its address may have changed): what its equipments get from it follows
export function startEsphome(log: FastifyBaseLogger, onInfo?: (d: EsphomeDeviceDoc) => Promise<unknown>) {
  let pool: MqttPool | null = null;
  let unlisten: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  const notify = () => {
    timer ??= setTimeout(() => {
      timer = null;
      publish('esphome', {});
    }, NOTIFY_MS);
  };

  const ship = new LogShipper(() => esphomeRole()?.config.logServer, log);
  shipper = ship;

  const onMessage = (brokerId: string, topic: string, payload: Buffer) => {
    if (!listened().has(brokerId)) return;
    const t = parseTopic(topic);
    if (!t) return;
    const key = deviceKey(brokerId, t.uniqueId);
    if (t.kind === 'logs') {
      const d = devices.get(key);
      if (!d?.logs) return;
      const at = new Date();
      lastLines.set(key, at.getTime());
      ship.push(recordOf(d, parseLine(payload.toString()), sites.get(brokerId), at));
      return;
    }
    const next = applyMessage(devices.get(key), brokerId, t.uniqueId, t.kind, payload.toString(), new Date());
    if (!next) return;
    devices.set(key, next);
    // the fields of the message only: the logs switch is written by setDeviceLogs alone
    const { _id, logs: _logs, ...fields } = next;
    esphome
      .updateOne({ _id }, { $set: fields, ...(next.infoError ? {} : { $unset: { infoError: '' } }) }, { upsert: true })
      .catch((err) => log.warn({ err, device: key }, 'esphome: device not saved'));
    if (t.kind === 'info' && next.info) onInfo?.(next).catch((err) => log.warn({ err, device: key }, 'esphome: equipments not updated'));
    notify();
  };

  // the subscriptions follow the role (and the engine of the probes, which owns the connections)
  const sync = () => {
    const engine = probeEngine();
    if (engine?.pool !== pool) {
      unlisten?.();
      pool = engine?.pool ?? null;
      unlisten = pool?.listen(onMessage) ?? null;
    }
    const ids = listened();
    const withLogs = new Set([...devices.values()].filter((d) => d.logs && ids.has(d.brokerId)).map((d) => d.brokerId));
    pool?.want('esphome', wantedTopics(ids, withLogs));
    brokerSites()
      .then((m) => (sites = m))
      .catch((err) => log.warn({ err }, 'esphome: sites of the brokers not read'));
  };
  resync = sync;

  const ready = esphome
    .find()
    .toArray()
    .then((list) => {
      for (const d of list) devices.set(d._id, d);
      sync();
    })
    .catch((err) => log.error({ err }, 'esphome: devices not loaded'));

  const unsubscribe = subscribe((event) => {
    if (event === 'probe.config') void ready.then(sync);
  });
  return async () => {
    unsubscribe();
    unlisten?.();
    pool?.want('esphome', new Map());
    if (timer) clearTimeout(timer);
    resync = null;
    // what is waiting is written before the hub stops
    await ship.flush().catch(() => undefined);
    ship.stop();
    shipper = null;
  };
}
