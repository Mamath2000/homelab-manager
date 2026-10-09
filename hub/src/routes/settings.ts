import type { FastifyInstance } from 'fastify';
import { settings } from '../db.js';
import { testConnection, type HomeAssistantBridge } from '../homeassistant/bridge.js';
import { AGENT_ARCHES, agentBinary } from '../agentBinaries.js';
import { loadAgentSettings, maybeAutoUpdate } from '../agentUpdate.js';
import { hosts } from '../db.js';
import { SAFE_URL } from '../hubUrl.js';
import type { HomeAssistantSettings } from '../types.js';

const DEFAULTS: HomeAssistantSettings = {
  _id: 'homeassistant',
  enabled: false,
  broker: '',
  username: '',
  password: '',
  topic: 'homelab-manager',
  discoveryPrefix: 'homeassistant',
};

export async function loadHomeAssistantSettings() {
  return { ...DEFAULTS, ...((await settings.findOne({ _id: 'homeassistant' })) as HomeAssistantSettings | null) };
}

// the password never leaves the hub
function dto(s: HomeAssistantSettings, bridge: HomeAssistantBridge) {
  const { password, _id, ...rest } = s;
  return { ...rest, hasPassword: !!password, status: bridge.status() };
}

interface Body {
  enabled: boolean;
  broker: string;
  username: string;
  password?: string; // absent: unchanged, "": cleared
  topic: string;
  discoveryPrefix: string;
}

const TOPIC = '^[A-Za-z0-9_\\-]+(/[A-Za-z0-9_\\-]+)*$';
const body = {
  type: 'object',
  required: ['enabled', 'broker', 'username', 'topic', 'discoveryPrefix'],
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    broker: { type: 'string', maxLength: 256, pattern: '^$|^(mqtts?|wss?)://[^\\s]+$' },
    username: { type: 'string', maxLength: 128 },
    password: { type: 'string', maxLength: 256 },
    topic: { type: 'string', minLength: 1, maxLength: 64, pattern: TOPIC },
    discoveryPrefix: { type: 'string', minLength: 1, maxLength: 64, pattern: TOPIC },
  },
} as const;

export function registerSettingsRoutes(app: FastifyInstance, bridge: HomeAssistantBridge) {
  app.get('/api/settings/homeassistant', async () => dto(await loadHomeAssistantSettings(), bridge));

  app.put<{ Body: Body }>('/api/settings/homeassistant', { schema: { body } }, async (req, reply) => {
    const current = await loadHomeAssistantSettings();
    const next: HomeAssistantSettings = {
      ...current,
      ...req.body,
      password: req.body.password ?? current.password,
      _id: 'homeassistant',
    };
    if (next.enabled && !next.broker) return reply.code(400).send({ error: "l'adresse du broker est requise" });
    await settings.replaceOne({ _id: 'homeassistant' }, next, { upsert: true });
    await bridge.apply(next);
    return dto(next, bridge);
  });

  app.post<{ Body: Body }>('/api/settings/homeassistant/test', { schema: { body } }, async (req, reply) => {
    if (!req.body.broker) return reply.code(400).send({ error: "l'adresse du broker est requise" });
    const current = await loadHomeAssistantSettings();
    try {
      await testConnection(req.body.broker, req.body.username, req.body.password ?? current.password);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}

// Agents: automatic update, hub URL, apt-get update interval and the binaries the hub distributes.
interface AgentBody {
  autoUpdate?: boolean;
  hubUrl?: string;
  checkIntervalHours?: number;
}

const agentBody = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    autoUpdate: { type: 'boolean' },
    hubUrl: { type: 'string', maxLength: 256 },
    checkIntervalHours: { type: 'integer', minimum: 0, maximum: 720 },
  },
} as const;

export function registerAgentSettingsRoutes(app: FastifyInstance, bridge: HomeAssistantBridge) {
  const dto = async () => {
    const { _id, ...s } = await loadAgentSettings();
    return { ...s, binaries: AGENT_ARCHES.map((a) => agentBinary(a)).filter((b) => b !== null) };
  };

  app.get('/api/settings/agents', dto);

  app.put<{ Body: AgentBody }>('/api/settings/agents', { schema: { body: agentBody } }, async (req, reply) => {
    const current = await loadAgentSettings();
    const next = { ...current, ...req.body };
    next.hubUrl = next.hubUrl.trim().replace(/\/+$/, '');
    if (next.hubUrl && !SAFE_URL.test(next.hubUrl)) return reply.code(400).send({ error: 'URL du hub invalide (http(s)://hôte[:port][/chemin])' });
    await settings.replaceOne({ _id: 'agents' }, next, { upsert: true });
    if (next.hubUrl !== current.hubUrl) bridge.refresh();
    if (next.autoUpdate && !current.autoUpdate) {
      for (const h of await hosts.find({}, { projection: { _id: 1 } }).toArray()) await maybeAutoUpdate(h._id);
    }
    return dto();
  });
}
