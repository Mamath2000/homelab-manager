import type { FastifyInstance } from 'fastify';
import { loadSites } from '../catalog.js';
import { equipments, hosts, omada, parseId, probes } from '../db.js';
import { OmadaLinkError, candidatesFor, linkDevice, pollOmada, vpnsOf } from '../omadaSync.js';
import { publish } from '../events.js';
import { allRoles } from '../roles.js';
import { findVpn, measureVpn, vpnCandidates } from '../vpnProbes.js';
import type { OmadaControllerRole, ProbeDoc } from '../types.js';

type VpnProbe = ProbeDoc & { target: Extract<ProbeDoc['target'], { type: 'vpn' }> };

const vpnProbe = async (id: string) => {
  const _id = parseId(id);
  const p = _id && (await probes.findOne({ _id, 'target.type': 'vpn' }));
  return (p || null) as VpnProbe | null;
};

const candidatesOf = async (p: VpnProbe) => {
  const v = await findVpn(p.target);
  if (!v) return null;
  const [hostList, equipmentList] = await Promise.all([
    hosts.find({}, { projection: { name: 1, 'info.ips': 1, capabilities: 1 } }).toArray(),
    equipments.find({}, { projection: { name: 1, ip: 1, type: 1 } }).toArray(),
  ]);
  return { vpn: v, ...vpnCandidates(v, hostList, equipmentList) };
};

const selectionBody = {
  type: 'object',
  required: ['sourceHostId', 'host'],
  additionalProperties: false,
  properties: { sourceHostId: { type: 'string', maxLength: 24 }, host: { type: 'string', maxLength: 253 } },
} as const;

interface Selection {
  sourceHostId: string;
  host: string;
}

// Paramètres › Omada (admin): the sites and devices of each omada-controller role as the last poll read them, and what the
// admin decides: which site of the homelab each Omada site is, which devices are equipments (created, or linked to a
// manual one). Read by site, as the page shows it.

const roleOf = (id: string) => allRoles().find((r): r is OmadaControllerRole => r._id === id && r.type === 'omada-controller');

export function registerOmadaRoutes(app: FastifyInstance) {
  app.get('/api/settings/omada', async () => {
    const [states, list, sites, vpnProbes] = await Promise.all([omada.find().toArray(), equipments.find().toArray(), loadSites(), probes.find({ 'target.type': 'vpn' }).toArray() as Promise<VpnProbe[]>]);
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
            vpnError: s?.vpnError ?? null,
            // site-to-site VPNs, with the gateway that carries each (its equipment, when it is one)
            vpns: (s?.vpns ?? []).map((v) => {
              const gw = (s?.devices ?? []).find((d) => vpnsOf(d, [{ ...v, enabled: true }]).length);
              const e = gw && byMac.get(gw.mac);
              const p = vpnProbes.find((x) => x.target.roleId === r._id && x.target.vpnId === v.id);
              return {
                ...v,
                probe: p ? { id: p._id.toHexString(), name: p.name, state: p.state ?? 'unknown', message: p.message ?? null, configured: p.runFrom !== 'hub' && !!p.target.host } : null,
                siteName: s?.sites.find((x) => x.id === v.siteId)?.name ?? v.siteId,
                gateway: gw ? { mac: gw.mac, name: gw.name, equipment: e ? { id: e._id.toHexString(), name: e.name } : null } : null,
              };
            }),
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

  // a VPN probe with its tunnel and the hosts and equipments it may ping from and to (filtered by address)
  app.get<{ Params: { id: string } }>('/api/settings/omada/vpn-probes/:id', async (req, reply) => {
    const p = await vpnProbe(req.params.id);
    if (!p) return reply.code(404).send({ error: 'sonde VPN introuvable' });
    const c = await candidatesOf(p);
    if (!c) return reply.code(404).send({ error: 'tunnel inconnu du dernier relevé Omada' });
    return {
      probe: { id: p._id.toHexString(), name: p.name, sourceHostId: p.runFrom === 'hub' ? '' : p.runFrom.hostId.toHexString(), host: p.target.host, state: p.state ?? 'unknown', message: p.message ?? null },
      vpn: c.vpn,
      sources: c.sources,
      targets: c.targets,
    };
  });

  // the source and the target chosen ('' : still to choose); only candidates are accepted
  app.put<{ Params: { id: string }; Body: Selection }>('/api/settings/omada/vpn-probes/:id', { schema: { body: selectionBody } }, async (req, reply) => {
    const p = await vpnProbe(req.params.id);
    if (!p) return reply.code(404).send({ error: 'sonde VPN introuvable' });
    const c = await candidatesOf(p);
    if (!c) return reply.code(404).send({ error: 'tunnel inconnu du dernier relevé Omada' });
    const { sourceHostId, host } = req.body;
    if (sourceHostId && !c.sources.some((x) => x.id === sourceHostId)) return reply.code(400).send({ error: 'source hors des réseaux locaux du tunnel' });
    if (host && !c.targets.some((x) => x.ip === host)) return reply.code(400).send({ error: 'cible hors des réseaux distants du tunnel' });
    const runFrom = sourceHostId ? { hostId: parseId(sourceHostId)! } : 'hub';
    await probes.updateOne({ _id: p._id }, { $set: { runFrom, 'target.host': host }, $unset: { state: '', since: '', message: '' } });
    publish('probe.config', {});
    return { ok: true };
  });

  // measures a choice of source and target without saving it
  app.post<{ Params: { id: string }; Body: Selection }>('/api/settings/omada/vpn-probes/:id/test', { schema: { body: selectionBody } }, async (req, reply) => {
    const p = await vpnProbe(req.params.id);
    if (!p) return reply.code(404).send({ error: 'sonde VPN introuvable' });
    const id = req.body.sourceHostId ? parseId(req.body.sourceHostId) : null;
    if (req.body.sourceHostId && !id) return reply.code(400).send({ error: 'hôte source inconnu' });
    return measureVpn({ target: { ...p.target, host: req.body.host }, timeoutSec: p.timeoutSec, runFrom: id ? { hostId: id } : 'hub' });
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
