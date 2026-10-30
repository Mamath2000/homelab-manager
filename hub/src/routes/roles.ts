import type { FastifyInstance } from 'fastify';
import { equipments, hosts, parseId, roles } from '../db.js';
import { testConnection } from '../homeassistant/bridge.js';
import { omadaCheck, omadaProbe, presentedFingerprint } from '../omada.js';
import { roleUrl } from '../probes.js';
import { rolesSaved } from '../roleEvents.js';
import { roleView } from '../roleView.js';
import { allRoles, defOf, newRoleId, ROLE_DEFS, ROLE_ID_RE, roleConflict } from '../roles.js';
import { FINGERPRINT_RE, fetchFingerprint, normalizeFingerprint, SERVER_URL_RE } from '../tlsApi.js';
import { BROKER_SCHEMES, CARRIER_KINDS, type BrokerScheme, type CarrierKind, type HostDoc, type MqttBrokerConfig, type MqttBrokerRole, type OmadaControllerConfig, type OmadaControllerRole } from '../types.js';

// Roles of the hub (roles.ts): read by every account (never a secret), written by the admins (profiles.ts refuses what
// it does not list): the hub opens connections to what is declared here. The MQTT brokers and the Omada controllers are
// declared here; a Proxmox VE cluster through routes/backups.ts (its token is made by the agent of the
// node), the PBS by the settings of the backups.

const DECLARED = ['mqtt-broker', 'omada-controller'] as const;
type DeclaredType = (typeof DECLARED)[number];
type DeclaredRole = MqttBrokerRole | OmadaControllerRole;

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
    // omada-controller: the address of the Open API and the application of the controller (client mode)
    url: { type: 'string', maxLength: 256 },
    fingerprint: { type: 'string', maxLength: 128 }, // "": the system CAs
    clientId: { type: 'string', maxLength: 128 },
    clientSecret: { type: 'string', maxLength: 256 }, // absent: unchanged
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
  url?: string;
  fingerprint?: string;
  clientId?: string;
  clientSecret?: string;
}
interface CarrierBody {
  kind: CarrierKind;
  id: string;
}

// the fields of each declared type; its secret: kept when absent from an edit
const FIELDS: Record<DeclaredType, { required: (keyof ConfigBody)[]; optional: (keyof ConfigBody)[]; secret: keyof ConfigBody }> = {
  'mqtt-broker': { required: ['scheme', 'port', 'username'], optional: ['address', 'password'], secret: 'password' },
  'omada-controller': { required: ['url', 'clientId'], optional: ['fingerprint', 'clientSecret'], secret: 'clientSecret' },
};

// null: the config fits a role of this type, else why not
export function configError(type: DeclaredType, c: ConfigBody) {
  const { required, optional } = FIELDS[type];
  const missing = required.find((k) => c[k] === undefined);
  if (missing) return `${missing} manquant`;
  const extra = Object.keys(c).find((k) => !required.includes(k as keyof ConfigBody) && !optional.includes(k as keyof ConfigBody));
  if (extra) return `${extra} inattendu pour un rôle ${ROLE_DEFS[type].label}`;
  if (type === 'omada-controller') {
    if (!SERVER_URL_RE.test(c.url!.trim())) return 'URL invalide (https://contrôleur:8043)';
    if (!c.clientId!.trim()) return 'client_id manquant';
    if (c.fingerprint && !FINGERPRINT_RE.test(normalizeFingerprint(c.fingerprint))) return 'empreinte invalide (SHA-256, 32 octets en hexadécimal)';
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

// the config stored for a body checked by configError; secret: the one typed, else the one stored
export function toConfig(type: 'mqtt-broker', c: ConfigBody, secret: string): MqttBrokerConfig;
export function toConfig(type: 'omada-controller', c: ConfigBody, secret: string): OmadaControllerConfig;
export function toConfig(type: DeclaredType, c: ConfigBody, secret: string): DeclaredRole['config'];
export function toConfig(type: DeclaredType, c: ConfigBody, secret: string): DeclaredRole['config'] {
  if (type === 'omada-controller')
    return { url: c.url!.trim().replace(/\/+$/, ''), fingerprint: c.fingerprint ? normalizeFingerprint(c.fingerprint) : '', clientId: c.clientId!.trim(), clientSecret: secret };
  return { scheme: c.scheme!, port: c.port!, ...(c.address ? { address: c.address } : {}), username: c.username!, password: secret };
}

const storedSecret = (r: DeclaredRole) => (r.type === 'mqtt-broker' ? r.config.password : r.config.clientSecret);
const typedSecret = (type: DeclaredType, c: ConfigBody) => c[FIELDS[type].secret] as string | undefined;

// the role of the route, when it is declared here (the others have their own routes)
const declaredRole = (id: string) => allRoles().find((r): r is DeclaredRole => r._id === id && (DECLARED as readonly string[]).includes(r.type));

export function registerRoleRoutes(app: FastifyInstance) {
  app.get('/api/roles', async () => {
    const list = allRoles();
    const ids = list.map((r) => r.carrier.id);
    const [carriers, boxes] = await Promise.all([
      hosts.find({ _id: { $in: ids } }, { projection: { name: 1, info: 1 } }).toArray(),
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
    const why = defOf(type).carrierError(host, c) ?? roleConflict(allRoles(), type, name, host._id, c);
    if (why) return reply.code(409).send({ error: why });
    const id = newRoleId(name, (x) => allRoles().some((r) => r._id === x));
    if (!ROLE_ID_RE.test(id)) return reply.code(400).send({ error: 'nom invalide' });
    await roles.insertOne({ _id: id, type, name, carrier: { kind: req.body.carrier.kind, id: host._id }, config: c, createdAt: new Date() } as DeclaredRole);
    await rolesSaved([host._id]);
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string }; Body: { carrier?: CarrierBody; name: string; config: ConfigBody } }>('/api/roles/:id', { schema: { body: updateBody } }, async (req, reply) => {
    const current = declaredRole(req.params.id);
    if (!current) return reply.code(404).send({ error: 'rôle inconnu' });
    const def = defOf(current.type);
    const bad = configError(current.type, req.body.config);
    if (bad) return reply.code(400).send({ error: bad });
    if (req.body.carrier && !def.carriers.includes(req.body.carrier.kind)) return reply.code(400).send({ error: `un rôle ${def.label} ne peut pas être porté par ce type d'élément` });
    const secret = typedSecret(current.type, req.body.config) ?? storedSecret(current);
    if (current.type === 'omada-controller' && !secret) return reply.code(400).send({ error: 'client_secret manquant' });
    const host = await carrierOf(req.body.carrier ?? { kind: current.carrier.kind, id: current.carrier.id.toHexString() });
    if (!host) return reply.code(404).send({ error: 'host not found' });
    const name = req.body.name.trim();
    const c = toConfig(current.type, req.body.config, secret);
    const moved = !host._id.equals(current.carrier.id);
    // what the agent detected is checked again only when it changes: a broker stopped for a while stays editable
    const why = (moved || !def.same(current.config, c) ? def.carrierError(host, c) : null) ?? roleConflict(allRoles(), current.type, name, host._id, c, current._id);
    if (why) return reply.code(409).send({ error: why });
    await roles.replaceOne({ _id: current._id }, { ...current, name, carrier: { kind: req.body.carrier?.kind ?? current.carrier.kind, id: host._id }, config: c } as DeclaredRole);
    await rolesSaved(moved ? [current.carrier.id, host._id] : [host._id]);
    return { id: current._id };
  });

  app.delete<{ Params: { id: string } }>('/api/roles/:id', async (req, reply) => {
    const current = declaredRole(req.params.id);
    if (!current) return reply.code(404).send({ error: 'rôle inconnu' });
    const uses = await defOf(current.type).uses(current._id);
    if (uses.length) return reply.code(409).send({ error: `utilisé par : ${uses.join(', ')}` });
    await roles.deleteOne({ _id: current._id });
    await rolesSaved([current.carrier.id]);
    return reply.code(204).send();
  });

  // fingerprint of the certificate a controller presents, for the admin to check and pin (never pinned on its own)
  app.post<{ Body: { url: string } }>(
    '/api/roles/fingerprint',
    { schema: { body: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string', maxLength: 256 } } } } },
    async (req, reply) => {
      const url = req.body.url.trim().replace(/\/+$/, '');
      if (!SERVER_URL_RE.test(url)) return reply.code(400).send({ error: 'URL invalide (https://contrôleur:8043)' });
      try {
        return { fingerprint: await fetchFingerprint(url, 443) };
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );

  // What an Omada controller answers without any account (/api/info): is something there, and is it a controller. As
  // the test, the fingerprint its certificate presents when it was refused (to pin it).
  app.post<{ Body: { url: string; fingerprint?: string } }>(
    '/api/roles/probe',
    { schema: { body: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string', maxLength: 256 }, fingerprint: { type: 'string', maxLength: 128 } } } } },
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
        const presented = await presentedFingerprint(c, err);
        return { ok: false, error: (err as Error).message, ...(presented ? { fingerprint: presented } : {}) };
      }
    },
  );

  // connection test of a role being declared or edited. omada-controller: fingerprint, the one its certificate presents
  // when it was refused (to pin it); detail: what the controller answered
  app.post<{ Body: { type: DeclaredType; carrier: CarrierBody; config: ConfigBody; roleId?: string } }>('/api/roles/test', { schema: { body: testBody } }, async (req, reply) => {
    const { type, config: body } = req.body;
    const bad = configError(type, body);
    if (bad) return reply.code(400).send({ error: bad });
    const stored = req.body.roleId ? declaredRole(req.body.roleId) : undefined;
    const secret = typedSecret(type, body) ?? (stored?.type === type ? storedSecret(stored) : '');
    if (type === 'omada-controller') {
      const c = toConfig(type, body, secret);
      if (!secret) return { ok: false, error: 'client_secret manquant' };
      try {
        const r = await omadaCheck(c);
        return { ok: true, detail: `${r.version ? `contrôleur ${r.version}, ` : ''}${r.sites} site${r.sites > 1 ? 's' : ''} visible${r.sites > 1 ? 's' : ''} par l'application` };
      } catch (err) {
        const fingerprint = await presentedFingerprint(c, err);
        return { ok: false, error: (err as Error).message, ...(fingerprint ? { fingerprint } : {}) };
      }
    }
    const host = await carrierOf(req.body.carrier);
    if (!host) return reply.code(404).send({ error: 'host not found' });
    const url = roleUrl(toConfig(type, body, secret), host.info?.ips);
    if (!url) return { ok: false, error: "adresse de l'hôte inconnue : la saisir" };
    try {
      await testConnection(url, body.username!, secret);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}
