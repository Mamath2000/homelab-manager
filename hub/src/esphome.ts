import type { FastifyBaseLogger } from 'fastify';
import { equipments, esphome, hosts } from './db.js';
import { publish, subscribe } from './events.js';
import type { MqttPool, Wanted } from './mqttPool.js';
import { LogShipper, parseLine, recordOf } from './esphomeLogs.js';
import { probeEngine } from './probes.js';
import { allRoles, esphomeRole } from './roles.js';
import type { EquipmentNative, EsphomeDeviceDoc, EsphomeInfo, EsphomeSubDevice, MqttBrokerRole } from './types.js';

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

// The levels of the logger, as the select of the package names them (log_level/set). A device offers only the ones up to
// the level it was compiled with; it boots at its initial one, DEFAULT_LEVEL (initial_level: INFO in the package).
export const LOG_LEVELS = ['NONE', 'ERROR', 'WARN', 'INFO', 'CONFIG', 'DEBUG', 'VERBOSE', 'VERY_VERBOSE'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const DEFAULT_LEVEL: LogLevel = 'INFO';
// an ESP whose logs are on is mute after this long without a line (the package sends a heartbeat every hour)
export const ESPHOME_SILENT_HOURS = 2;

// The native checks of the equipment of an ESP: its lines received (homelab#352). null: no native check, so no connection
// domain: logs off, not watched (silentHours 0), or the ESP offline (its LWT probe says it). since: when a line could be
// expected from (logs turned on, or the hub started), the grace before the first one.
export function muteNative(d: Pick<EsphomeDeviceDoc, 'logs' | 'lwt'>, lastLineAt: number | null, since: number, silentHours: number, now = Date.now()): EquipmentNative | null {
  if (!d.logs || d.lwt !== 'online' || !silentHours) return null;
  const syncedAt = new Date(now);
  const limit = silentHours * 3600_000;
  const label = 'Logs reçus';
  if (lastLineAt && now - lastLineAt < limit) return { syncedAt, checks: [{ key: 'logs', label, level: 'ok' }] };
  if (!lastLineAt && now - since < limit) return { syncedAt, checks: [{ key: 'logs', label, level: 'ok' }] };
  const reason = lastLineAt ? `Muet : aucune ligne de log depuis ${Math.floor((now - lastLineAt) / 3600_000)} h` : `Muet : aucune ligne de log reçue`;
  return { syncedAt, checks: [{ key: 'logs', label, level: 'warn', reason }] };
}

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
export const lastLineOf = (key: string) => lastLines.get(key) ?? devices.get(key)?.lastLineAt?.getTime() ?? null;
// the connections the engine listens on (null: not running)
let currentPool: MqttPool | null = null;
// when a line can be expected of a device at the earliest: its logs turned on, or the hub started
const startedAt = Date.now();
// the engine checks the mute devices again (a device turned on or off)
let recheck: (() => void) | null = null;

// The mute check of a device now, as the engine writes it on its equipment.
export const deviceMute = (d: EsphomeDeviceDoc, now = Date.now()) =>
  muteNative(d, lastLineOf(d._id), Math.max(startedAt, d.logsAt?.getTime() ?? 0), esphomeRole()?.config.silentHours ?? ESPHOME_SILENT_HOURS, now);
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
  const { lastLineAt: _last, logsAt: _at, ...rest } = d;
  const next: EsphomeDeviceDoc = on ? { ...rest, logs: true, logsAt: new Date() } : { ...rest, logs: false };
  devices.set(key, next);
  lastLines.delete(key);
  await esphome.updateOne({ _id: key }, on ? { $set: { logs: true, logsAt: next.logsAt! }, $unset: { lastLineAt: '' } } : { $unset: { logs: '', logsAt: '', lastLineAt: '' } });
  resync?.();
  recheck?.();
  publish('esphome', {});
  return next;
}

// Asks a device for another level of its logger (esphome/<id>/log_level/set, never retained: it boots at its initial
// level again). false: its broker is not connected. The device answers on log_level.
export async function setDeviceLevel(key: string, level: LogLevel) {
  const d = devices.get(key);
  if (!d || !currentPool) return false;
  return currentPool.publish(d.brokerId, `esphome/${d.uniqueId}/log_level/set`, level, false);
}

// --- engine ---------------------------------------------------------------------------------------------------------

// the UI is told at most once a second (a broker sends all its retained messages at once on connection)
const NOTIFY_MS = 1000;
// the mute check, and the last lines saved
const SILENCE_MS = 5 * 60_000;

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
      currentPool = pool;
    }
    const ids = listened();
    const withLogs = new Set([...devices.values()].filter((d) => d.logs && ids.has(d.brokerId)).map((d) => d.brokerId));
    pool?.want('esphome', wantedTopics(ids, withLogs));
    brokerSites()
      .then((m) => (sites = m))
      .catch((err) => log.warn({ err }, 'esphome: sites of the brokers not read'));
  };
  resync = sync;

  // The mute check of the equipments of the ESP whose logs are on, every few minutes (and the last lines saved).
  const silence = async () => {
    const ids = listened();
    const list = [...devices.values()].filter((d) => ids.has(d.brokerId));
    const boxes = await equipments.find({ source: 'esphome', externalId: { $in: list.map((d) => d._id) } }, { projection: { externalId: 1, native: 1 } }).toArray();
    const now = Date.now();
    for (const e of boxes) {
      const d = devices.get(e.externalId!)!;
      const native = deviceMute(d, now);
      const before = JSON.stringify(e.native?.checks ?? null);
      await equipments.updateOne({ _id: e._id }, native ? { $set: { native } } : { $unset: { native: '' } });
      if (before !== JSON.stringify(native?.checks ?? null)) publish('equipment', { id: e._id.toHexString() });
    }
    for (const [key, at] of lastLines) {
      const d = devices.get(key);
      if (!d || (d.lastLineAt && d.lastLineAt.getTime() >= at)) continue;
      devices.set(key, { ...d, lastLineAt: new Date(at) });
      await esphome.updateOne({ _id: key }, { $set: { lastLineAt: new Date(at) } });
    }
  };
  const runSilence = () => void silence().catch((err) => log.warn({ err }, 'esphome: mute check failed'));
  recheck = runSilence;
  const silenceTimer = setInterval(runSilence, SILENCE_MS);
  const firstSilence = setTimeout(runSilence, 30_000);

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
    clearInterval(silenceTimer);
    clearTimeout(firstSilence);
    resync = recheck = null;
    currentPool = null;
    await silence().catch(() => undefined);
    // what is waiting is written before the hub stops
    await ship.flush().catch(() => undefined);
    ship.stop();
    shipper = null;
  };
}
