import type { FastifyInstance } from 'fastify';
import { hosts, parseId, roles } from '../db.js';
import { testConnection } from '../homeassistant/bridge.js';
import { roleUrl } from '../probes.js';
import { rolesSaved } from '../roleEvents.js';
import { roleView } from '../roleView.js';
import { allRoles, defOf, newRoleId, ROLE_DEFS, ROLE_ID_RE, roleConflict } from '../roles.js';
import { BROKER_SCHEMES, CARRIER_KINDS, type CarrierKind, type MqttBrokerConfig, type MqttBrokerRole } from '../types.js';

// Roles of the hub (roles.ts): read by every account (never a secret), written by the admins (profiles.ts refuses what
// it does not list): the hub opens connections to what is declared here. The MQTT brokers are declared here; the
// reporting of a Proxmox VE cluster through routes/backups.ts (its token is made by the agent of the node).

// config of a mqtt-broker role
const config = {
  type: 'object',
  required: ['scheme', 'port', 'username'],
  additionalProperties: false,
  properties: {
    scheme: { enum: BROKER_SCHEMES },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    // absent or "": the first private IP of the host
    address: { type: 'string', maxLength: 253, pattern: '^[A-Za-z0-9.:_-]*$' },
    username: { type: 'string', maxLength: 128 },
    password: { type: 'string', maxLength: 256 }, // absent: unchanged, "": cleared
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
  properties: { type: { enum: ['mqtt-broker'] }, carrier, name, config },
} as const;

// carrier: moves the role to another carrier, its settings kept
const updateBody = { type: 'object', required: ['name', 'config'], additionalProperties: false, properties: { carrier, name, config } } as const;

// roleId: the stored password is used when none is typed
const testBody = {
  type: 'object',
  required: ['type', 'carrier', 'config'],
  additionalProperties: false,
  properties: { type: { enum: ['mqtt-broker'] }, carrier, config, roleId: { type: 'string', maxLength: 32 } },
} as const;

type ConfigBody = Omit<MqttBrokerConfig, 'password'> & { password?: string };
interface CarrierBody {
  kind: CarrierKind;
  id: string;
}

const carrierOf = async (c: CarrierBody) => {
  const _id = parseId(c.id);
  return _id ? hosts.findOne({ _id }, { projection: { name: 1, info: 1, roleCandidates: 1, capabilities: 1 } }) : null;
};

const toConfig = (c: ConfigBody, password: string): MqttBrokerConfig => ({
  scheme: c.scheme,
  port: c.port,
  ...(c.address ? { address: c.address } : {}),
  username: c.username,
  password,
});

// the role of the route, when it is a broker (the others have their own routes)
const brokerRole = (id: string) => allRoles().find((r): r is MqttBrokerRole => r._id === id && r.type === 'mqtt-broker');

export function registerRoleRoutes(app: FastifyInstance) {
  app.get('/api/roles', async () => {
    const list = allRoles();
    const carriers = await hosts.find({ _id: { $in: list.map((r) => r.carrier.id) } }, { projection: { name: 1, info: 1 } }).toArray();
    const byId = new Map(carriers.map((h) => [h._id.toHexString(), h]));
    const uses = await Promise.all(list.map((r) => defOf(r.type).uses(r._id)));
    return { roles: list.map((r, i) => ({ ...roleView(r, byId.get(r.carrier.id.toHexString()) ?? null), uses: uses[i] })) };
  });

  app.post<{ Body: { type: 'mqtt-broker'; carrier: CarrierBody; name: string; config: ConfigBody } }>('/api/roles', { schema: { body: createBody } }, async (req, reply) => {
    const def = ROLE_DEFS[req.body.type];
    if (!def.carriers.includes(req.body.carrier.kind)) return reply.code(400).send({ error: `un rôle ${def.label} ne peut pas être porté par ce type d'élément` });
    const host = await carrierOf(req.body.carrier);
    if (!host) return reply.code(404).send({ error: 'host not found' });
    const name = req.body.name.trim();
    const c = toConfig(req.body.config, req.body.config.password ?? '');
    const why = def.carrierError(host, c) ?? roleConflict(allRoles(), req.body.type, name, host._id, c);
    if (why) return reply.code(409).send({ error: why });
    const id = newRoleId(name, (x) => allRoles().some((r) => r._id === x));
    if (!ROLE_ID_RE.test(id)) return reply.code(400).send({ error: 'nom invalide' });
    await roles.insertOne({ _id: id, type: req.body.type, name, carrier: { kind: req.body.carrier.kind, id: host._id }, config: c, createdAt: new Date() });
    await rolesSaved([host._id]);
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string }; Body: { carrier?: CarrierBody; name: string; config: ConfigBody } }>('/api/roles/:id', { schema: { body: updateBody } }, async (req, reply) => {
    const current = brokerRole(req.params.id);
    if (!current) return reply.code(404).send({ error: 'rôle inconnu' });
    const def = ROLE_DEFS[current.type];
    if (req.body.carrier && !def.carriers.includes(req.body.carrier.kind)) return reply.code(400).send({ error: `un rôle ${def.label} ne peut pas être porté par ce type d'élément` });
    const host = await carrierOf(req.body.carrier ?? { kind: current.carrier.kind, id: current.carrier.id.toHexString() });
    if (!host) return reply.code(404).send({ error: 'host not found' });
    const name = req.body.name.trim();
    const c = toConfig(req.body.config, req.body.config.password ?? current.config.password);
    const moved = !host._id.equals(current.carrier.id);
    // what the agent detected is checked again only when it changes: a broker stopped for a while stays editable
    const why = (moved || !def.same(current.config, c) ? def.carrierError(host, c) : null) ?? roleConflict(allRoles(), current.type, name, host._id, c, current._id);
    if (why) return reply.code(409).send({ error: why });
    await roles.replaceOne({ _id: current._id }, { ...current, name, carrier: { kind: current.carrier.kind, id: host._id }, config: c });
    await rolesSaved(moved ? [current.carrier.id, host._id] : [host._id]);
    return { id: current._id };
  });

  app.delete<{ Params: { id: string } }>('/api/roles/:id', async (req, reply) => {
    const current = brokerRole(req.params.id);
    if (!current) return reply.code(404).send({ error: 'rôle inconnu' });
    const uses = await ROLE_DEFS[current.type].uses(current._id);
    if (uses.length) return reply.code(409).send({ error: `utilisé par : ${uses.join(', ')}` });
    await roles.deleteOne({ _id: current._id });
    await rolesSaved([current.carrier.id]);
    return reply.code(204).send();
  });

  // connection test of a role being declared or edited
  app.post<{ Body: { type: 'mqtt-broker'; carrier: CarrierBody; config: ConfigBody; roleId?: string } }>('/api/roles/test', { schema: { body: testBody } }, async (req, reply) => {
    const host = await carrierOf(req.body.carrier);
    if (!host) return reply.code(404).send({ error: 'host not found' });
    const url = roleUrl(req.body.config, host.info?.ips);
    if (!url) return { ok: false, error: "adresse de l'hôte inconnue : la saisir" };
    const stored = req.body.roleId ? brokerRole(req.body.roleId) : undefined;
    try {
      await testConnection(url, req.body.config.username, req.body.config.password ?? stored?.config.password ?? '');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}
