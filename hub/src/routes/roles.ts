import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import { agentRequest, isOnline } from '../agents.js';
import { settingsDiff } from '../audit.js';
import { equipments, hosts, parseId, roles } from '../db.js';
import { testConnection } from '../homeassistant/bridge.js';
import { checkedFingerprint, omadaCheck, omadaProbe, presentedFingerprint, type LocalFingerprint } from '../omada.js';
import { checkLogServer, LOG_URL_RE, pollLogServers } from '../logs.js';
import { checkAllHosts } from '../setup.js';
import { anonymousOf, clearRefused, forgetAnonymous, forgetRefused, markCreated, refusedOf } from '../refusedLog.js';
import { accountExists, checkName, createAccount, deleteAccount, listAccounts, setAccountPassword, setAccountSys, syncAccount } from '../mqttAccounts.js';
import { brokerAnonymous, brokerAnonymousAccepted, checkBrokersAnonymous, recordAnonymous } from '../brokerAnonymous.js';
import { anonymousState, setAnonymous } from '../mqttAnonymous.js';
import { DynsecError, enableDynsec, resetDynsec, securityView } from '../mqttDynsec.js';
import { securityOf } from '../mqttSecurity.js';
import { PEM_MAX, tlsError, tlsOf } from '../mqttTls.js';
import { roleUrl } from '../probes.js';
import { rolesSaved } from '../roleEvents.js';
import { roleView } from '../roleView.js';
import { allRoles, defOf, newRoleId, ROLE_DEFS, ROLE_ID_RE, roleConflict } from '../roles.js';
import { FINGERPRINT_RE, fetchFingerprint, normalizeFingerprint, SERVER_URL_RE } from '../tlsApi.js';
import { BROKER_SCHEMES, CARRIER_KINDS, LOG_PROTOCOLS, type BrokerScheme, type CarrierKind, type HostDoc, type LogProtocol, type LogServerConfig, type LogServerRole, type MqttBrokerConfig, type MqttBrokerRole, type OmadaControllerConfig, type OmadaControllerRole } from '../types.js';

// Roles of the hub (roles.ts): read by every account (never a secret), written by the admins (profiles.ts refuses what
// it does not list): the hub opens connections to what is declared here. The MQTT brokers and the Omada controllers are
// declared here; a Proxmox VE cluster through routes/backups.ts (its token is made by the agent of the
// node), the PBS by the settings of the backups.

const DECLARED = ['mqtt-broker', 'omada-controller', 'log-server'] as const;
type DeclaredType = (typeof DECLARED)[number];
type DeclaredRole = MqttBrokerRole | OmadaControllerRole | LogServerRole;

// config of a role, one flat shape for the declared types (an anyOf of closed objects would have the validator strip
// the fields of the types it tries first): what each type takes is checked by configError
const config = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // mqtt-broker
    scheme: { enum: BROKER_SCHEMES },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    // absent or "": the first private IP of the host
    address: { type: 'string', maxLength: 253, pattern: '^[A-Za-z0-9.:_-]*$' },
    username: { type: 'string', maxLength: 128 },
    password: { type: 'string', maxLength: 256 }, // absent: unchanged, "": cleared
    // TLS (mqtts, wss), PEM: the authority to trust, the certificate of the hub and its key (absent with the certificate: the stored key is kept)
    caPem: { type: 'string', maxLength: PEM_MAX },
    clientCertPem: { type: 'string', maxLength: PEM_MAX },
    clientKeyPem: { type: 'string', maxLength: PEM_MAX },
    // omada-controller: the address of the Open API and the application of the controller (client mode)
    url: { type: 'string', maxLength: 256 },
    fingerprint: { type: 'string', maxLength: 128 }, // "": the system CAs
    clientId: { type: 'string', maxLength: 128 },
    clientSecret: { type: 'string', maxLength: 256 }, // absent: unchanged
    // log-server: url (its query API), address and port (where the hosts send, in syslog), username and password (basic
    // authentication of the API, optional), and
    protocol: { enum: LOG_PROTOCOLS },
    // hours without a journal before a host that sends is a drift (0: not watched)
    silentHours: { type: 'integer', minimum: 0, maximum: 24 },
  },
} as const;

const carrier = {
  type: 'object',
  required: ['kind', 'id'],
  additionalProperties: false,
  properties: { kind: { enum: CARRIER_KINDS }, id: { type: 'string', maxLength: 24 } },
} as const;

const name = { type: 'string', minLength: 1, maxLength: 64 } as const;

const createBody = {
  type: 'object',
  required: ['type', 'carrier', 'name', 'config'],
  additionalProperties: false,
  properties: { type: { enum: DECLARED }, carrier, name, config },
} as const;

// carrier: moves the role to another carrier, its settings kept
const updateBody = { type: 'object', required: ['name', 'config'], additionalProperties: false, properties: { carrier, name, config } } as const;

// roleId: the stored secret is used when none is typed
const testBody = {
  type: 'object',
  required: ['type', 'carrier', 'config'],
  additionalProperties: false,
  properties: { type: { enum: DECLARED }, carrier, config, roleId: { type: 'string', maxLength: 32 } },
} as const;

export interface ConfigBody {
  scheme?: BrokerScheme;
  port?: number;
  address?: string;
  username?: string;
  password?: string;
  caPem?: string;
  clientCertPem?: string;
  clientKeyPem?: string;
  url?: string;
  fingerprint?: string;
  clientId?: string;
  clientSecret?: string;
  protocol?: LogProtocol;
  silentHours?: number;
}
interface CarrierBody {
  kind: CarrierKind;
  id: string;
}

// the fields of each declared type; its secret: kept when absent from an edit
const FIELDS: Record<DeclaredType, { required: (keyof ConfigBody)[]; optional: (keyof ConfigBody)[]; secret: keyof ConfigBody }> = {
  'mqtt-broker': { required: ['scheme', 'port', 'username'], optional: ['address', 'password', 'caPem', 'clientCertPem', 'clientKeyPem'], secret: 'password' },
  'omada-controller': { required: ['url', 'clientId'], optional: ['fingerprint', 'clientSecret'], secret: 'clientSecret' },
  'log-server': { required: ['url', 'port'], optional: ['address', 'protocol', 'username', 'password', 'silentHours'], secret: 'password' },
};

// null: the config fits a role of this type, else why not
export function configError(type: DeclaredType, c: ConfigBody) {
  const { required, optional } = FIELDS[type];
  const missing = required.find((k) => c[k] === undefined);
  if (missing) return `${missing} manquant`;
  const extra = Object.keys(c).find((k) => !required.includes(k as keyof ConfigBody) && !optional.includes(k as keyof ConfigBody));
  if (extra) return `${extra} inattendu pour un rôle ${ROLE_DEFS[type].label}`;
  if (type === 'mqtt-broker') return tlsError(c, c.scheme!);
  if (type === 'omada-controller') {
    if (!SERVER_URL_RE.test(c.url!.trim())) return 'URL invalide (https://contrôleur:8043)';
    if (!c.clientId!.trim()) return 'client_id manquant';
    if (c.fingerprint && !FINGERPRINT_RE.test(normalizeFingerprint(c.fingerprint))) return 'empreinte invalide (SHA-256, 32 octets en hexadécimal)';
  }
  if (type === 'log-server') {
    if (!LOG_URL_RE.test(c.url!.trim())) return 'URL invalide (http://serveur:9428)';
    if (c.password && !c.username) return 'mot de passe sans utilisateur';
  }
  return null;
}

// The carrier of a role: a host, or an equipment (its IP told as the only one of its info, as the address of a host is)
type Carrier = Pick<HostDoc, '_id' | 'name' | 'info' | 'roleCandidates' | 'capabilities'>;
const carrierOf = async (c: CarrierBody): Promise<Carrier | null> => {
  const _id = parseId(c.id);
  if (!_id) return null;
  if (c.kind === 'equipment') {
    const e = await equipments.findOne({ _id }, { projection: { name: 1, ip: 1 } });
    return e ? ({ _id: e._id, name: e.name, info: { ips: e.ip ? [e.ip] : [] } } as Carrier) : null;
  }
  return hosts.findOne({ _id }, { projection: { name: 1, info: 1, roleCandidates: 1, capabilities: 1 } });
};

// The agent of the host carrying the controller reads its certificate on the host itself (homelab#300): null for an
// equipment, an agent too old (no tls_fingerprint) or offline.
const localFingerprint = (host: Carrier | null): LocalFingerprint | null => {
  if (!host?.capabilities?.includes('tls_fingerprint')) return null;
  const id = host._id.toHexString();
  if (!isOnline(id)) return null;
  return async (h, port) => (await agentRequest<{ fingerprint: string }>(id, 'tls_fingerprint', { host: h, port }, 15_000)).fingerprint;
};

// A fingerprint the agent of the carrier does not read on the host is never pinned, whatever sends it (homelab#300).
async function pinRefused(host: Carrier, c: DeclaredRole['config']) {
  if (!('clientId' in c) || !c.fingerprint) return null;
  const local = localFingerprint(host);
  if (!local) return null;
  const r = await checkedFingerprint(c.url, c.fingerprint, local);
  return r.source === 'mismatch' ? `l'agent de ${host.name} lit une autre empreinte sur l'hôte (${r.agentFingerprint}) : certificat intercepté, ou l'adresse n'est pas celle de cet hôte` : null;
}

// the config stored for a body checked by configError; secret: the one typed, else the one stored
export function toConfig(type: 'mqtt-broker', c: ConfigBody, secret: string): MqttBrokerConfig;
export function toConfig(type: 'omada-controller', c: ConfigBody, secret: string): OmadaControllerConfig;
export function toConfig(type: 'log-server', c: ConfigBody, secret: string): LogServerConfig;
export function toConfig(type: DeclaredType, c: ConfigBody, secret: string): DeclaredRole['config'];
export function toConfig(type: DeclaredType, c: ConfigBody, secret: string): DeclaredRole['config'] {
  if (type === 'log-server')
    return {
      url: c.url!.trim().replace(/\/+$/, ''),
      ...(c.address ? { address: c.address } : {}),
      port: c.port!,
      protocol: c.protocol ?? 'tcp',
      username: c.username?.trim() ?? '',
      // no account: no password kept
      password: c.username?.trim() ? secret : '',
      silentHours: c.silentHours ?? 6,
    };
  if (type === 'omada-controller')
    return { url: c.url!.trim().replace(/\/+$/, ''), fingerprint: c.fingerprint ? normalizeFingerprint(c.fingerprint) : '', clientId: c.clientId!.trim(), clientSecret: secret };
  return {
    scheme: c.scheme!,
    port: c.port!,
    ...(c.address ? { address: c.address } : {}),
    username: c.username!,
    password: secret,
    ...(c.caPem?.trim() ? { caPem: c.caPem.trim() } : {}),
    ...(c.clientCertPem?.trim() && c.clientKeyPem?.trim() ? { clientCertPem: c.clientCertPem.trim(), clientKeyPem: c.clientKeyPem.trim() } : {}),
  };
}

// An edit that sends the client certificate without its key keeps the stored key (it is never sent back to the UI).
export function withStoredKey(c: ConfigBody, stored: DeclaredRole | undefined): ConfigBody {
  // no TLS material sent at all (the form of the role has no field for it): what is stored stays, with a TLS scheme
  if (stored?.type === 'mqtt-broker' && c.caPem === undefined && c.clientCertPem === undefined && c.clientKeyPem === undefined && (c.scheme === 'mqtts' || c.scheme === 'wss')) {
    return { ...c, caPem: stored.config.caPem, clientCertPem: stored.config.clientCertPem, clientKeyPem: stored.config.clientKeyPem };
  }
  if (stored?.type !== 'mqtt-broker' || !c.clientCertPem?.trim() || c.clientKeyPem !== undefined || !stored.config.clientKeyPem) return c;
  return { ...c, clientKeyPem: stored.config.clientKeyPem };
}

const storedSecret = (r: DeclaredRole) => (r.type === 'omada-controller' ? r.config.clientSecret : r.config.password);
const typedSecret = (type: DeclaredType, c: ConfigBody) => c[FIELDS[type].secret] as string | undefined;

// the role of the route, when it is declared here (the others have their own routes)
const declaredRole = (id: string) => allRoles().find((r): r is DeclaredRole => r._id === id && (DECLARED as readonly string[]).includes(r.type));

// A log server written: its state is read at once, and the hosts that send to it are checked again (its address is in
// their configuration).
function logServerSaved(log: FastifyBaseLogger) {
  pollLogServers(log)
    .then(() => checkAllHosts())
    .catch((err) => log.warn({ err }, 'log server: check after a change failed'));
}

export function registerRoleRoutes(app: FastifyInstance) {
  app.get('/api/roles', async () => {
    const list = allRoles();
    const ids = list.map((r) => r.carrier.id);
    const [carriers, boxes] = await Promise.all([
      hosts.find({ _id: { $in: ids } }, { projection: { name: 1, info: 1, roleCandidates: 1 } }).toArray(),
      equipments.find({ _id: { $in: ids } }, { projection: { name: 1, ip: 1 } }).toArray(),
    ]);
    const byId = new Map<string, Pick<HostDoc, 'name' | 'info'>>([...carriers, ...boxes.map((e) => ({ _id: e._id, name: e.name, info: { ips: e.ip ? [e.ip] : [] } as unknown as HostDoc['info'] }))].map((h) => [h._id.toHexString(), h]));
    const uses = await Promise.all(list.map((r) => defOf(r.type).uses(r._id)));
    return { roles: list.map((r, i) => ({ ...roleView(r, byId.get(r.carrier.id.toHexString()) ?? null), uses: uses[i] })) };
  });

  app.post<{ Body: { type: DeclaredType; carrier: CarrierBody; name: string; config: ConfigBody } }>('/api/roles', { schema: { body: createBody } }, async (req, reply) => {
    const type = req.body.type;
    const def = ROLE_DEFS[type];
    const bad = configError(type, req.body.config);
    if (bad) return reply.code(400).send({ error: bad });
    if (!def.carriers.includes(req.body.carrier.kind)) return reply.code(400).send({ error: `un rôle ${def.label} ne peut pas être porté par ce type d'élément` });
    const secret = typedSecret(type, req.body.config) ?? '';
    if (type === 'omada-controller' && !secret) return reply.code(400).send({ error: 'client_secret manquant' });
    const host = await carrierOf(req.body.carrier);
    if (!host) return reply.code(404).send({ error: 'host not found' });
    const name = req.body.name.trim();
    const c = toConfig(type, req.body.config, secret);
    const why = defOf(type).carrierError(host, c) ?? roleConflict(allRoles(), type, name, host._id, c) ?? (await pinRefused(host, c));
    if (why) return reply.code(409).send({ error: why });
    const id = newRoleId(name, (x) => allRoles().some((r) => r._id === x));
    if (!ROLE_ID_RE.test(id)) return reply.code(400).send({ error: 'nom invalide' });
    await roles.insertOne({ _id: id, type, name, carrier: { kind: req.body.carrier.kind, id: host._id }, config: c, createdAt: new Date() } as DeclaredRole);
    req.auditNote = { target: { kind: 'role', id, name }, details: { type, carrier: host.name, config: settingsDiff({}, c).values } };
    await rolesSaved([host._id]);
    if (type === 'log-server') logServerSaved(req.log);
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string }; Body: { carrier?: CarrierBody; name: string; config: ConfigBody } }>('/api/roles/:id', { schema: { body: updateBody } }, async (req, reply) => {
    const current = declaredRole(req.params.id);
    if (!current) return reply.code(404).send({ error: 'rôle inconnu' });
    const def = defOf(current.type);
    const body = withStoredKey(req.body.config, current);
    const bad = configError(current.type, body);
    if (bad) return reply.code(400).send({ error: bad });
    if (req.body.carrier && !def.carriers.includes(req.body.carrier.kind)) return reply.code(400).send({ error: `un rôle ${def.label} ne peut pas être porté par ce type d'élément` });
    const secret = typedSecret(current.type, body) ?? storedSecret(current);
    if (current.type === 'omada-controller' && !secret) return reply.code(400).send({ error: 'client_secret manquant' });
    const host = await carrierOf(req.body.carrier ?? { kind: current.carrier.kind, id: current.carrier.id.toHexString() });
    if (!host) return reply.code(404).send({ error: 'host not found' });
    const name = req.body.name.trim();
    const c = toConfig(current.type, body, secret);
    // set by the activation of dynamic-security, not by a form
    if (current.type === 'mqtt-broker' && current.config.dynsec) (c as MqttBrokerConfig).dynsec = current.config.dynsec;
    const moved = !host._id.equals(current.carrier.id);
    // what the agent detected is checked again only when it changes: a broker stopped for a while stays editable
    const why =
      (moved || !def.same(current.config, c) ? def.carrierError(host, c) : null) ??
      roleConflict(allRoles(), current.type, name, host._id, c, current._id) ??
      // a fingerprint kept as it is stays editable after a renewal of the certificate (the next poll says it changed)
      (moved || ('fingerprint' in current.config && current.config.fingerprint !== (c as OmadaControllerConfig).fingerprint) ? await pinRefused(host, c) : null);
    if (why) return reply.code(409).send({ error: why });
    // a broker whose accounts the hub runs: the account of the role is made (or its password changed) on the broker first,
    // then the role must connect with it
    let account: 'created' | 'password' | undefined;
    if (current.type === 'mqtt-broker' && current.config.dynsec) {
      if (moved) return reply.code(409).send({ error: "la gestion des comptes est active sur ce broker : la réinitialiser avant de déplacer le rôle sur un autre hôte" });
      const mc = c as MqttBrokerConfig;
      const typed = typedSecret(current.type, body);
      // typed (or generated): made or changed on the broker; the stored one: the account is made only when missing
      const pw = typed || mc.password;
      if (mc.username && pw) {
        try {
          checkName(mc.username);
          account = await syncAccount(current, mc.username, pw, !typed);
          await testConnection(roleUrl(mc, host.info?.ips), mc.username, pw, tlsOf(mc));
        } catch (err) {
          if (err instanceof DynsecError) return dynsecFail(reply, err);
          return reply.code(502).send({ error: `${account ? 'compte mis à jour sur le broker, mais ' : ''}connexion refusée : ${(err as Error).message}${!typed ? " (le compte existe sur le broker avec un autre mot de passe : en saisir ou en générer un)" : ''}` });
        }
      } else if (mc.username) {
        return reply.code(400).send({ error: 'compte sans mot de passe : en saisir ou en générer un, il sera créé sur le broker' });
      }
    }
    await roles.replaceOne({ _id: current._id }, { ...current, name, carrier: { kind: req.body.carrier?.kind ?? current.carrier.kind, id: host._id }, config: c } as DeclaredRole);
    req.auditNote = {
      target: { kind: 'role', id: current._id, name },
      details: { type: current.type, ...(account ? { brokerAccount: account } : {}), ...(moved ? { carrier: host.name } : {}), ...(name !== current.name ? { renamed: { from: current.name, to: name } } : {}), ...settingsDiff(current.config, c) },
    };
    await rolesSaved(moved ? [current.carrier.id, host._id] : [host._id]);
    if (current.type === 'log-server') logServerSaved(req.log);
    return { id: current._id };
  });

  app.delete<{ Params: { id: string } }>('/api/roles/:id', async (req, reply) => {
    const current = declaredRole(req.params.id);
    if (!current) return reply.code(404).send({ error: 'rôle inconnu' });
    const uses = await defOf(current.type).uses(current._id);
    if (uses.length) return reply.code(409).send({ error: `utilisé par : ${uses.join(', ')}` });
    await roles.deleteOne({ _id: current._id });
    req.auditNote = { target: { kind: 'role', id: current._id, name: current.name }, details: { type: current.type } };
    await rolesSaved([current.carrier.id]);
    if (current.type === 'log-server') logServerSaved(req.log);
    return reply.code(204).send();
  });

  // fingerprint of the certificate a controller presents, for the admin to check and pin (never pinned on its own),
  // compared to the one the agent of its carrier reads on the host (source, checkedFingerprint)
  app.post<{ Body: { url: string; carrier?: CarrierBody } }>(
    '/api/roles/fingerprint',
    { schema: { body: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string', maxLength: 256 }, carrier } } } },
    async (req, reply) => {
      const url = req.body.url.trim().replace(/\/+$/, '');
      if (!SERVER_URL_RE.test(url)) return reply.code(400).send({ error: 'URL invalide (https://contrôleur:8043)' });
      const host = req.body.carrier ? await carrierOf(req.body.carrier) : null;
      try {
        return await checkedFingerprint(url, await fetchFingerprint(url, 443), localFingerprint(host));
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );

  // Management of the accounts of a Mosquitto broker (dynamic-security, run by the agent of its host, mqttDynsec.ts)
  const brokerRole = (id: string) => {
    const r = declaredRole(id);
    return r?.type === 'mqtt-broker' ? r : undefined;
  };
  const dynsecFail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof DynsecError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };
  app.get<{ Params: { id: string } }>('/api/roles/:id/mqtt-security', async (req, reply) => {
    const role = brokerRole(req.params.id);
    if (!role) return reply.code(404).send({ error: 'rôle inconnu' });
    return securityView(role);
  });
  app.post<{ Params: { id: string } }>('/api/roles/:id/mqtt-security/enable', async (req, reply) => {
    const role = brokerRole(req.params.id);
    if (!role) return reply.code(404).send({ error: 'rôle inconnu' });
    req.auditNote = { target: { kind: 'role', id: role._id, name: role.name } };
    try {
      const r = await enableDynsec(role);
      void checkBrokersAnonymous().catch(() => undefined);
      return r;
    } catch (err) {
      return dynsecFail(reply, err);
    }
  });
  app.post<{ Params: { id: string } }>('/api/roles/:id/mqtt-security/reset', async (req, reply) => {
    const role = brokerRole(req.params.id);
    if (!role) return reply.code(404).send({ error: 'rôle inconnu' });
    req.auditNote = { target: { kind: 'role', id: role._id, name: role.name } };
    try {
      await resetDynsec(role);
      void checkBrokersAnonymous().catch(() => undefined);
      return { ok: true };
    } catch (err) {
      return dynsecFail(reply, err);
    }
  });

  // Accounts of a broker whose dynamic-security the hub runs (mqttAccounts.ts): list with the connection state, create,
  // change the password (generated when absent, returned once), delete
  app.get<{ Params: { id: string } }>('/api/roles/:id/mqtt-accounts', async (req, reply) => {
    const role = brokerRole(req.params.id);
    if (!role) return reply.code(404).send({ error: 'rôle inconnu' });
    try {
      return { accounts: await listAccounts(role), refused: refusedOf(role._id), anonymous: anonymousOf(role._id), anonymousAllowed: brokerAnonymous(role._id), anonymousAccepted: brokerAnonymousAccepted(role._id) };
    } catch (err) {
      return dynsecFail(reply, err);
    }
  });
  const accountBody = { type: 'object', additionalProperties: false, properties: { password: { type: 'string', maxLength: 256 } } } as const;
  app.post<{ Params: { id: string }; Body: { username: string; password?: string; clientId?: string } }>(
    '/api/roles/:id/mqtt-accounts',
    { schema: { body: { ...accountBody, required: ['username'], properties: { ...accountBody.properties, username: { type: 'string', maxLength: 128 }, clientId: { type: 'string', maxLength: 256 } } } } },
    async (req, reply) => {
      const role = brokerRole(req.params.id);
      if (!role) return reply.code(404).send({ error: 'rôle inconnu' });
      req.auditNote = { target: { kind: 'role', id: role._id, name: role.name }, details: { account: req.body.username } };
      try {
        const created = await createAccount(role, req.body.username, req.body.password);
        // made for a refused client: it stays listed, as waiting, until a connection passes
        if (req.body.clientId) markCreated(role._id, req.body.clientId, created.username);
        return reply.code(201).send(created);
      } catch (err) {
        return dynsecFail(reply, err);
      }
    },
  );
  app.delete<{ Params: { id: string } }>('/api/roles/:id/mqtt-refused', async (req, reply) => {
    const role = brokerRole(req.params.id);
    if (!role) return reply.code(404).send({ error: 'rôle inconnu' });
    return { cleared: clearRefused(role._id) };
  });
  // Whether the broker accepts clients without an account (mqttAnonymous.ts): the configuration of the broker, changed by its
  // agent with a restart, and the rights of the anonymous group
  app.get<{ Params: { id: string } }>('/api/roles/:id/mqtt-anonymous', async (req, reply) => {
    const role = brokerRole(req.params.id);
    if (!role) return reply.code(404).send({ error: 'rôle inconnu' });
    try {
      const st = await anonymousState(role);
      recordAnonymous(role._id, st);
      return st;
    } catch (err) {
      return dynsecFail(reply, err);
    }
  });
  app.put<{ Params: { id: string }; Body: { allowed: boolean } }>(
    '/api/roles/:id/mqtt-anonymous',
    { schema: { body: { type: 'object', required: ['allowed'], additionalProperties: false, properties: { allowed: { type: 'boolean' } } } } },
    async (req, reply) => {
      const role = brokerRole(req.params.id);
      if (!role) return reply.code(404).send({ error: 'rôle inconnu' });
      req.auditNote = { target: { kind: 'role', id: role._id, name: role.name }, details: { anonymous: req.body.allowed } };
      try {
        const state = await setAnonymous(role, req.body.allowed);
        recordAnonymous(role._id, state);
        return state;
      } catch (err) {
        return dynsecFail(reply, err);
      }
    },
  );
  // clears a refused client from the list (kept in memory by the hub, refusedLog.ts): it comes back if it is refused again
  app.delete<{ Params: { id: string; clientId: string } }>('/api/roles/:id/mqtt-refused/:clientId', async (req, reply) => {
    const role = brokerRole(req.params.id);
    if (!role) return reply.code(404).send({ error: 'rôle inconnu' });
    return { ok: forgetRefused(role._id, req.params.clientId) };
  });
  // same for an anonymous client: it comes back at its next connection
  app.delete<{ Params: { id: string; clientId: string } }>('/api/roles/:id/mqtt-anonymous/:clientId', async (req, reply) => {
    const role = brokerRole(req.params.id);
    if (!role) return reply.code(404).send({ error: 'rôle inconnu' });
    return { ok: forgetAnonymous(role._id, req.params.clientId) };
  });
  app.put<{ Params: { id: string; username: string }; Body: { password?: string } }>(
    '/api/roles/:id/mqtt-accounts/:username',
    { schema: { body: accountBody } },
    async (req, reply) => {
      const role = brokerRole(req.params.id);
      if (!role) return reply.code(404).send({ error: 'rôle inconnu' });
      req.auditNote = { target: { kind: 'role', id: role._id, name: role.name }, details: { account: req.params.username } };
      try {
        return await setAccountPassword(role, req.params.username, req.body.password);
      } catch (err) {
        return dynsecFail(reply, err);
      }
    },
  );
  app.put<{ Params: { id: string; username: string }; Body: { enabled: boolean } }>(
    '/api/roles/:id/mqtt-accounts/:username/sys',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } } } },
    async (req, reply) => {
      const role = brokerRole(req.params.id);
      if (!role) return reply.code(404).send({ error: 'rôle inconnu' });
      req.auditNote = { target: { kind: 'role', id: role._id, name: role.name }, details: { account: req.params.username, sys: req.body.enabled } };
      try {
        return await setAccountSys(role, req.params.username, req.body.enabled);
      } catch (err) {
        return dynsecFail(reply, err);
      }
    },
  );
  app.delete<{ Params: { id: string; username: string } }>('/api/roles/:id/mqtt-accounts/:username', async (req, reply) => {
    const role = brokerRole(req.params.id);
    if (!role) return reply.code(404).send({ error: 'rôle inconnu' });
    req.auditNote = { target: { kind: 'role', id: role._id, name: role.name }, details: { account: req.params.username } };
    try {
      await deleteAccount(role, req.params.username);
      return { ok: true };
    } catch (err) {
      return dynsecFail(reply, err);
    }
  });

  // What an Omada controller answers without any account (/api/info): is something there, and is it a controller. As
  // the test, the fingerprint its certificate presents when it was refused (to pin it).
  app.post<{ Body: { url: string; fingerprint?: string; carrier?: CarrierBody } }>(
    '/api/roles/probe',
    { schema: { body: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string', maxLength: 256 }, fingerprint: { type: 'string', maxLength: 128 }, carrier } } } },
    async (req, reply) => {
      const url = req.body.url.trim().replace(/\/+$/, '');
      if (!SERVER_URL_RE.test(url)) return reply.code(400).send({ error: 'URL invalide (https://contrôleur:8043)' });
      const fingerprint = req.body.fingerprint ? normalizeFingerprint(req.body.fingerprint) : '';
      if (fingerprint && !FINGERPRINT_RE.test(fingerprint)) return reply.code(400).send({ error: 'empreinte invalide (SHA-256, 32 octets en hexadécimal)' });
      const c = { url, fingerprint };
      try {
        const r = await omadaProbe(c);
        return { ok: true, detail: `contrôleur Omada${r.version ? ` ${r.version}` : ''} (${r.omadacId.slice(0, 8)}…)` };
      } catch (err) {
        const presented = await presentedFingerprint(c, err, localFingerprint(req.body.carrier ? await carrierOf(req.body.carrier) : null));
        return { ok: false, error: (err as Error).message, ...presented };
      }
    },
  );

  // connection test of a role being declared or edited. omada-controller: fingerprint, the one its certificate presents
  // when it was refused, and its source (to pin it or not, checkedFingerprint); detail: what the controller answered
  app.post<{ Body: { type: DeclaredType; carrier: CarrierBody; config: ConfigBody; roleId?: string } }>('/api/roles/test', { schema: { body: testBody } }, async (req, reply) => {
    const { type } = req.body;
    const stored = req.body.roleId ? declaredRole(req.body.roleId) : undefined;
    const body = withStoredKey(req.body.config, stored);
    const bad = configError(type, body);
    if (bad) return reply.code(400).send({ error: bad });
    const secret = typedSecret(type, body) ?? (stored?.type === type ? storedSecret(stored) : '');
    if (type === 'omada-controller') {
      const c = toConfig(type, body, secret);
      if (!secret) return { ok: false, error: 'client_secret manquant' };
      try {
        const r = await omadaCheck(c);
        return { ok: true, detail: `${r.version ? `contrôleur ${r.version}, ` : ''}${r.sites} site${r.sites > 1 ? 's' : ''} visible${r.sites > 1 ? 's' : ''} par l'application` };
      } catch (err) {
        const presented = await presentedFingerprint(c, err, localFingerprint(await carrierOf(req.body.carrier)));
        return { ok: false, error: (err as Error).message, ...presented };
      }
    }
    if (type === 'log-server') {
      const c = toConfig(type, body, secret);
      try {
        const r = await checkLogServer(c);
        const received = r.senders ? `${r.senders} émetteur${r.senders > 1 ? 's' : ''} sur 24 h` : "aucun journal reçu pour l'instant";
        const tcp = r.syslog?.tcp ?? [];
        const input = !r.syslog ? 'configuration syslog non lisible' : tcp.length ? `reçoit le syslog TCP sur ${tcp.join(', ')}` : 'ne reçoit pas de syslog en TCP (-syslog.listenAddr.tcp absent)';
        // syslog: the ports read on the server, proposed as where the hosts send
        return { ok: true, detail: `VictoriaLogs joignable, ${input}, ${received}`, ...(r.syslog ? { syslog: r.syslog } : {}) };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    const host = await carrierOf(req.body.carrier);
    if (!host) return reply.code(404).send({ error: 'host not found' });
    const mqttConfig = toConfig('mqtt-broker', body, secret);
    const url = roleUrl(mqttConfig, host.info?.ips);
    if (!url) return { ok: false, error: "adresse de l'hôte inconnue : la saisir" };
    // for information: whether the broker can have its accounts managed by the hub (dynamic-security)
    const security = securityOf({ config: mqttConfig }, host);
    const dynsec = { state: security.state, ...(security.version ? { version: security.version } : {}), ...(security.reason ? { reason: security.reason } : {}), managed: !!(stored?.type === 'mqtt-broker' && stored.config.dynsec) };
    // without an account too (no certificate either, the authority only): anyone on the network may publish on it
    const anonymousToo = () => testConnection(url, '', '', mqttConfig.caPem ? { caPem: mqttConfig.caPem } : undefined).then(() => true, () => false);
    try {
      await testConnection(url, body.username!, secret, tlsOf(mqttConfig));
      const anonymous = await anonymousToo();
      return { ok: true, dynsec, ...(anonymous ? { anonymous: true, detail: 'le broker accepte aussi les connexions anonymes : tout le réseau peut y publier' } : {}) };
    } catch (err) {
      // a managed broker: an account typed in the dialog is made (or its password changed) when the role is saved
      const typed = typedSecret(type, body);
      if (dynsec.managed && body.username && secret && /not authori|bad user ?name or password/i.test((err as Error).message)) {
        if (typed) return { ok: true, dynsec, pending: true, detail: `le compte ${body.username} sera créé, ou son mot de passe changé, sur le broker à l'enregistrement` };
        // the stored password: a missing account is made at the save, an existing one keeps its own password
        const exists = await accountExists(stored as MqttBrokerRole, body.username).catch(() => true);
        if (!exists) return { ok: true, dynsec, pending: true, detail: `le compte ${body.username} sera créé sur le broker à l'enregistrement` };
        return { ok: false, dynsec, error: `le compte ${body.username} existe sur le broker avec un autre mot de passe : en saisir ou en générer un` };
      }
      return { ok: false, dynsec, error: (err as Error).message };
    }
  });
}
