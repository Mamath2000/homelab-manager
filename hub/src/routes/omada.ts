import type { FastifyInstance } from 'fastify';
import { loadSites } from '../catalog.js';
import { equipments, omada, parseId } from '../db.js';
import { OmadaLinkError, candidatesFor, linkDevice, pollOmada } from '../omadaSync.js';
import { publish } from '../events.js';
import { allRoles } from '../roles.js';
import type { OmadaControllerRole } from '../types.js';

// Paramètres › Omada (admin): the sites and devices of each omada-controller role as the last poll read them, and what the
// admin decides: which site of the homelab each Omada site is, which devices are equipments (created, or linked to a
// manual one). Read by site, as the page shows it.

const roleOf = (id: string) => allRoles().find((r): r is OmadaControllerRole => r._id === id && r.type === 'omada-controller');

export function registerOmadaRoutes(app: FastifyInstance) {
  app.get('/api/settings/omada', async () => {
    const [states, list, sites] = await Promise.all([omada.find().toArray(), equipments.find().toArray(), loadSites()]);
    const byMac = new Map(list.filter((e) => e.source === 'omada').map((e) => [e.externalId!, e]));
    return {
      controllers: allRoles()
        .filter((r): r is OmadaControllerRole => r.type === 'omada-controller')
        .map((r) => {
          const s = states.find((x) => x._id === r._id);
          return {
            id: r._id,
            name: r.name,
            polledAt: s?.polledAt ?? null,
            pollError: s?.pollError ?? null,
            sites: (s?.sites ?? []).map((site) => {
              const siteId = s?.siteMap[site.id] ?? null;
              return {
                id: site.id,
                name: site.name,
                homelabSiteId: siteId && sites.some((x) => x.id === siteId) ? siteId : null,
                devices: (s?.devices ?? [])
                  .filter((d) => d.siteId === site.id)
                  .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
                  .map((d) => {
                    const e = byMac.get(d.mac);
                    return {
                      ...d,
                      equipment: e ? { id: e._id.toHexString(), name: e.name } : null,
                      // manual equipments that could be it (a hub equipment has no MAC: address, then name)
                      candidates: e ? [] : candidatesFor(d, list, siteId ?? undefined).map((c) => ({ id: c._id.toHexString(), name: c.name, ip: c.ip ?? null })),
                    };
                  }),
              };
            }),
          };
        }),
    };
  });

  app.post('/api/settings/omada/poll', async () => {
    await pollOmada(app.log);
    return { ok: true };
  });

  // the site of the homelab an Omada site is ("" : none); the equipments already linked follow at the next poll
  app.put<{ Params: { id: string; siteId: string }; Body: { siteId: string } }>(
    '/api/settings/omada/:id/sites/:siteId',
    { schema: { body: { type: 'object', required: ['siteId'], additionalProperties: false, properties: { siteId: { type: 'string', maxLength: 24 } } } } },
    async (req, reply) => {
      if (!roleOf(req.params.id)) return reply.code(404).send({ error: 'rôle inconnu' });
      const state = await omada.findOne({ _id: req.params.id });
      if (!state?.sites.some((s) => s.id === req.params.siteId)) return reply.code(404).send({ error: 'site Omada inconnu' });
      const target = req.body.siteId;
      if (target && !(await loadSites()).some((s) => s.id === target)) return reply.code(400).send({ error: 'site inconnu' });
      const key = `siteMap.${req.params.siteId}`;
      await omada.updateOne({ _id: req.params.id }, target ? { $set: { [key]: target } } : { $unset: { [key]: '' } });
      await pollOmada(app.log);
      return { ok: true };
    },
  );

  // an Omada device becomes an equipment: created, or linked to the manual one equipmentId
  app.post<{ Params: { id: string }; Body: { mac: string; equipmentId?: string; name?: string } }>(
    '/api/settings/omada/:id/link',
    { schema: { body: { type: 'object', required: ['mac'], additionalProperties: false, properties: { mac: { type: 'string', maxLength: 17 }, equipmentId: { type: 'string', maxLength: 24 }, name: { type: 'string', maxLength: 64 } } } } },
    async (req, reply) => {
      if (!roleOf(req.params.id)) return reply.code(404).send({ error: 'rôle inconnu' });
      const equipmentId = req.body.equipmentId ? parseId(req.body.equipmentId) : undefined;
      if (req.body.equipmentId && !equipmentId) return reply.code(404).send({ error: 'équipement introuvable' });
      try {
        const e = await linkDevice(req.params.id, req.body.mac, equipmentId ?? undefined, req.body.name);
        publish('omada', {});
        return reply.code(201).send({ id: e._id.toHexString() });
      } catch (err) {
        if (err instanceof OmadaLinkError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    },
  );
}
