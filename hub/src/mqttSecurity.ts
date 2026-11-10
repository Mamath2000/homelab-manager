import type { HostDoc, MqttBrokerRole } from './types.js';

// What the agent reports of a Mosquitto broker, as the state of its management of accounts (dynamic-security, mqttDynsec.ts).

export type SecurityState = 'unavailable' | 'available' | 'active';
export interface Security {
  state: SecurityState;
  version?: string;
  // why it is unavailable
  reason?: string;
}

export const versionAtLeast = (v: string, major: number, minor: number) => {
  const [a, b] = v.split('.').map(Number);
  return Number.isInteger(a) && Number.isInteger(b) && (a > major || (a === major && b >= minor));
};

// What the agent reported of the broker (the candidate of its port): the management of the accounts is available from
// Mosquitto 2.1, active when the plugin is loaded in the process.
export function securityOf(role: Pick<MqttBrokerRole, 'config'>, host: Pick<HostDoc, 'roleCandidates'> | null): Security {
  const c = host?.roleCandidates?.find((x) => x.type === 'mqtt-broker' && x.port === role.config.port);
  if (!c) return { state: 'unavailable', reason: "broker non détecté par l'agent" };
  if (!c.process.startsWith('mosquitto')) return { state: 'unavailable', reason: 'seul Mosquitto est pris en charge' };
  if (!c.version) return { state: 'unavailable', reason: 'version de Mosquitto inconnue (agent à mettre à jour ?)' };
  if (c.dynsec) return { state: 'active', version: c.version };
  if (!versionAtLeast(c.version, 2, 1)) return { state: 'unavailable', version: c.version, reason: `Mosquitto ${c.version} : la version 2.1 ou plus est requise` };
  return { state: 'available', version: c.version };
}
