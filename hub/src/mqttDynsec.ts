import { agentRequest, isOnline, refreshAgent } from './agents.js';
import { hosts, roles } from './db.js';
import { testConnection } from './homeassistant/bridge.js';
import { tlsOf } from './mqttTls.js';
import { issueMqttCert, MQTT_CERT_DAYS } from './pki.js';
import { loadPki } from './pkiStore.js';
import { roleUrl } from './probes.js';
import { rolesSaved } from './roleEvents.js';
import { securityOf } from './mqttSecurity.js';
import type { HostDoc, MqttBrokerConfig, MqttBrokerRole } from './types.js';

// Dynamic-security on a Mosquitto broker, run by the agent of its host (agent/dynsec_enable.go): the hub only issues the
// certificates (its CA signs them), asks, checks that it reaches the broker in mutual TLS and then moves the role to
// the TLS listener. Without that check the agent is asked to undo everything.

export const DYNSEC_ACCOUNT = 'hlm';
export const DYNSEC_TLS_PORT = 8883;

// the report of the agent (agent/dynsec_check.go)
export interface DynsecReport {
  eligible: boolean;
  active: boolean;
  version?: string;
  unit?: string;
  confFile?: string;
  checks: { id: string; level: 'error' | 'warn' | 'info'; detail: string }[];
}

export class DynsecError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

async function carrier(role: MqttBrokerRole) {
  const host = await hosts.findOne({ _id: role.carrier.id });
  if (!host) throw new DynsecError('hôte porteur introuvable', 404);
  if (!host.capabilities?.includes('mqtt_dynsec')) throw new DynsecError("l'agent de cet hôte ne sait pas gérer dynamic-security (mise à jour requise)");
  const id = host._id.toHexString();
  if (!isOnline(id)) throw new DynsecError('agent hors ligne');
  return { host, id };
}

// The checks of the agent, the state, and what the hub knows of the activation (certificate end).
export async function securityView(role: MqttBrokerRole) {
  let host: HostDoc | null = null;
  let id = '';
  let error: string | null = null;
  try {
    ({ host, id } = await carrier(role));
  } catch (err) {
    if (!(err instanceof DynsecError)) throw err;
    error = err.message;
    host = await hosts.findOne({ _id: role.carrier.id });
  }
  let report: DynsecReport | null = null;
  if (!error) {
    try {
      report = await agentRequest<DynsecReport>(id, 'mqtt_dynsec_check', { port: role.config.port }, 20_000);
    } catch (err) {
      error = (err as Error).message;
    }
  }
  return {
    ...securityOf(role, host),
    report,
    error,
    enabledAt: role.config.dynsec?.enabledAt ?? null,
    clientNotAfter: role.config.dynsec?.clientNotAfter ?? null,
  };
}

const sansOf = (host: HostDoc, role: MqttBrokerRole) => [...new Set([...(role.config.address ? [role.config.address] : []), ...(host.info?.ips ?? [])])];

export async function enableDynsec(role: MqttBrokerRole) {
  const { host, id } = await carrier(role);
  const report = await agentRequest<DynsecReport>(id, 'mqtt_dynsec_check', { port: role.config.port }, 20_000);
  if (report.active) throw new DynsecError('dynamic-security est déjà actif sur ce broker');
  if (!report.eligible) throw new DynsecError(`activation impossible : ${report.checks.filter((c) => c.level === 'error').map((c) => c.detail).join(' ; ')}`);
  const sans = sansOf(host, role);
  if (!sans.length) throw new DynsecError("adresse de l'hôte inconnue : le certificat du broker n'aurait pas de nom");
  const pki = await loadPki();
  const server = await issueMqttCert(pki, 'server', 'mosquitto', sans);
  const client = await issueMqttCert(pki, 'client', DYNSEC_ACCOUNT);
  const plainPort = role.config.port;
  try {
    await agentRequest(id, 'mqtt_dynsec_enable', { dynsec: { port: plainPort, admin: DYNSEC_ACCOUNT, caPem: pki.caCert, serverCertPem: server.cert, serverKeyPem: server.key } }, 150_000);
  } catch (err) {
    throw new DynsecError(`activation échouée : ${(err as Error).message}`, 502);
  }
  const config: MqttBrokerConfig = {
    ...role.config,
    scheme: 'mqtts',
    port: DYNSEC_TLS_PORT,
    username: DYNSEC_ACCOUNT,
    password: '',
    caPem: pki.caCert,
    clientCertPem: client.cert,
    clientKeyPem: client.key,
    dynsec: { enabledAt: new Date(), plainPort, clientNotAfter: client.notAfter },
  };
  // the hub must reach the broker by its own certificate; if not, the agent undoes it all
  const url = roleUrl(config, host.info?.ips);
  try {
    await testConnection(url, '', '', tlsOf(config));
  } catch (err) {
    await agentRequest(id, 'mqtt_dynsec_disable', { dynsec: { port: DYNSEC_TLS_PORT } }, 150_000).catch(() => undefined);
    throw new DynsecError(`le hub ne se connecte pas au broker en TLS mutuel (${(err as Error).message}) : activation annulée`, 502);
  }
  await roles.replaceOne({ _id: role._id }, { ...role, config });
  // the agent lists its ports again (the new listener), so that the state follows
  await refreshAgent(id, ['info']).catch(() => undefined);
  await rolesSaved([host._id]);
  return { port: DYNSEC_TLS_PORT, notAfter: client.notAfter, validityDays: MQTT_CERT_DAYS };
}

export async function disableDynsec(role: MqttBrokerRole) {
  const { host, id } = await carrier(role);
  if (!role.config.dynsec) throw new DynsecError("dynamic-security n'a pas été activé par le hub sur ce rôle");
  try {
    await agentRequest(id, 'mqtt_dynsec_disable', { dynsec: { port: role.config.port } }, 150_000);
  } catch (err) {
    throw new DynsecError(`désactivation échouée : ${(err as Error).message}`, 502);
  }
  const config: MqttBrokerConfig = { ...role.config, scheme: 'mqtt', port: role.config.dynsec.plainPort, username: '', password: '' };
  delete config.caPem;
  delete config.clientCertPem;
  delete config.clientKeyPem;
  delete config.dynsec;
  await roles.replaceOne({ _id: role._id }, { ...role, config });
  await refreshAgent(id, ['info']).catch(() => undefined);
  await rolesSaved([host._id]);
}
