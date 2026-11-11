import type { FastifyBaseLogger } from 'fastify';
import { agentRequest, isOnline, refreshAgent } from './agents.js';
import { hosts, roles } from './db.js';
import { testConnection } from './homeassistant/bridge.js';
import { tlsOf } from './mqttTls.js';
import { issueMqttCert, MQTT_CERT_DAYS } from './pki.js';
import { loadPki } from './pkiStore.js';
import { allRoles } from './roles.js';
import { openRole, resealSoon } from './storedSecrets.js';
import { roleUrl } from './probes.js';
import { rolesSaved } from './roleEvents.js';
import { securityOf } from './mqttSecurity.js';
import { clearRefused } from './refusedLog.js';
import type { HostDoc, MqttBroker, MqttBrokerRole } from './types.js';

// Dynamic-security on a Mosquitto broker, run by the agent of its host (agent/dynsec_enable.go): the hub only issues the
// certificates (its CA signs them), asks and checks that it reaches the broker in mutual TLS. Without that check the
// agent is asked to undo everything. The hub administers the broker with its own identity (config.dynsec, TLS listener);
// the enabling never touches the connection of the role (probes, Home Assistant bridge): it stays what the administrator
// typed. The way back is a reset: nothing is kept, on the host or in the hub.

export const DYNSEC_ACCOUNT = 'hlm';
export const DYNSEC_TLS_PORT = 8883;

// the report of the agent (agent/dynsec_check.go)
export interface DynsecReport {
  eligible: boolean;
  active: boolean;
  // the broker accepts a connection without account (allow_anonymous true in its configuration)
  allowAnonymous?: boolean;
  // the same without the file added by the enabling: what the broker accepts once reset (absent: agent too old)
  originAnonymous?: boolean;
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

export async function carrier(role: MqttBrokerRole) {
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

// How the hub administers the broker: the TLS listener of the agent, with the certificate of the account `hlm` (never a
// password). null: dynamic-security is not run by the hub, or the address of the host is unknown.
export function adminBroker(role: MqttBrokerRole, ips: string[] | null | undefined): Pick<MqttBroker, 'url' | 'tls'> | null {
  const d = role.config.dynsec;
  if (!d?.clientCertPem || !d.clientKeyPem) return null;
  const url = roleUrl({ scheme: 'mqtts', port: DYNSEC_TLS_PORT, address: role.config.address }, ips);
  return url ? { url, tls: tlsOf(d) } : null;
}

// Every broker whose dynamic-security the hub runs, as it administers it.
export async function loadAdminBrokers() {
  const list = allRoles().filter((r): r is MqttBrokerRole => r.type === 'mqtt-broker' && !!r.config.dynsec);
  const carriers = await hosts.find({ _id: { $in: list.map((r) => r.carrier.id) } }, { projection: { 'info.ips': 1 } }).toArray();
  const ips = new Map(carriers.map((h) => [h._id.toHexString(), h.info?.ips]));
  return list.flatMap((r) => {
    const b = adminBroker(r, ips.get(r.carrier.id.toHexString()));
    return b ? [{ id: r._id, name: r.name, ...b, hostId: r.carrier.id }] : [];
  });
}

export async function adminBrokerOf(role: MqttBrokerRole) {
  const host = await hosts.findOne({ _id: role.carrier.id }, { projection: { 'info.ips': 1 } });
  return adminBroker(role, host?.info?.ips);
}

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
  const dynsec = { enabledAt: new Date(), clientNotAfter: client.notAfter, caPem: pki.caCert, clientCertPem: client.cert, clientKeyPem: client.key };
  const config = { ...role.config, dynsec };
  // the hub must reach the broker by its own certificate; if not, the agent undoes it all
  const admin = adminBroker({ ...role, config }, host.info?.ips);
  try {
    if (!admin) throw new Error('adresse du broker inconnue');
    await testConnection(admin.url, '', '', admin.tls);
  } catch (err) {
    // an older agent only knows how to disable (the state put aside)
    const undo = host.capabilities?.includes('mqtt_dynsec_reset') ? 'mqtt_dynsec_reset' : 'mqtt_dynsec_disable';
    await agentRequest(id, undo, { dynsec: { port: plainPort } }, 150_000).catch(() => undefined);
    throw new DynsecError(`le hub ne se connecte pas au broker en TLS mutuel (${(err as Error).message}) : activation annulée`, 502);
  }
  await roles.replaceOne({ _id: role._id }, { ...role, config });
  // the agent lists its ports again (the new listener), so that the state follows
  await refreshAgent(id, ['info']).catch(() => undefined);
  await rolesSaved([host._id]);
  return { port: DYNSEC_TLS_PORT, notAfter: client.notAfter, validityDays: MQTT_CERT_DAYS };
}

// Reset: the broker goes back to its own configuration (anonymous connections as it says, no account, no ACL) and nothing
// is kept: the agent deletes the state of the plugin, the hub forgets its identity (certificate and key), the account of
// the role (it connects as anonymous) and the refused clients.
export async function resetDynsec(role: MqttBrokerRole) {
  const { host, id } = await carrier(role);
  if (!role.config.dynsec) throw new DynsecError("dynamic-security n'a pas été activé par le hub sur ce rôle");
  if (!host.capabilities?.includes('mqtt_dynsec_reset')) throw new DynsecError("l'agent de cet hôte ne sait pas réinitialiser dynamic-security (mise à jour requise)");
  try {
    await agentRequest(id, 'mqtt_dynsec_reset', { dynsec: { port: role.config.port } }, 150_000);
  } catch (err) {
    throw new DynsecError(`réinitialisation échouée : ${(err as Error).message}`, 502);
  }
  const config = { ...role.config, username: '', password: '' };
  delete config.dynsec;
  await roles.replaceOne({ _id: role._id }, { ...role, config });
  resealSoon();
  clearRefused(role._id);
  await refreshAgent(id, ['info']).catch(() => undefined);
  await rolesSaved([host._id]);
}

// Before the hub kept the identity of the administration in the role itself: the role was moved to the TLS listener, with
// the certificate and the account `hlm`, so that the probes and the Home Assistant bridge no longer worked. The identity
// goes to config.dynsec and the role goes back to the port it was reached at before (plainPort), without account: the
// administrator gives it its own (mqttAccounts.ts, setRoleAccount).
export async function migrateDynsecIdentity(log: FastifyBaseLogger) {
  const stored = await roles.find({ type: 'mqtt-broker', 'config.dynsec.plainPort': { $exists: true } } as never).toArray();
  for (const doc of stored) {
    const role = openRole(doc as unknown as MqttBrokerRole) as MqttBrokerRole & { config: { dynsec: { plainPort: number } } };
    const { caPem, clientCertPem, clientKeyPem, dynsec, ...rest } = role.config;
    const { plainPort, ...d } = dynsec;
    const config = { ...rest, scheme: 'mqtt' as const, port: plainPort, username: '', password: '', dynsec: { ...d, ...(caPem ? { caPem } : {}), ...(clientCertPem ? { clientCertPem } : {}), ...(clientKeyPem ? { clientKeyPem } : {}) } };
    await roles.replaceOne({ _id: doc._id } as never, { ...doc, config } as never);
    log.info({ role: role._id }, 'MQTT: identity of the administration moved out of the connection of the role (back on its former port, without account)');
  }
  if (stored.length) resealSoon();
}
