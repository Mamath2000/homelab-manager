import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { loadSites, loadTags, normalizeSites, sameName, saveTags } from '../catalog.js';
import { equipments, hosts, settings } from '../db.js';
import { publish } from '../events.js';
import { hostDto } from '../hostDto.js';
import { SITE_FORMATS, SITE_KINDS, TAG_COLORS, type SiteConfig, type SiteFormat, type TagColor } from '../types.js';

const sitesBody = {
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
        properties: {
          id: { type: 'string', maxLength: 24 },
          name: { type: 'string', maxLength: 64 },
          kind: { type: 'string', enum: SITE_KINDS },
          format: { type: 'string', enum: SITE_FORMATS },
          color: { type: 'string', enum: TAG_COLORS },
        },
      },
    },
  },
} as const;

const tagName = { type: 'string', minLength: 1, maxLength: 32 } as const;
const tagColor = { type: 'string', enum: TAG_COLORS } as const;

// Hosts changed behind the interface's back (site or tag removed): their new state to everyone.
async function republish(filter: Parameters<typeof hosts.find>[0]) {
  for (const h of await hosts.find(filter).toArray()) publish('host', hostDto(h));
}

export function registerSiteRoutes(app: FastifyInstance) {
  // read by every account (dashboard, host forms)
  app.get('/api/sites', async () => ({ sites: await loadSites() }));
  app.get('/api/tags', async () => ({ tags: await loadTags() }));

  // the whole list, in display order; a site left out is removed from its hosts and equipment
  app.put<{ Body: { sites: (Omit<SiteConfig, 'id' | 'color' | 'format'> & { id?: string; color?: TagColor; format?: SiteFormat })[] } }>('/api/settings/sites', { schema: { body: sitesBody } }, async (req, reply) => {
    const sites = normalizeSites(req.body.sites);
    if (!sites) return reply.code(400).send({ error: 'un site est indiqué deux fois' });
    await settings.replaceOne({ _id: 'sites' }, { _id: 'sites', sites }, { upsert: true });
    const gone = { siteId: { $exists: true, $nin: sites.map((s) => s.id) } };
    const orphans = await hosts.find(gone, { projection: { _id: 1 } }).toArray();
    if (orphans.length) {
      await hosts.updateMany(gone, { $unset: { siteId: '' } });
      await republish({ _id: { $in: orphans.map((h) => h._id) } });
    }
    const left = await equipments.find(gone, { projection: { _id: 1 } }).toArray();
    if (left.length) {
      await equipments.updateMany(gone, { $unset: { siteId: '' } });
      for (const e of left) publish('equipment', { id: e._id.toHexString() });
    }
    publish('catalog', {});
    return { sites };
  });

  // created from the host forms, with its colour
  app.post<{ Body: { name: string; color: TagColor } }>(
    '/api/tags',
    { schema: { body: { type: 'object', required: ['name', 'color'], additionalProperties: false, properties: { name: tagName, color: tagColor } } } },
    async (req, reply) => {
      const name = req.body.name.trim();
      if (!name) return reply.code(400).send({ error: 'nom du tag vide' });
      const tags = await loadTags();
      if (tags.some((t) => sameName(t.name, name))) return reply.code(409).send({ error: `le tag « ${name} » existe déjà` });
      const tag = { id: new ObjectId().toHexString(), name, color: req.body.color };
      await saveTags([...tags, tag]);
      publish('catalog', {});
      reply.code(201);
      return tag;
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; color?: TagColor } }>(
    '/api/tags/:id',
    { schema: { body: { type: 'object', minProperties: 1, additionalProperties: false, properties: { name: tagName, color: tagColor } } } },
    async (req, reply) => {
      const tags = await loadTags();
      const tag = tags.find((t) => t.id === req.params.id);
      if (!tag) return reply.code(404).send({ error: 'tag introuvable' });
      const name = req.body.name?.trim() ?? tag.name;
      if (!name) return reply.code(400).send({ error: 'nom du tag vide' });
      if (tags.some((t) => t.id !== tag.id && sameName(t.name, name))) return reply.code(409).send({ error: `le tag « ${name} » existe déjà` });
      const next = { ...tag, name, color: req.body.color ?? tag.color };
      await saveTags(tags.map((t) => (t.id === tag.id ? next : t)));
      publish('catalog', {});
      return next;
    },
  );

  // removed from every host
  app.delete<{ Params: { id: string } }>('/api/tags/:id', async (req, reply) => {
    const tags = await loadTags();
    if (!tags.some((t) => t.id === req.params.id)) return reply.code(404).send({ error: 'tag introuvable' });
    await saveTags(tags.filter((t) => t.id !== req.params.id));
    const ids = (await hosts.find({ tags: req.params.id }, { projection: { _id: 1 } }).toArray()).map((h) => h._id);
    if (ids.length) {
      await hosts.updateMany({ _id: { $in: ids } }, { $pull: { tags: req.params.id } });
      await republish({ _id: { $in: ids } });
    }
    publish('catalog', {});
    reply.code(204);
  });
}
