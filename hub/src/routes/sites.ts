import type { FastifyInstance } from 'fastify';
import { hosts, settings } from '../db.js';
import { SITE_KINDS, type SiteConfig, type SitesSettings } from '../types.js';

export async function loadSites(): Promise<SiteConfig[]> {
  const doc = (await settings.findOne({ _id: 'sites' })) as SitesSettings | null;
  return doc?.sites ?? [];
}

// Trimmed names, empty ones dropped, first occurrence of a name kept. null: a name is given twice.
export function normalizeSites(list: SiteConfig[]): SiteConfig[] | null {
  const out: SiteConfig[] = [];
  for (const s of list) {
    const name = s.name.trim();
    if (!name) continue;
    if (out.some((o) => o.name === name)) return null;
    out.push({ name, kind: s.kind });
  }
  return out;
}

const body = {
  type: 'object',
  required: ['sites'],
  additionalProperties: false,
  properties: {
    sites: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        required: ['name', 'kind'],
        additionalProperties: false,
        properties: { name: { type: 'string', maxLength: 64 }, kind: { type: 'string', enum: SITE_KINDS } },
      },
    },
  },
} as const;

export function registerSiteRoutes(app: FastifyInstance) {
  // read by every account (dashboard); the groups of the hosts come along to offer them in the settings
  app.get('/api/sites', async () => ({
    sites: await loadSites(),
    groups: ((await hosts.distinct('group')) as (string | null | undefined)[]).filter((g): g is string => !!g?.trim()).sort(),
  }));

  app.put<{ Body: { sites: SiteConfig[] } }>('/api/settings/sites', { schema: { body } }, async (req, reply) => {
    const sites = normalizeSites(req.body.sites);
    if (!sites) return reply.code(400).send({ error: 'un site est indiqué deux fois' });
    await settings.replaceOne({ _id: 'sites' }, { _id: 'sites', sites }, { upsert: true });
    return { sites };
  });
}
