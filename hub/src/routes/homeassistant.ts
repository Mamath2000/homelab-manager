import type { FastifyInstance } from 'fastify';
import { settingsDiff } from '../audit.js';
import { loadSites } from '../catalog.js';
import { roles } from '../db.js';
import { bridgeOf, brokerOnline, loadHaBridgeSettings, previewBridge, type HomeAssistantBridges } from '../homeassistant/bridge.js';
import { HA_PRESETS, HA_SECTIONS, normalizeDetail } from '../homeassistant/detail.js';
import { SAFE_URL } from '../hubUrl.js';
import { rolesSaved } from '../roleEvents.js';
import { allRoles, haRoles, newRoleId, roleConflict } from '../roles.js';
import type { HaDetail, HomeAssistantConfig, HomeAssistantRole, MqttBrokerRole } from '../types.js';

// Rôles › Home Assistant (admin, homelab#361): home-assistant roles, carried by the hub, declared, set and removed here.
// Each publishes over MQTT discovery to the broker its Home Assistant is connected to (one role per broker): the whole
// homelab (full) or one site. Its screen sets the level of detail and the grouping by site (full only).

const brokerRoles = () => allRoles().filter((r): r is MqttBrokerRole => r.type === 'mqtt-broker');

const TOPIC = '^[A-Za-z0-9_\\-]+(/[A-Za-z0-9_\\-]+)*$';

const detailBody = {
  type: 'object',
  required: ['level'],
  additionalProperties: false,
  properties: {
    level: { enum: [...Object.keys(HA_PRESETS), 'custom'] },
    sections: { type: 'array', items: { enum: [...HA_SECTIONS] }, maxItems: HA_SECTIONS.length },
  },
} as const;

const roleBody = {
  type: 'object',
  required: ['brokerId', 'mode', 'topic', 'discoveryPrefix'],
  additionalProperties: false,
  properties: {
    // absent or empty: « Home Assistant » (full), « Home Assistant — <site> » (site)
    name: { type: 'string', maxLength: 64 },
    brokerId: { type: 'string', minLength: 1, maxLength: 32 },
    mode: { enum: ['full', 'site'] },
    siteId: { type: 'string', maxLength: 24 },
    topic: { type: 'string', minLength: 1, maxLength: 64, pattern: TOPIC },
    discoveryPrefix: { type: 'string', minLength: 1, maxLength: 64, pattern: TOPIC },
    publicUrl: { type: 'string', maxLength: 256 },
    detail: detailBody,
    groupBySite: { type: 'boolean' },
  },
} as const;

interface RoleBody {
  name?: string;
  brokerId: string;
  mode: 'full' | 'site';
  siteId?: string;
  topic: string;
  discoveryPrefix: string;
  publicUrl?: string;
  detail?: HaDetail;
  groupBySite?: boolean;
}

// null: the role may publish to this broker for this scope, else why not (others: the other home-assistant roles)
export function haError(c: Pick<RoleBody, 'brokerId' | 'mode' | 'siteId' | 'publicUrl'>, brokerIds: Set<string>, siteIds: Set<string>, others: HomeAssistantRole[]) {
  if (!brokerIds.has(c.brokerId)) return `broker inconnu : ${c.brokerId}`;
  if (c.mode === 'site' && !c.siteId) return 'choisir le site publié';
  if (c.mode === 'site' && !siteIds.has(c.siteId!)) return `site inconnu : ${c.siteId}`;
  const owner = others.find((r) => r.config.brokerId === c.brokerId);
  if (owner) return `ce broker est déjà utilisé par le rôle ${owner.name}`;
  const url = (c.publicUrl ?? '').trim().replace(/\/+$/, '');
  if (url && !SAFE_URL.test(url)) return "URL de l'interface invalide (http(s)://hôte[:port][/chemin])";
  return null;
}

// The config of a role from what was typed (current: the role being edited, for what the body leaves out).
export function toHaConfig(c: RoleBody, current?: HomeAssistantConfig): HomeAssistantConfig {
  const groupBySite = c.mode === 'full' && (c.groupBySite ?? current?.groupBySite ?? false);
  return {
    brokerId: c.brokerId,
    mode: c.mode,
    ...(c.mode === 'site' ? { siteId: c.siteId } : {}),
    topic: c.topic,
    discoveryPrefix: c.discoveryPrefix,
    publicUrl: (c.publicUrl ?? current?.publicUrl ?? '').trim().replace(/\/+$/, ''),
    detail: normalizeDetail(c.detail ?? current?.detail),
    ...(groupBySite ? { groupBySite: true } : {}),
  };
}

export const haRoleName = (mode: 'full' | 'site', siteName?: string) => (mode === 'site' && siteName ? `Home Assistant — ${siteName}` : 'Home Assistant');

const IDLE = { state: 'disabled' as const, error: null, devices: 0, lastPublishAt: null };

// the role as its screen shows it, with the state of its bridge and the sections of each level (custom picker)
function dto(r: HomeAssistantRole) {
  const { siteId, groupBySite, ...config } = r.config;
  return { id: r._id, name: r.name, ...config, siteId: siteId ?? null, groupBySite: !!groupBySite, presets: HA_PRESETS, status: bridgeOf(r._id)?.status() ?? IDLE };
}

export function registerHomeAssistantRoutes(app: FastifyInstance, bridges: HomeAssistantBridges) {
  const roleOf = (id: string) => haRoles().find((r) => r._id === id);
  // after a write: the cache, the probes and the bridges ('probe.config'), and this role's bridge before the answer
  const saved = async () => {
    await rolesSaved([]);
    await bridges.sync();
  };

  app.get<{ Params: { id: string } }>('/api/settings/homeassistant/:id', async (req, reply) => {
    const r = roleOf(req.params.id);
    if (!r) return reply.code(404).send({ error: 'rôle Home Assistant inconnu' });
    return dto(r);
  });

  // The broker answers, from the hub (the wizard asks it before saving).
  app.post<{ Body: { brokerId: string } }>(
    '/api/settings/homeassistant/test',
    { schema: { body: { type: 'object', required: ['brokerId'], additionalProperties: false, properties: { brokerId: { type: 'string', minLength: 1, maxLength: 32 } } } } },
    async (req) => {
      const error = await brokerOnline(req.body.brokerId);
      return error ? { ok: false, error } : { ok: true };
    },
  );

  app.post<{ Body: RoleBody }>('/api/settings/homeassistant', { schema: { body: roleBody } }, async (req, reply) => {
    const sites = await loadSites();
    const bad = haError(req.body, new Set(brokerRoles().map((b) => b._id)), new Set(sites.map((s) => s.id)), haRoles());
    if (bad) return reply.code(409).send({ error: bad });
    const offline = await brokerOnline(req.body.brokerId);
    if (offline) return reply.code(409).send({ error: offline });
    const config = toHaConfig(req.body);
    const name = req.body.name?.trim() || haRoleName(config.mode, sites.find((s) => s.id === config.siteId)?.name);
    const why = roleConflict(allRoles(), 'home-assistant', name, null, config);
    if (why) return reply.code(409).send({ error: why });
    const taken = new Set(allRoles().map((r) => r._id));
    const doc: HomeAssistantRole = { _id: newRoleId(name, (id) => taken.has(id)), type: 'home-assistant', name, carrier: { kind: 'hub' }, config, createdAt: new Date() };
    await roles.insertOne(doc);
    req.auditNote = { target: { kind: 'role', id: doc._id, name }, details: { type: doc.type, carrier: 'hub', brokerId: config.brokerId, mode: config.mode, ...(config.siteId ? { siteId: config.siteId } : {}) } };
    await saved();
    return reply.code(201).send(dto(doc));
  });

  app.put<{ Params: { id: string }; Body: RoleBody }>('/api/settings/homeassistant/:id', { schema: { body: roleBody } }, async (req, reply) => {
    const current = roleOf(req.params.id);
    if (!current) return reply.code(404).send({ error: 'rôle Home Assistant inconnu' });
    const sites = await loadSites();
    const bad = haError(req.body, new Set(brokerRoles().map((b) => b._id)), new Set(sites.map((s) => s.id)), haRoles().filter((r) => r._id !== current._id));
    if (bad) return reply.code(409).send({ error: bad });
    // the broker is checked again only when it changes (a role keeps working while its broker is down for a while)
    const offline = req.body.brokerId === current.config.brokerId ? null : await brokerOnline(req.body.brokerId);
    if (offline) return reply.code(409).send({ error: offline });
    const config = toHaConfig(req.body, current.config);
    const name = req.body.name?.trim() || current.name;
    const why = roleConflict(allRoles(), 'home-assistant', name, null, config, current._id);
    if (why) return reply.code(409).send({ error: why });
    const next: HomeAssistantRole = { ...current, name, config };
    await roles.replaceOne({ _id: current._id }, next);
    req.auditNote = { target: { kind: 'role', id: current._id, name }, details: { type: current.type, ...settingsDiff({ name: current.name, ...current.config }, { name, ...config }) } };
    await saved();
    return dto(next);
  });

  // The bridge stops and its devices are removed from that Home Assistant.
  app.delete<{ Params: { id: string } }>('/api/settings/homeassistant/:id', async (req, reply) => {
    const current = roleOf(req.params.id);
    if (!current) return reply.code(404).send({ error: 'rôle Home Assistant inconnu' });
    await roles.deleteOne({ _id: current._id });
    req.auditNote = { target: { kind: 'role', id: current._id, name: current.name }, details: { type: current.type } };
    await saved();
    return reply.code(204).send();
  });

  // entities that a level of detail would publish, for the screen of the role
  app.post<{ Params: { id: string }; Body: { detail?: HaDetail; groupBySite?: boolean } }>(
    '/api/settings/homeassistant/:id/preview',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { detail: detailBody, groupBySite: { type: 'boolean' } } } } },
    async (req, reply) => {
      const s = (await loadHaBridgeSettings()).find((x) => x.roleId === req.params.id);
      if (!s) return reply.code(404).send({ error: 'rôle Home Assistant inconnu' });
      return previewBridge(req.log, { ...s, detail: req.body.detail ? normalizeDetail(req.body.detail) : s.detail, groupBySite: req.body.groupBySite ?? s.groupBySite });
    },
  );

  app.post<{ Params: { id: string } }>('/api/settings/homeassistant/:id/republish', async (req, reply) => {
    if (!roleOf(req.params.id)) return reply.code(404).send({ error: 'rôle Home Assistant inconnu' });
    if (!bridgeOf(req.params.id)?.republish()) return reply.code(409).send({ error: "le rôle n'est pas connecté à son broker" });
    return { ok: true };
  });
}
