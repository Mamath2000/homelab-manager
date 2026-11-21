import type { FastifyInstance, FastifyRequest } from 'fastify';
import { settingsDiff } from '../audit.js';
import { settings } from '../db.js';
import type { HomeAssistantBridges } from '../homeassistant/bridge.js';
import { AGENT_TARGETS, agentBinary } from '../agentBinaries.js';
import { loadAgentSettings, maybeAutoUpdate } from '../agentUpdate.js';
import { hosts } from '../db.js';
import { SAFE_URL, TAILSCALE_HOST, agentCommands } from '../hubUrl.js';
import { loadPki } from '../pkiStore.js';

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

export function registerAgentSettingsRoutes(app: FastifyInstance, bridges: HomeAssistantBridges) {
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
    req.auditNote = { details: settingsDiff(current, next) };
    if (next.hubUrl !== current.hubUrl) bridges.refresh();
    if (next.autoUpdate && !current.autoUpdate) {
      for (const h of await hosts.find({}, { projection: { _id: 1 } }).toArray()) await maybeAutoUpdate(h._id);
    }
    return dto(req);
  });
}
