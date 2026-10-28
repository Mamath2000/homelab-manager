import mqtt, { type MqttClient } from 'mqtt';
import type { Measure } from './probeRunners.js';
import type { MqttBroker } from './types.js';

// One connection per broker, shared by all the probes that listen to it, and one subscription per topic:
// the memory used does not grow with the number of probes. The last message of each topic is kept.

export type BrokerState = 'connecting' | 'connected' | 'error';

interface Last {
  payload: string;
  at: number;
}

interface Conn {
  key: string; // what the connection was opened with: a change reopens it
  client: MqttClient;
  state: BrokerState;
  error: string | null;
  topics: Set<string>;
  last: Map<string, Last>;
  wake: Set<() => void>; // waiting for a change (connection, message)
}

const sleepUntil = (conn: Conn, ms: number) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      conn.wake.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    conn.wake.add(done);
  });

const keyOf = (b: MqttBroker) => `${b.url}|${b.username}|${b.password}`;

export class MqttPool {
  private conns = new Map<string, Conn>();

  // Brokers and topics wanted now: opens, reopens and closes connections and subscriptions to match.
  sync(brokers: MqttBroker[], wanted: Map<string, Set<string>>) {
    const byId = new Map(brokers.map((b) => [b.id, b]));
    for (const [id, conn] of this.conns) {
      const b = byId.get(id);
      if (!b || !wanted.has(id) || keyOf(b) !== conn.key) this.close(id);
    }
    for (const [id, topics] of wanted) {
      const b = byId.get(id);
      if (!b) continue;
      const conn = this.conns.get(id) ?? this.open(b);
      for (const t of conn.topics) {
        if (topics.has(t)) continue;
        conn.topics.delete(t);
        conn.last.delete(t);
        if (conn.state === 'connected') conn.client.unsubscribe(t);
      }
      for (const t of topics) {
        if (conn.topics.has(t)) continue;
        conn.topics.add(t);
        if (conn.state === 'connected') conn.client.subscribe(t);
      }
    }
  }

  private open(b: MqttBroker): Conn {
    const client = mqtt.connect(b.url, {
      username: b.username || undefined,
      password: b.password || undefined,
      clientId: `homelab-manager-probes-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
    });
    const conn: Conn = { key: keyOf(b), client, state: 'connecting', error: null, topics: new Set(), last: new Map(), wake: new Set() };
    const changed = () => [...conn.wake].forEach((w) => w());
    client.on('connect', () => {
      conn.state = 'connected';
      conn.error = null;
      if (conn.topics.size) client.subscribe([...conn.topics]);
      changed();
    });
    client.on('error', (err) => {
      conn.state = 'error';
      conn.error = err.message || 'connexion impossible';
      changed();
    });
    client.on('offline', () => {
      if (conn.state === 'connected') conn.state = 'connecting';
    });
    client.on('message', (topic, payload) => {
      conn.last.set(topic, { payload: payload.toString(), at: Date.now() });
      changed();
    });
    this.conns.set(b.id, conn);
    return conn;
  }

  private close(id: string) {
    const conn = this.conns.get(id);
    if (!conn) return;
    this.conns.delete(id);
    conn.client.end(true);
    conn.wake.forEach((w) => w());
  }

  status(id: string): { state: BrokerState; error: string | null } | null {
    const c = this.conns.get(id);
    return c ? { state: c.state, error: c.error } : null;
  }

  // contains: the last payload of the topic must contain it (a retained status stays valid as long as it
  // is not replaced); without it, a message must have arrived within the timeout.
  async check(brokerId: string, topic: string, contains: string | undefined, timeoutMs: number): Promise<Measure> {
    const conn = this.conns.get(brokerId);
    if (!conn || !conn.topics.has(topic)) return { state: 'unknown', message: 'broker non configuré' };
    const t0 = performance.now();
    const limit = t0 + timeoutMs;
    for (;;) {
      if (conn.state === 'connected') {
        const last = conn.last.get(topic);
        if (last && (contains ? true : Date.now() - last.at <= timeoutMs)) {
          const latencyMs = Math.max(1, Math.round(performance.now() - t0));
          if (!contains || last.payload.includes(contains)) return { state: 'up', latencyMs };
          return { state: 'down', message: `payload « ${last.payload.slice(0, 80)} » ne contient pas « ${contains} »` };
        }
      }
      const left = limit - performance.now();
      if (left <= 0) {
        if (conn.state !== 'connected') return { state: 'unknown', message: `broker injoignable${conn.error ? ` : ${conn.error}` : ''}` };
        return { state: 'down', message: `aucun message en ${Math.round(timeoutMs / 1000)} s` };
      }
      await sleepUntil(conn, left);
    }
  }

  closeAll() {
    for (const id of [...this.conns.keys()]) this.close(id);
  }
}
