import type { FastifyBaseLogger } from 'fastify';
import type { ObjectId } from 'mongodb';
import { dayKey, ALERT_DAYS } from './alerts.js';
import { hosts, probeDays, probes } from './db.js';
import { lanAddress } from './hostAddress.js';
import { publish, subscribe } from './events.js';
import { MqttPool } from './mqttPool.js';
import { measureLocal, PING_HOST_RE, type Measure } from './probeRunners.js';
import type { HostRole, MqttBroker, ProbeDoc, ProbeState, ProbeTarget } from './types.js';

// Probes: checks that the service is rendered, seen from outside, on top of what the agents report from inside.
// The hub runs them (mqtt, ping, tcp, http) and only keeps the current state of each: no series of measures.
// Each measure is counted by state and day (probeDays: the small history of the Probes page).
// The transitions reach the alert history through the 'probe' event (see alerts.ts).

export const BROKER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const INTERVAL_RANGE = { min: 10, max: 3600, default: 60 } as const;
export const TIMEOUT_RANGE = { min: 1, max: 60, default: 10 } as const;
export const MAX_RETRIES = 3;

// Address a broker role is reached at: the one typed, else the first private IP of its host ('' when unknown).
export function roleUrl(role: Pick<HostRole, 'scheme' | 'port' | 'address'>, ips: string[] | null | undefined) {
  const addr = role.address || lanAddress(ips);
  return addr ? `${role.scheme}://${addr.includes(':') && !addr.startsWith('[') ? `[${addr}]` : addr}:${role.port}` : '';
}

// The MQTT brokers the probes listen to: the mqtt-broker roles of the hosts.
export async function loadMqttBrokers(): Promise<{ brokers: MqttBroker[] }> {
  const list = await hosts.find({ 'roles.type': 'mqtt-broker' }, { projection: { roles: 1, 'info.ips': 1 } }).toArray();
  const brokers: MqttBroker[] = [];
  for (const h of list) {
    for (const r of h.roles ?? []) {
      if (r.type === 'mqtt-broker') brokers.push({ id: r.id, name: r.name, url: roleUrl(r, h.info?.ips), username: r.username, password: r.password, hostId: h._id });
    }
  }
  return { brokers };
}

// --- validation (the routes use it) --------------------------------------------------------------

const hostOk = (h: unknown) => typeof h === 'string' && PING_HOST_RE.test(h);

// null: valid, else why not
export function targetError(t: ProbeTarget): string | null {
  switch (t.type) {
    case 'mqtt':
      if (typeof t.brokerId !== 'string' || !BROKER_ID_RE.test(t.brokerId)) return 'broker invalide';
      if (typeof t.topic !== 'string' || !t.topic || t.topic.length > 256 || /[+#\0]/.test(t.topic)) return 'topic invalide (pas de joker + ni #)';
      if (t.contains !== undefined && t.contains.length > 256) return 'valeur attendue trop longue';
      return null;
    case 'ping':
      return hostOk(t.host) ? null : 'adresse invalide';
    case 'tcp':
      if (!hostOk(t.host)) return 'adresse invalide';
      return Number.isInteger(t.port) && t.port >= 1 && t.port <= 65535 ? null : 'port invalide';
    case 'http':
      try {
        const u = new URL(String(t.url));
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'URL http ou https attendue';
      } catch {
        return 'URL invalide';
      }
      if (t.status !== undefined && !(Number.isInteger(t.status) && t.status >= 100 && t.status <= 599)) return 'code de statut invalide';
      if (t.keyword !== undefined && t.keyword.length > 256) return 'mot-clé trop long';
      return null;
  }
}

// --- state --------------------------------------------------------------------------------------

export interface Running {
  state?: ProbeState;
  message?: string | null;
  failures: number; // failed measures in a row
}

// A failed measure only turns the probe down after `retries` more failures; until then it keeps its state
// (unknown when it has none yet). unknown (measure impossible) and up apply at once.
export function nextState(prev: Running, m: Measure, retries: number): Running {
  if (m.state !== 'down') return { state: m.state, message: m.state === 'up' ? null : (m.message ?? null), failures: 0 };
  const failures = prev.failures + 1;
  if (failures <= retries) return { state: prev.state ?? 'unknown', message: prev.message ?? null, failures };
  return { state: 'down', message: m.message ?? null, failures };
}

// What the page of a host shows besides the stored state
export interface Live {
  checkedAt: number;
  latencyMs: number | null;
}

// --- engine -------------------------------------------------------------------------------------

const TICK_MS = 5000;
const RELOAD_MS = 30_000;
const MAX_PARALLEL = 8;

export class ProbeEngine {
  readonly pool = new MqttPool();
  private list: ProbeDoc[] = [];
  private running = new Map<string, Running>();
  private nextAt = new Map<string, number>();
  private inflight = new Set<string>();
  private live = new Map<string, Live>();
  private loadedAt = 0;
  private dirty = true;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private log: FastifyBaseLogger) {}

  start() {
    // the routes publish probe.config when a probe or a broker changes
    this.unsubscribe = subscribe((event) => {
      if (event === 'probe.config') this.dirty = true;
    });
    this.timer = setInterval(() => this.tick().catch((err) => this.log.warn({ err }, 'probe tick failed')), TICK_MS);
    this.tick().catch((err) => this.log.warn({ err }, 'probe tick failed'));
  }

  stop() {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe = this.timer = null;
    this.pool.closeAll();
  }

  liveOf(id: string): Live | null {
    return this.live.get(id) ?? null;
  }

  private async reload() {
    this.list = await probes.find({}).toArray();
    const brokers = (await loadMqttBrokers()).brokers;
    const wanted = new Map<string, Set<string>>();
    const ids = new Set<string>();
    for (const p of this.list) {
      ids.add(p._id.toHexString());
      if (p.target.type !== 'mqtt') continue;
      const set = wanted.get(p.target.brokerId) ?? new Set<string>();
      set.add(p.target.topic);
      wanted.set(p.target.brokerId, set);
    }
    // a broker whose host has no address yet is not connected: its probes are unknown
    this.pool.sync(brokers.filter((b) => b.url), wanted);
    for (const m of [this.running, this.nextAt, this.live]) for (const id of m.keys()) if (!ids.has(id)) m.delete(id);
    this.loadedAt = Date.now();
    this.dirty = false;
  }

  private async tick() {
    if (this.dirty || Date.now() - this.loadedAt > RELOAD_MS) await this.reload();
    const now = Date.now();
    for (const p of this.list) {
      const id = p._id.toHexString();
      if (this.inflight.size >= MAX_PARALLEL) break;
      if (this.inflight.has(id) || (this.nextAt.get(id) ?? 0) > now) continue;
      this.nextAt.set(id, now + p.intervalSec * 1000);
      this.inflight.add(id);
      this.run(p).catch((err) => this.log.warn({ err, probe: p.name }, 'probe failed')).finally(() => this.inflight.delete(id));
    }
  }

  private async run(p: ProbeDoc) {
    const id = p._id.toHexString();
    const m = await measure(p, this.pool);
    // the probe may have been removed during the measure
    if (!this.list.some((x) => x._id.equals(p._id))) return;
    const prev = this.running.get(id) ?? { state: p.state, message: p.message ?? null, failures: 0 };
    const next = nextState(prev, m, p.retries);
    this.running.set(id, next);
    this.live.set(id, { checkedAt: Date.now(), latencyMs: m.latencyMs ?? null });
    await countMeasure(p._id, next.state ?? 'unknown');
    if (next.state === p.state && (next.message ?? null) === (p.message ?? null)) return;
    const changed = next.state !== p.state;
    const since = changed ? new Date() : p.since;
    p.state = next.state;
    p.message = next.message;
    p.since = since;
    await probes.updateOne({ _id: p._id }, { $set: { state: next.state, message: next.message, ...(since ? { since } : {}) } });
    if (changed) publish('probe', { id, subject: { kind: p.subject.kind, id: p.subject.id.toHexString() }, state: next.state, message: next.message });
  }
}

// One more measure in the day of the probe, in the state it ended up in (retries included).
async function countMeasure(probeId: ObjectId, state: ProbeState) {
  const now = new Date();
  await probeDays
    .updateOne(
      { probeId, day: dayKey(now) },
      { $inc: { [state]: 1 }, $setOnInsert: { expiresAt: new Date(now.getTime() + (ALERT_DAYS + 10) * 24 * 3600 * 1000) } },
      { upsert: true },
    )
    .catch(() => undefined);
}

export function measure(p: Pick<ProbeDoc, 'target' | 'timeoutSec'>, pool: MqttPool): Promise<Measure> {
  const timeoutMs = p.timeoutSec * 1000;
  const t = p.target;
  return t.type === 'mqtt' ? pool.check(t.brokerId, t.topic, t.contains || undefined, timeoutMs) : measureLocal(t, timeoutMs);
}

let running: ProbeEngine | null = null;

export function startProbes(log: FastifyBaseLogger) {
  const engine = new ProbeEngine(log);
  running = engine;
  engine.start();
  return () => {
    engine.stop();
    running = null;
  };
}

// The engine of the hub, for what the routes show of it (live measures, connection of the brokers)
export const probeEngine = () => running;

// One measure of a probe that is not saved (the test of the forms). A topic of a broker is listened to on a
// connection of its own, closed after the measure.
export async function testTarget(target: ProbeTarget, timeoutSec: number): Promise<Measure> {
  if (target.type !== 'mqtt') return measure({ target, timeoutSec }, new MqttPool());
  const broker = (await loadMqttBrokers()).brokers.find((b) => b.id === target.brokerId);
  if (!broker) return { state: 'unknown', message: 'broker introuvable' };
  if (!broker.url) return { state: 'unknown', message: "adresse de l'hôte du broker inconnue" };
  const pool = new MqttPool();
  pool.sync([broker], new Map([[broker.id, new Set([target.topic])]]));
  try {
    return await measure({ target, timeoutSec }, pool);
  } finally {
    pool.closeAll();
  }
}

// A stack that is gone from the report of its host takes its probes with it: they would only ever be down.
// The user is told (event probe.removed). Returns what was removed.
export async function removeStackProbes(hostId: ObjectId, stacks: string[]) {
  const gone = await probes.find({ 'subject.kind': 'host', 'subject.id': hostId, 'subject.stack': { $exists: true, $nin: stacks } }).toArray();
  if (!gone.length) return [];
  await probes.deleteMany({ _id: { $in: gone.map((p) => p._id) } });
  const host = await hosts.findOne({ _id: hostId }, { projection: { name: 1 } });
  publish('probe.config', {});
  publish('probe.removed', { hostId: hostId.toHexString(), host: host?.name ?? '', probes: gone.map((p) => ({ name: p.name, stack: p.subject.stack })) });
  return gone;
}

// Probes attached to hosts, for the status of the hosts (monitoring.ts)
export const hostProbes = () => probes.find({ 'subject.kind': 'host' }).toArray();

// Probes attached to equipment, for their status (monitoring.ts)
export const equipmentProbes = () => probes.find({ 'subject.kind': 'equipment' }).toArray();

// Probes of a subject (host page, status of the host), without their live details
export async function probesOf(kind: ProbeDoc['subject']['kind'], id: ObjectId) {
  return probes.find({ 'subject.kind': kind, 'subject.id': id }).sort({ name: 1 }).toArray();
}

export type { MqttBroker };
