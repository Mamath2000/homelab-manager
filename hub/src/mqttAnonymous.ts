import { agentRequest } from './agents.js';
import { testConnection } from './homeassistant/bridge.js';
import { carrier, DynsecError, type DynsecReport } from './mqttDynsec.js';
import { getAnonymousAllowed, setAnonymousAllowed } from './mqttAccounts.js';
import { tlsOf } from './mqttTls.js';
import { roleUrl } from './probes.js';
import type { MqttBrokerRole } from './types.js';

// Whether a broker whose accounts the hub runs accepts clients without an account. Two things decide it: the configuration
// of the broker (allow_anonymous, changed by its agent with a restart: false refuses the connection, with a real
// "not authorised") and, when it accepts them, the rights of the anonymous group (the legacy role, changed on the fly).

export interface AnonymousState {
  // accepted and with rights: an anonymous client can work
  allowed: boolean;
  // the configuration lets them connect (null: the agent could not say)
  accepted: boolean | null;
  // the legacy role is on the anonymous group
  legacy: boolean;
  // the agent can change the configuration (online and able)
  configurable: boolean;
}

export async function anonymousState(role: MqttBrokerRole): Promise<AnonymousState> {
  const legacy = await getAnonymousAllowed(role);
  try {
    const { id } = await carrier(role);
    const report = await agentRequest<DynsecReport>(id, 'mqtt_dynsec_check', { port: role.config.port }, 20_000);
    const accepted = report.allowAnonymous ?? null;
    return { allowed: legacy && accepted !== false, accepted, legacy, configurable: report.allowAnonymous !== undefined };
  } catch {
    return { allowed: legacy, accepted: null, legacy, configurable: false };
  }
}

async function agentSet(id: string, role: MqttBrokerRole, allowed: boolean) {
  try {
    await agentRequest(id, 'mqtt_anonymous_set', { dynsec: { port: role.config.port }, allowed }, 120_000);
  } catch (err) {
    throw new DynsecError(`${allowed ? 'ouverture' : 'fermeture'} aux anonymes échouée : ${(err as Error).message}`, 502);
  }
}

export async function setAnonymous(role: MqttBrokerRole, allowed: boolean): Promise<AnonymousState> {
  const { host, id } = await carrier(role);
  // accepting them: the rights first (on the fly), then the connection (restart)
  if (allowed) await setAnonymousAllowed(role, true);
  await agentSet(id, role, allowed);
  // the hub must still reach the broker by its certificate; if not, the agent puts the former setting back
  try {
    await testConnection(roleUrl(role.config, host.info?.ips), '', '', tlsOf(role.config));
  } catch (err) {
    await agentSet(id, role, !allowed).catch(() => undefined);
    throw new DynsecError(`le hub ne se connecte plus au broker (${(err as Error).message}) : changement annulé`, 502);
  }
  return anonymousState(role);
}
