import type { FastifyInstance, FastifyRequest } from 'fastify';
import { settings } from '../db.js';
import { testConnection, type HomeAssistantBridge } from '../homeassistant/bridge.js';
import { AGENT_TARGETS, agentBinary } from '../agentBinaries.js';
import { loadAgentSettings, maybeAutoUpdate } from '../agentUpdate.js';
import { hosts } from '../db.js';
import { SAFE_URL, TAILSCALE_HOST, agentCommands } from '../hubUrl.js';
import { loadPki } from '../pkiStore.js';
import type { HaDetail, HomeAssistantSettings } from '../types.js';
import { DEFAULT_DETAIL, HA_PRESETS, HA_SECTIONS, normalizeDetail } from '../homeassistant/detail.js';

const DEFAULTS: HomeAssistantSettings = {
  _id: 'homeassistant',
  enabled: false,
  broker: '',
  username: '',
  password: '',
  topic: 'homelab-manager',
  discoveryPrefix: 'homeassistant',
  publicUrl: '',
  detail: DEFAULT_DETAIL,
};

export async function loadHomeAssistantSettings() {
  const stored = (await settings.findOne({ _id: 'homeassistant' })) as HomeAssistantSettings | null;
  return { ...DEFAULTS, ...stored, detail: normalizeDetail(stored?.detail) };
}

// the password never leaves the hub
function dto(s: HomeAssistantSettings, bridge: HomeAssistantBridge) {
  const { password, _id, ...rest } = s;
  // presets: sections of each level, for the custom picker
  return { ...rest, hasPassword: !!password, presets: HA_PRESETS, status: bridge.status() };
}

interface Body {
  enabled: boolean;
  broker: string;
  username: string;
  password?: string; // absent: unchanged, "": cleared
  topic: string;
  discoveryPrefix: string;
  publicUrl?: string;
  detail?: HaDetail;
}

const detailBody = {
  type: 'object',
  required: ['level'],
  additionalProperties: false,
  properties: {
    level: { enum: [...Object.keys(HA_PRESETS), 'custom'] },
    sections: { type: 'array', items: { enum: [...HA_SECTIONS] }, maxItems: HA_SECTIONS.length },
  },
} as const;

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
    publicUrl: { type: 'string', maxLength: 256 },
    detail: detailBody,
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
      detail: normalizeDetail(req.body.detail ?? current.detail),
      _id: 'homeassistant',
    };
    next.publicUrl = next.publicUrl.trim().replace(/\/+$/, '');
    if (next.publicUrl && !SAFE_URL.test(next.publicUrl)) return reply.code(400).send({ error: "URL de l'interface invalide (http(s)://hôte[:port][/chemin])" });
    if (next.enabled && !next.broker) return reply.code(400).send({ error: "l'adresse du broker est requise" });
    await settings.replaceOne({ _id: 'homeassistant' }, next, { upsert: true });
    await bridge.apply(next);
    return dto(next, bridge);
  });

  // entities that a level of detail would publish, for the settings page
  app.post<{ Body: { detail: HaDetail } }>(
    '/api/settings/homeassistant/preview',
    { schema: { body: { type: 'object', required: ['detail'], additionalProperties: false, properties: { detail: detailBody } } } },
    async (req) => bridge.preview(normalizeDetail(req.body.detail), await loadHomeAssistantSettings()),
  );

  app.post('/api/settings/homeassistant/republish', async (_req, reply) => {
    if (!bridge.republish()) return reply.code(409).send({ error: "l'intégration n'est pas connectée au broker" });
    return { ok: true };
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
  agentPort?: number;
  tailscaleHub?: string;
}

const agentBody = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    autoUpdate: { type: 'boolean' },
    hubUrl: { type: 'string', maxLength: 256 },
    checkIntervalHours: { type: 'integer', minimum: 0, maximum: 720 },
    agentPort: { type: 'integer', minimum: 1, maximum: 65535 },
    tailscaleHub: { type: 'string', maxLength: 253 },
  },
} as const;

export function registerAgentSettingsRoutes(app: FastifyInstance, bridge: HomeAssistantBridge) {
  const dto = async (req: FastifyRequest) => {
    const { _id, ...s } = await loadAgentSettings();
    const pki = await loadPki();
    const cmd = await agentCommands(req);
    return {
      ...s,
      binaries: AGENT_TARGETS.map((t) => agentBinary(t.arch, t.os)).filter((b) => b !== null),
      // what an admin needs to check the pinned certificates by hand
      tls: {
        agentUrl: cmd?.url ?? null,
        serverPin: pki.serverPin,
        caFingerprint: pki.caFingerprint,
        upgradeCommand: cmd?.upgrade ?? null,
        uninstallCommand: cmd?.uninstall ?? null,
      },
    };
  };

  app.get('/api/settings/agents', (req) => dto(req));

  app.put<{ Body: AgentBody }>('/api/settings/agents', { schema: { body: agentBody } }, async (req, reply) => {
    const current = await loadAgentSettings();
    const next = { ...current, ...req.body };
    next.hubUrl = next.hubUrl.trim().replace(/\/+$/, '');
    if (next.hubUrl && !SAFE_URL.test(next.hubUrl)) return reply.code(400).send({ error: 'URL du hub invalide (http(s)://hôte[:port][/chemin])' });
    next.tailscaleHub = next.tailscaleHub.trim();
    if (next.tailscaleHub && !TAILSCALE_HOST.test(next.tailscaleHub)) return reply.code(400).send({ error: 'adresse Tailscale invalide (nom d\'hôte ou IP, sans http:// ni port)' });
    await settings.replaceOne({ _id: 'agents' }, next, { upsert: true });
    if (next.hubUrl !== current.hubUrl) bridge.refresh();
    if (next.autoUpdate && !current.autoUpdate) {
      for (const h of await hosts.find({}, { projection: { _id: 1 } }).toArray()) await maybeAutoUpdate(h._id);
    }
    return dto(req);
  });
}
