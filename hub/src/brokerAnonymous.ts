import type { FastifyBaseLogger } from 'fastify';
import { testConnection } from './homeassistant/bridge.js';
import { loadMqttBrokers } from './probes.js';

// Whether each broker role also accepts connections without an account (F-03): anyone on the network can then publish,
// the commands of the Home Assistant bridge included. Checked by a connection without credentials, every 30 minutes
// and when a role changes. null: not checked yet (or no address).
const anonymous = new Map<string, boolean>();

export const brokerAnonymous = (id: string): boolean | null => anonymous.get(id) ?? null;

export async function checkBrokersAnonymous() {
  const { brokers } = await loadMqttBrokers();
  const ids = new Set(brokers.map((b) => b.id));
  for (const id of anonymous.keys()) if (!ids.has(id)) anonymous.delete(id);
  await Promise.all(
    brokers.map(async (b) => {
      if (!b.url) return;
      try {
        await testConnection(b.url, '', '', b.tls?.caPem ? { caPem: b.tls.caPem } : undefined);
        anonymous.set(b.id, true);
      } catch {
        anonymous.set(b.id, false);
      }
    }),
  );
}

export function startBrokerAnonymousCheck(log: FastifyBaseLogger) {
  const run = () => checkBrokersAnonymous().catch((err) => log.warn({ err }, 'MQTT: anonymous check failed'));
  run();
  const timer = setInterval(run, 30 * 60_000);
  timer.unref();
  return { run, stop: () => clearInterval(timer) };
}
