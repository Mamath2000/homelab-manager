import type { FastifyBaseLogger } from 'fastify';
import { testConnection } from './homeassistant/bridge.js';
import { anonymousState } from './mqttAnonymous.js';
import { loadMqttBrokers } from './probes.js';
import { allRoles } from './roles.js';

// Whether each broker role also accepts connections without an account (F-03): anyone on the network can then publish,
// the commands of the Home Assistant bridge included. Checked by a connection without credentials, every 30 minutes
// and when a role changes. null: not checked yet (or no address).
const anonymous = new Map<string, boolean>();

export const brokerAnonymous = (id: string): boolean | null => anonymous.get(id) ?? null;

// whether the configuration of a broker run by the hub lets anonymous clients connect (null: unknown, or not run by the hub)
const accepted = new Map<string, boolean | null>();
export const brokerAnonymousAccepted = (id: string): boolean | null => accepted.get(id) ?? null;

// records a state read live (the UI asks the broker itself): the cache must not stay behind what the person sees.
// accepted null = the agent could not answer (broker restarting...): the former value is kept.
export function recordAnonymous(id: string, st: { allowed: boolean; accepted: boolean | null }) {
  if (st.accepted === null && anonymous.has(id)) return;
  anonymous.set(id, st.allowed);
  accepted.set(id, st.accepted);
}

export async function checkBrokersAnonymous() {
  const { brokers } = await loadMqttBrokers();
  const ids = new Set(brokers.map((b) => b.id));
  for (const id of anonymous.keys()) if (!ids.has(id)) (anonymous.delete(id), accepted.delete(id));
  await Promise.all(
    brokers.map(async (b) => {
      if (!b.url) return;
      // the hub runs the accounts: its link is mutual TLS, a connection without credentials there tells nothing; the broker
      // says whether the anonymous group has rights
      const role = allRoles().find((r) => r.type === 'mqtt-broker' && r._id === b.id);
      if (role?.type === 'mqtt-broker' && role.config.dynsec) {
        await anonymousState(role).then((st) => recordAnonymous(b.id, st), () => undefined);
        return;
      }
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
