import type { FastifyBaseLogger } from 'fastify';
import mqtt, { type MqttClient } from 'mqtt';
import { dynsecRun } from './dynsecClient.js';
import { DYNSEC_ACCOUNT } from './mqttDynsec.js';
import { tlsKey, tlsOptions } from './mqttTls.js';
import { loadMqttBrokers } from './probes.js';
import { allRoles } from './roles.js';

// The connections a broker refused (a client with an account it does not know, or a wrong password), read from the log
// the broker publishes on $SYS/broker/log/# (log_dest topic, set by the activation of dynamic-security). The log line has
// no user name, only the client id and the address: that is what the administrator sees, and creates the account from.
// In memory: it starts again empty when the hub restarts.

const TOPIC = '$SYS/broker/log/#';
const KEEP_MS = 7 * 24 * 3600 * 1000;
const MAX_PER_BROKER = 100;
const LINE_RE = /Client (\S+) \[([^\]]+?)(?::\d+)?\] disconnected: not authorised/;
const CONNECTED_RE = /New client connected from \S+ as (\S+) \(/;

export interface Refused {
  clientId: string;
  address: string;
  count: number;
  firstAt: number;
  lastAt: number;
  // an account was made for it from this list (the user name is the administrator's: the log has none), and when
  account?: string;
  accountAt?: number;
}

/** "Client esp-1 [192.168.1.5:5123] disconnected: not authorised." -> its client id and address; null for any other line. */
export function parseRefused(line: string) {
  const m = LINE_RE.exec(line);
  return m ? { clientId: m[1], address: m[2] } : null;
}

/** "New client connected from 10.0.0.5:1234 as esp-1 (p4, c1, k60)." -> its client id; null for any other line. */
export function parseConnected(line: string) {
  return CONNECTED_RE.exec(line)?.[1] ?? null;
}

const entries = new Map<string, Map<string, Refused>>();
const links = new Map<string, { key: string; client: MqttClient }>();

/** One line of the log: a refusal counts against its client id, a connection that passes clears it (the last message wins). */
export function noteLogLine(roleId: string, line: string, now = Date.now()) {
  const connected = parseConnected(line);
  if (connected) {
    entries.get(roleId)?.delete(connected);
    return;
  }
  const p = parseRefused(line);
  if (!p) return;
  let list = entries.get(roleId);
  if (!list) entries.set(roleId, (list = new Map()));
  const e = list.get(p.clientId);
  if (e) Object.assign(e, { address: p.address, count: e.count + 1, lastAt: now });
  else list.set(p.clientId, { ...p, count: 1, firstAt: now, lastAt: now });
  prune(list, now);
}

function prune(list: Map<string, Refused>, now: number) {
  for (const [id, e] of list) if (now - e.lastAt > KEEP_MS) list.delete(id);
  if (list.size > MAX_PER_BROKER) {
    const oldest = [...list.values()].sort((a, b) => a.lastAt - b.lastAt).slice(0, list.size - MAX_PER_BROKER);
    for (const e of oldest) list.delete(e.clientId);
  }
}

export function refusedOf(roleId: string, now = Date.now()): Refused[] {
  const list = entries.get(roleId);
  if (!list) return [];
  prune(list, now);
  return [...list.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** An account was made for this client: it stays listed until a connection passes (or is refused again, the password is wrong). */
export function markCreated(roleId: string, clientId: string, account: string, now = Date.now()) {
  const e = entries.get(roleId)?.get(clientId);
  if (e) Object.assign(e, { account, accountAt: now });
}

/** Opens a link to each broker whose dynamic-security the hub runs, closes the others; run again when the roles change. */
export async function reconcileRefusedWatch(log: FastifyBaseLogger) {
  const wanted = (await loadMqttBrokers()).brokers.filter((b) => b.url && allRoles().some((r) => r.type === 'mqtt-broker' && r._id === b.id && r.config.dynsec));
  for (const [id, l] of links) {
    if (!wanted.some((b) => b.id === id)) {
      l.client.end(true);
      links.delete(id);
      entries.delete(id);
    }
  }
  for (const b of wanted) {
    const key = `${b.url}|${tlsKey(b.tls)}`;
    const current = links.get(b.id);
    if (current?.key === key) continue;
    current?.client.end(true);
    const client = mqtt.connect(b.url, {
      ...tlsOptions(b.tls),
      clientId: `homelab-manager-refused-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 10_000,
      connectTimeout: 10_000,
    });
    client.on('connect', () => {
      // the account of the hub reads $SYS only with sys-observe (super-admin does not cover it): given again, harmless when it
      // has it, and it repairs a broker activated before the agent gave it
      const ready = dynsecRun(b, [{ command: 'addClientRole', username: DYNSEC_ACCOUNT, rolename: 'sys-observe', priority: 5 }]).catch(() => undefined);
      void ready.then(() => client.subscribe(TOPIC, { qos: 0 }, (err) => err && log.warn({ err: err.message, broker: b.name }, 'refused connections: subscription failed')));
    });
    client.on('error', (err) => log.debug({ err: err.message, broker: b.name }, 'refused connections: link error'));
    client.on('message', (_t, payload) => {
      for (const line of payload.toString().split('\n')) noteLogLine(b.id, line);
    });
    links.set(b.id, { key, client });
  }
}

export function stopRefusedWatch() {
  for (const l of links.values()) l.client.end(true);
  links.clear();
}
