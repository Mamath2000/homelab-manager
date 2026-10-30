import type { FastifyInstance } from 'fastify';
import { backupJobs, backups, guests, hosts, jobs, parseId, settings } from '../db.js';
import { isOnline, refreshAgent } from '../agents.js';
import { publish } from '../events.js';
import {
  FINGERPRINT_RE,
  PBS_URL_RE,
  backupDto,
  orphanDto,
  fetchFingerprint,
  MAX_RETRY_HOURS,
  loadPbsSettings,
  normalizeFingerprint,
  pbsConnected,
  pbsGet,
  pollPbs,
} from '../pbs.js';
import { CLUSTER_ID_RE, PVE_TOKEN_ID_RE, PveLinkError, followedCluster, forgetPveLink, loadPveSettings, nodeHosts, pollPve, pveClusterOf, pveGet, removePveCluster, restorePveLink, savePveCluster } from '../pve.js';
import { describeCalendar, validTimeZone } from '../calendar.js';
import { normalizeMountRoot } from '../pbsMount.js';
import { IMAGE_RE, refreshManaged, syncAll } from '../backupJobs.js';
import { statsView, usageView } from '../pbsStats.js';
import { PBS_TOKEN_ACLS, PbsAgentError, checkLink, detectPbsOn, ensurePbsToken, sameLink } from '../pbsAgent.js';
import { nodeCarrier, staticEligibility, staticNodeEligibility, PveInstallError } from '../pveInstall.js';
import { hasAgent, planInstall, runInstall } from '../pveInstallRun.js';
import { PveAgentError, deletePveToken, detectPveOn, ensurePveToken } from '../pveAgent.js';
import { disconnectMain, remoteConfigured } from '../disconnect.js';
import { loadRemoteSettings, pollOffsite, remoteReady, seriesView, syncOffsiteAgent } from '../offsite.js';
import { OFF_PBS_SOURCES, type PbsAgentLink, type PbsSettings, type PveCluster } from '../types.js';

// the token secret never leaves the hub
function settingsDto(s: PbsSettings) {
  const { _id, tokenSecret, ...rest } = s;
  return { ...rest, hasSecret: !!tokenSecret, connected: pbsConnected(s) };
}

// A node of a cluster the hub already follows (through another entry) is refused: its guests would be listed twice
// and their MACs ambiguous.
async function pveAlreadyFollowed(clusters: PveCluster[], hostId: string, exceptId: string) {
  const ids = [hostId, ...clusters.flatMap((c) => (c.agent && c.id !== exceptId ? [c.agent.hostId] : []))];
  const docs = await hosts.find({ _id: { $in: ids.flatMap((i) => parseId(i) ?? []) } }, { projection: { capabilities: 1 } }).toArray();
  const caps = new Map(docs.map((d) => [d._id.toHexString(), d.capabilities]));
  const c = followedCluster(clusters, (i) => caps.get(i), caps.get(hostId), exceptId);
  return c ? `ce cluster est déjà suivi (${c.name}) : modifier cette entrée plutôt que d’en ajouter une` : null;
}

// The role of a cluster moves only to another node of the same corosync cluster: they share the users, so the
// token of the hub holds there too. null: allowed (or not a move), else why not.
async function pveMoveError(current: PveCluster | undefined, hostId: string) {
  if (!current?.agent || current.agent.hostId === hostId) return null;
  const ids = [current.agent.hostId, hostId].flatMap((i) => parseId(i) ?? []);
  const docs = await hosts.find({ _id: { $in: ids } }, { projection: { capabilities: 1 } }).toArray();
  const of = (i: string) => pveClusterOf(docs.find((d) => d._id.toHexString() === i)?.capabilities);
  const from = of(current.agent.hostId);
  return from && from === of(hostId) ? null : `ce nœud n'est pas du cluster ${current.name} : le jeton du hub n'y vaut pas`;
}

// The token is not part of the form: only the agent of the PBS creates it (POST /api/settings/pbs/token).
interface SettingsBody {
  url: string;
  fingerprint: string;
  agent?: PbsAgentLink;
  tailscaleUrl?: string;
  clientImage?: string;
  mountRoot?: string;
  retryAfterHours?: number;
}

const agentLinkSchema = {
  type: 'object',
  required: ['hostId', 'mode'],
  additionalProperties: false,
  properties: { hostId: { type: 'string', maxLength: 24 }, mode: { type: 'string', enum: ['native', 'container'] }, container: { type: 'string', maxLength: 128 } },
} as const;

const settingsBody = {
  type: 'object',
  additionalProperties: false,
  required: ['url', 'fingerprint'],
  properties: {
    url: { type: 'string', maxLength: 256 },
    fingerprint: { type: 'string', maxLength: 128 },
    agent: agentLinkSchema,
    clientImage: { type: 'string', maxLength: 256 },
    tailscaleUrl: { type: 'string', maxLength: 256 },
    mountRoot: { type: 'string', maxLength: 256 },
    retryAfterHours: { type: 'number', minimum: 0, maximum: MAX_RETRY_HOURS },
  },
} as const;

// Merges the body with the stored settings and validates it; error message or the settings.
async function resolve(body: SettingsBody): Promise<PbsSettings | string> {
  const current = await loadPbsSettings();
  const next: PbsSettings = {
    ...current,
    ...body,
    url: body.url.trim().replace(/\/+$/, ''),
    fingerprint: body.fingerprint ? normalizeFingerprint(body.fingerprint) : '',
    _id: 'pbs',
  };
  next.tailscaleUrl = (body.tailscaleUrl ?? current.tailscaleUrl ?? '').trim().replace(/\/+$/, '');
  const mountRoot = normalizeMountRoot(body.mountRoot ?? current.mountRoot ?? '/srv/pbs-restore');
  if (!mountRoot) return 'racine de montage invalide (chemin absolu différent de /)';
  next.mountRoot = mountRoot;
  if (next.tailscaleUrl && !PBS_URL_RE.test(next.tailscaleUrl)) return 'URL Tailscale invalide (https://100.x.y.z:8007)';
  if (next.url && !PBS_URL_RE.test(next.url)) return 'URL invalide (https://pbs:8007)';
  if (next.fingerprint && !FINGERPRINT_RE.test(next.fingerprint)) return 'empreinte invalide (SHA-256, 32 octets en hexadécimal)';
  if (next.agent) {
    const bad = checkLink(next.agent);
    if (bad) return bad;
    if (next.agent.mode === 'native') delete next.agent.container;
  }
  if (next.retryAfterHours !== undefined && !(Number.isFinite(next.retryAfterHours) && next.retryAfterHours >= 0 && next.retryAfterHours <= MAX_RETRY_HOURS)) return `rejeu : 0 à ${MAX_RETRY_HOURS} heures`;
  if (next.clientImage) next.clientImage = next.clientImage.trim();
  if (next.clientImage && !IMAGE_RE.test(next.clientImage)) return 'image du client invalide (dépôt/nom:tag)';
  return next;
}

export function registerBackupRoutes(app: FastifyInstance) {
  // --- settings (admin: /api/settings/*)
  app.get('/api/settings/pbs', async () => settingsDto(await loadPbsSettings()));

  app.put<{ Body: SettingsBody }>('/api/settings/pbs', { schema: { body: settingsBody } }, async (req, reply) => {
    const next = await resolve(req.body);
    if (typeof next === 'string') return reply.code(400).send({ error: next });
    await settings.replaceOne({ _id: 'pbs' }, next, { upsert: true });
    if (pbsConnected(next)) pollPbs(req.log).catch(() => {});
    else publish('backups', {});
    // server, fingerprint and image are part of the definition the agents run
    refreshManaged()
      .then(syncAll)
      .catch((err) => req.log.warn({ err }, 'backup sync failed'));
    // the second pass of the copies is part of the definition of the agent of the secondary
    syncOffsiteAgent().catch((err) => req.log.warn({ err }, 'offsite series definition not sent'));
    return settingsDto(next);
  });

  app.post<{ Body: SettingsBody }>('/api/settings/pbs/test', { schema: { body: settingsBody } }, async (req, reply) => {
    const next = await resolve(req.body);
    if (typeof next === 'string') return reply.code(400).send({ error: next });
    if (!next.url || !next.tokenSecret) return reply.code(400).send({ error: "URL et jeton requis : créer le jeton avec l'agent du PBS" });
    const probe = async (url: string) => {
      try {
        const stores = await pbsGet<{ store: string }[]>({ ...next, url }, '/admin/datastore');
        return { ok: true, datastores: stores.map((d) => d.store) };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    };
    // the Tailscale address is not tried: the hub only receives on the tailnet (the web UI says so)
    return probe(next.url);
  });

  app.post<{ Body: { url: string } }>(
    '/api/settings/pbs/fingerprint',
    { schema: { body: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string', maxLength: 256 } } } } },
    async (req, reply) => {
      const url = req.body.url.trim().replace(/\/+$/, '');
      if (!PBS_URL_RE.test(url)) return reply.code(400).send({ error: 'URL invalide (https://pbs:8007)' });
      try {
        return { fingerprint: await fetchFingerprint(url) };
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );

  // PBS of a host, found by its agent: mode (native / container), version, datastores, address, fingerprint.
  app.post<{ Body: { hostId: string } }>(
    '/api/settings/pbs/detect',
    { schema: { body: { type: 'object', required: ['hostId'], additionalProperties: false, properties: { hostId: { type: 'string', maxLength: 24 } } } } },
    async (req, reply) => {
      try {
        return await detectPbsOn(req.body.hostId);
      } catch (err) {
        if (err instanceof PbsAgentError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    },
  );

  // Monitoring token created by the agent of the PBS, saved at once with the agent it was created with.
  app.post<{ Body: { agent: PbsAgentLink; tokenId: string } }>(
    '/api/settings/pbs/token',
    {
      schema: {
        body: { type: 'object', required: ['agent', 'tokenId'], additionalProperties: false, properties: { agent: agentLinkSchema, tokenId: { type: 'string', maxLength: 128 } } },
      },
    },
    async (req, reply) => {
      const current = await loadPbsSettings();
      const agent: PbsAgentLink = req.body.agent.mode === 'native' ? { hostId: req.body.agent.hostId, mode: 'native' } : req.body.agent;
      let t;
      try {
        t = await ensurePbsToken(agent, req.body.tokenId.trim(), PBS_TOKEN_ACLS.monitor, sameLink(current.agent, agent) ? current : null);
      } catch (err) {
        if (err instanceof PbsAgentError) return reply.code(409).send({ error: err.message });
        throw err;
      }
      await settings.updateOne({ _id: 'pbs' }, { $set: { agent, tokenId: t.tokenId, tokenSecret: t.tokenSecret } }, { upsert: true });
      req.log.info({ tokenId: t.tokenId, created: t.created, rotated: t.rotated, applied: t.applied, removed: t.removed }, 'PBS monitoring token set by the agent');
      pollPbs(req.log).catch(() => {});
      publish('backups', {});
      return { settings: settingsDto(await loadPbsSettings()), created: t.created, rotated: t.rotated, applied: t.applied, removed: t.removed };
    },
  );

  // What a disconnection of the main PBS removes (its confirmation lists it).
  app.get('/api/settings/pbs/disconnect', async () => {
    const [s, r] = await Promise.all([loadPbsSettings(), loadRemoteSettings()]);
    const withJobs = await backupJobs.distinct('hostId');
    const list = await hosts
      .find({ $or: [{ pbsCredential: { $exists: true } }, { nextcloud: { $ne: null } }, { _id: { $in: withJobs } }] }, { projection: { name: 1, pbsCredential: 1, nextcloud: 1 } })
      .toArray();
    return {
      monitorToken: s.tokenId || null,
      remote: remoteConfigured(r) ? { host: r.url ? new URL(r.url).hostname : null, tokenId: r.tokenId || null, readerTokenId: r.readerTokenId || null } : null,
      hosts: await Promise.all(
        list.map(async (h) => ({
          name: h.name,
          tokenId: h.pbsCredential?.tokenId ?? null,
          jobs: await backupJobs.countDocuments({ hostId: h._id, 'plugin.name': { $ne: 'nextcloud' } }),
          nextcloud: !!h.nextcloud,
        })),
      ),
      groups: await backups.countDocuments({ source: { $nin: [...OFF_PBS_SOURCES] } }),
    };
  });

  // Disconnection of the main PBS, and of the secondary with it (disconnect.ts).
  app.post('/api/settings/pbs/disconnect', async (req, reply) => {
    const s = await loadPbsSettings();
    if (!s.url && !s.tokenId) return reply.code(409).send({ error: 'aucun PBS principal configuré' });
    try {
      return await disconnectMain(req.log);
    } catch (err) {
      if (err instanceof PbsAgentError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  // --- groups (every profile reads)
  app.get('/api/backups', async () => {
    const s = await loadPbsSettings();
    const list = await backups.find().sort({ store: 1, ns: 1, backupId: 1 }).toArray();
    const r = await loadRemoteSettings();
    // jobs set aside when the main PBS was disconnected (to restore from the host card)
    const cachedHosts = await hosts.find({ 'backupCache.jobs.0': { $exists: true } }, { projection: { name: 1, backupCache: 1 } }).toArray();
    return {
      // secondary PBS of the copies, for every profile (its settings are admin only): where and how much room
      offsite: remoteReady(r)
        ? { host: new URL(r.url).hostname, store: r.store, polledAt: r.polledAt ?? null, pollError: r.pollError ?? null, usage: r.usage ?? null, series: await seriesView(r) }
        : null,
      // main PBS connected: its groups, datastores and the jobs of the hosts; the backups of Home Assistant
      // and the Proxmox VE clusters are shown without it
      connected: pbsConnected(s),
      polledAt: s.polledAt ?? null,
      pollError: s.pollError ?? null,
      statsError: s.statsError ?? null,
      datastores: s.datastores ?? [],
      clusters: (await loadPveSettings()).clusters.map((c) => ({ id: c.id, name: c.name, polledAt: c.polledAt ?? null, pollError: c.pollError ?? null, guests: c.guests ?? 0 })),
      // followed: the groups attached to a host; the others are only listed, to be attached
      groups: list.filter((b) => b.hostId).map((b) => backupDto(b)),
      orphans: list.filter((b) => !b.hostId).map(orphanDto),
      cached: cachedHosts.flatMap((h) =>
        (h.backupCache?.jobs ?? []).map((j) => ({
          id: j._id.toHexString(),
          hostId: h._id.toHexString(),
          name: j.name,
          store: j.store,
          ns: j.ns,
          backupId: j.backupId,
          schedule: j.schedule,
          connectEveryDays: j.connectEveryDays ?? null,
          enabled: j.enabled,
          at: h.backupCache!.at,
        })),
      ),
    };
  });

  // what the backups uploaded and how long they took, per day over 30 or 60 days and per group (every profile reads)
  // (30 to 180 days: the weeks and months of the page are added up from the days)
  app.get<{ Querystring: { days?: 30 | 60 | 90 | 180 } }>('/api/backups/stats', { schema: { querystring: { type: 'object', properties: { days: { type: 'integer', enum: [30, 60, 90, 180] } } } } }, async (req) => statsView(req.query.days ?? 30));

  // fill level of the datastores of the main PBS and of the secondary one, per day (every profile reads)
  app.get('/api/backups/usage', async () => usageView(90));

  app.post('/api/backups/refresh', async (req, reply) => {
    // Home Assistant backups: read again by their agents meanwhile (an agent that fails keeps its last report)
    const ha = await hosts.find({ capabilities: { $all: ['ha_backups', 'refresh'] } }, { projection: { _id: 1 } }).toArray();
    const agents = Promise.allSettled(ha.map((h) => h._id.toHexString()).filter(isOnline).map((id) => refreshAgent(id, ['ha_backups'])));
    await pollPbs(req.log);
    await pollPve(req.log);
    // copies on the secondary PBS (their verification included): its errors stay on its own settings
    await pollOffsite(req.log);
    await agents;
    const after = await loadPbsSettings();
    if (pbsConnected(after) && after.pollError) return reply.code(502).send({ error: after.pollError });
    return { ok: true };
  });

  // host of a group (null: detached) and own threshold, from the list of the backups page (admin)
  app.patch<{ Params: { id: string }; Body: { hostId?: string | null; staleHours?: number | null } }>(
    '/api/backups/:id',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            hostId: { type: ['string', 'null'], maxLength: 24 },
            staleHours: { type: ['integer', 'null'], minimum: 1, maximum: 24 * 60 },
          },
        },
      },
    },
    async (req, reply) => {
      const b = await backups.findOne({ _id: req.params.id });
      if (!b) return reply.code(404).send({ error: 'sauvegarde introuvable' });
      if (req.body.hostId !== undefined && b.source) {
        const why = { vzdump: 'sauvegarde rattachée automatiquement par Proxmox VE', managed: 'sauvegarde écrite par un job du hub : rattachée à son hôte', haos: 'sauvegarde Home Assistant : rattachée à son hôte HAOS', 'pve-storage': 'sauvegarde rattachée automatiquement par Proxmox VE' };
        return reply.code(409).send({ error: why[b.source] });
      }
      const set: Record<string, unknown> = {};
      if (req.body.hostId !== undefined) {
        if (req.body.hostId === null) set.hostId = null;
        else {
          const _id = parseId(req.body.hostId);
          if (!_id || !(await hosts.findOne({ _id }, { projection: { _id: 1 } }))) return reply.code(400).send({ error: 'hôte introuvable' });
          set.hostId = _id;
        }
      }
      if (req.body.staleHours !== undefined) set.staleHours = req.body.staleHours;
      await backups.updateOne({ _id: b._id }, { $set: set });
      publish('backups', {});
      return backupDto((await backups.findOne({ _id: b._id }))!);
    },
  );

  // Backups of a host, chosen on its page: these groups are attached to it (moved from another host
  // if need be), the ones it had and that are not in the list become orphans (admin).
  app.put<{ Params: { id: string }; Body: { ids: string[] } }>(
    '/api/hosts/:id/backups',
    {
      schema: {
        body: {
          type: 'object',
          required: ['ids'],
          additionalProperties: false,
          properties: { ids: { type: 'array', maxItems: 500, uniqueItems: true, items: { type: 'string', maxLength: 512 } } },
        },
      },
    },
    async (req, reply) => {
      const _id = parseId(req.params.id);
      if (!_id || !(await hosts.findOne({ _id }, { projection: { _id: 1 } }))) return reply.code(404).send({ error: 'host not found' });
      const found = await backups.countDocuments({ _id: { $in: req.body.ids } });
      if (found !== req.body.ids.length) return reply.code(400).send({ error: 'sauvegarde introuvable' });
      // groups attached by Proxmox VE or written by a job of the hub are left as they are
      const manual = { source: { $exists: false } };
      await backups.updateMany({ ...manual, hostId: _id, _id: { $nin: req.body.ids } }, { $set: { hostId: null } });
      await backups.updateMany({ ...manual, _id: { $in: req.body.ids } }, { $set: { hostId: _id } });
      publish('backups', {});
      return (await backups.find({ hostId: _id }).toArray()).map((b) => backupDto(b));
    },
  );

  // an orphan no longer on the PBS (gone) can be forgotten (admin)
  app.delete<{ Params: { id: string } }>('/api/backups/:id', async (req, reply) => {
    const res = await backups.deleteOne({ _id: req.params.id, gone: true, hostId: null });
    if (!res.deletedCount) return reply.code(409).send({ error: 'seule une sauvegarde orpheline disparue du PBS peut être oubliée' });
    publish('backups', {});
    return reply.code(204).send();
  });

  // --- Proxmox VE clusters (admin: /api/settings/*); the token secrets never leave the hub. A cluster is
  // declared from one of its nodes, whose agent creates the token (POST …/token): nothing is pasted.
  app.get('/api/settings/pve', async () => {
    const s = await loadPveSettings();
    return { clusters: s.clusters.map(pveDto) };
  });

  // Inventory of the clusters (Paramètres › Proxmox VE): their nodes with the agent on each, their guests with the host
  // each one is (or why none), their jobs. Nothing about health or backup results: that is the subject of the hosts.
  app.get('/api/settings/pve/inventory', async () => {
    const s = await loadPveSettings();
    const all = await guests.find().sort({ node: 1, vmid: 1 }).toArray();
    const list = await hosts.find({}, { projection: { name: 1, capabilities: 1, 'info.hostname': 1, certFingerprint: 1, tokenHash: 1 } }).toArray();
    const names = new Map(list.map((h) => [h._id.toHexString(), h.name]));
    const agentOf = new Map(list.map((h) => [h._id.toHexString(), hasAgent(h)]));
    const installing = new Set((await jobs.find({ action: 'agent_install', status: 'running' }, { projection: { installTarget: 1 } }).toArray()).map((j) => (j.installTarget?.node ? `${j.installTarget.cluster}/node/${j.installTarget.node}` : `${j.installTarget?.cluster}/${j.installTarget?.vmid}`)));
    const carrierOf = (h?: (typeof list)[number] | null) => (h ? { capabilities: h.capabilities, online: isOnline(h._id.toHexString()) } : null);
    return {
      clusters: s.clusters.map((c) => {
        const mine = all.filter((g) => g.cluster === c.id);
        const nodes = c.nodes ?? [...new Set(mine.map((g) => g.node))].sort().map((node) => ({ node, online: true }));
        const carriers = nodeHosts(c, nodes.map((n) => n.node), list);
        return {
          id: c.id,
          name: c.name,
          url: c.url,
          carrier: c.agent ? { id: c.agent.hostId, name: names.get(c.agent.hostId) ?? '' } : null,
          polledAt: c.polledAt ?? null,
          pollError: c.pollError ?? null,
          nodes: nodes.map((n) => {
            const h = carriers.get(n.node);
            const other = nodeCarrier(n.node, carriers, (x) => isOnline(x._id.toHexString()));
            return {
              ...n,
              host: h ? { id: h._id.toHexString(), name: h.name, online: isOnline(h._id.toHexString()), hasAgent: !!agentOf.get(h._id.toHexString()) } : null,
              installing: installing.has(`${c.id}/node/${n.node}`),
              install: h && agentOf.get(h._id.toHexString()) ? null : staticNodeEligibility({ online: n.online, hostHasAgent: false }, carrierOf(other)),
            };
          }),
          guests: mine.map((g) => ({
            installing: installing.has(`${c.id}/${g.vmid}`),
            install: g.type === 'lxc' && !(g.hostId && agentOf.get(g.hostId)) ? staticEligibility(g, carrierOf(carriers.get(g.node)), false) : null,
            vmid: g.vmid,
            type: g.type,
            name: g.name,
            node: g.node,
            status: g.status ?? 'unknown',
            host: g.hostId ? { id: g.hostId, name: names.get(g.hostId) ?? '', hasAgent: !!agentOf.get(g.hostId) } : null,
            ambiguous: !!g.ambiguous,
            jobs: g.jobs.map((j) => ({ id: j.id, enabled: j.enabled, storage: j.storage, nextRun: j.nextRun, scheduleText: describeCalendar(j.schedule) })),
          })),
        };
      }),
    };
  });

  // Agent installed in CT of the inventory (homelab#259), by the agent of their node. dryRun: the plan only (eligibility of
  // each CT checked by the agent of its node, host each one would become), nothing is written.
  app.post<{ Body: { cluster: string; vmids?: number[]; nodes?: string[]; dryRun?: boolean } }>(
    '/api/settings/pve/install',
    {
      schema: {
        body: {
          type: 'object',
          required: ['cluster'],
          additionalProperties: false,
          properties: {
            cluster: { type: 'string', maxLength: 64 },
            vmids: { type: 'array', items: { type: 'integer', minimum: 100 }, maxItems: 50 },
            nodes: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,62}$' }, maxItems: 50 },
            dryRun: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const { cluster, vmids = [], nodes = [] } = req.body;
        const targets = req.body.dryRun ? await planInstall(cluster, vmids, nodes) : await runInstall(cluster, vmids, nodes);
        return { dryRun: !!req.body.dryRun, targets };
      } catch (err) {
        if (err instanceof PveInstallError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );

  // The link of a host set aside when it broke: restored on the guest it matches now, or forgotten (pve.ts).
  app.post<{ Params: { id: string } }>('/api/hosts/:id/pve/restore', async (req, reply) => {
    const _id = parseId(req.params.id);
    if (!_id) return reply.code(404).send({ error: 'hôte introuvable' });
    try {
      await restorePveLink(_id);
    } catch (err) {
      if (err instanceof PveLinkError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>('/api/hosts/:id/pve/lost', async (req, reply) => {
    const _id = parseId(req.params.id);
    if (!_id) return reply.code(404).send({ error: 'hôte introuvable' });
    try {
      await forgetPveLink(_id);
    } catch (err) {
      if (err instanceof PveLinkError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    return reply.code(204).send();
  });

  // Proxmox VE of a node, found by its agent: cluster, nodes, interfaces, certificate.
  app.post<{ Body: { hostId: string } }>(
    '/api/settings/pve/detect',
    { schema: { body: { type: 'object', required: ['hostId'], additionalProperties: false, properties: { hostId: { type: 'string', maxLength: 24 } } } } },
    async (req, reply) => {
      try {
        return await detectPveOn(req.body.hostId);
      } catch (err) {
        if (err instanceof PveAgentError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    },
  );

  // Token of the hub created by the agent of the node, saved at once with the cluster (created if new).
  app.post<{ Params: { id: string }; Body: PveTokenBody }>('/api/settings/pve/clusters/:id/token', { schema: { body: pveTokenBody } }, async (req, reply) => {
    const s = await loadPveSettings();
    const current = s.clusters.find((c) => c.id === req.params.id);
    const tokenId = req.body.tokenId.trim();
    const conn = resolvePve(req.params.id, req.body, current, { tokenId, tokenSecret: 'pending' });
    if (typeof conn === 'string') return reply.code(400).send({ error: conn });
    const followed = (await pveAlreadyFollowed(s.clusters, req.body.hostId, req.params.id)) ?? (await pveMoveError(current, req.body.hostId));
    if (followed) return reply.code(409).send({ error: followed });
    let t;
    try {
      // the nodes of a cluster share their users: any node keeps the secret the hub holds
      t = await ensurePveToken(req.body.hostId, tokenId, current);
    } catch (err) {
      if (err instanceof PveAgentError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    const fresh = await loadPveSettings();
    const next = { ...conn, ...fresh.clusters.find((c) => c.id === conn.id), ...pick(conn), tokenId: t.tokenId, tokenSecret: t.tokenSecret, agent: { hostId: req.body.hostId } };
    await savePveCluster(next);
    req.log.info({ cluster: next.id, tokenId: t.tokenId, created: t.created, rotated: t.rotated, applied: t.applied, removed: t.removed }, 'PVE token set by the agent');
    pollPve(req.log).catch(() => {});
    return { cluster: pveDto(next), created: t.created, rotated: t.rotated, applied: t.applied, removed: t.removed };
  });

  app.put<{ Params: { id: string }; Body: PveBody }>('/api/settings/pve/clusters/:id', { schema: { body: pveBody } }, async (req, reply) => {
    const s = await loadPveSettings();
    const current = s.clusters.find((c) => c.id === req.params.id);
    if (!current?.tokenSecret) return reply.code(409).send({ error: 'créer d’abord le jeton du cluster' });
    const next = resolvePve(req.params.id, req.body, current, current);
    if (typeof next === 'string') return reply.code(400).send({ error: next });
    if (!next.agent) return reply.code(400).send({ error: 'nœud du cluster requis' });
    const followed = (await pveAlreadyFollowed(s.clusters, next.agent.hostId, next.id)) ?? (await pveMoveError(current, next.agent.hostId));
    if (followed) return reply.code(409).send({ error: followed });
    await savePveCluster({ ...next, agent: next.agent });
    pollPve(req.log).catch(() => {});
    return pveDto(next);
  });

  // Removal of a cluster: its token revoked by the agent of its node first (its rights, the token, the user
  // left without token), then the role; its inventory goes, the links of its hosts are set aside (pveLost) and the
  // groups they attached become orphans (the snapshots stay on the PBS).
  app.delete<{ Params: { id: string } }>('/api/settings/pve/clusters/:id', async (req, reply) => {
    const s = await loadPveSettings();
    const c = s.clusters.find((x) => x.id === req.params.id);
    if (!c) return reply.code(404).send({ error: 'cluster introuvable' });
    let revoked;
    try {
      revoked = await deletePveToken(c.agent?.hostId, c.tokenId);
    } catch (err) {
      if (err instanceof PveAgentError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    req.log.info({ cluster: c.id, tokenId: c.tokenId, deleted: revoked?.deleted, userDeleted: revoked?.userDeleted }, 'PVE cluster removed, token revoked');
    await removePveCluster(c.id);
    pollPve(req.log).catch(() => {});
    return { revoked: revoked?.deleted ? c.tokenId : null, userDeleted: !!revoked?.userDeleted };
  });

  // the address and certificate of the form, with the token saved for the cluster
  app.post<{ Params: { id: string }; Body: PveBody }>('/api/settings/pve/clusters/:id/test', { schema: { body: pveBody } }, async (req, reply) => {
    const current = (await loadPveSettings()).clusters.find((c) => c.id === req.params.id);
    if (!current?.tokenSecret) return reply.code(409).send({ error: 'aucun jeton enregistré pour ce cluster' });
    const next = resolvePve(req.params.id, req.body, current, current);
    if (typeof next === 'string') return reply.code(400).send({ error: next });
    try {
      const [status, jobs] = await Promise.all([
        pveGet<{ type: string; name: string }[]>(next, '/cluster/status'),
        pveGet<unknown[]>(next, '/cluster/backup'),
      ]);
      const nodes = status.filter((n) => n.type === 'node').map((n) => n.name);
      return { ok: true, cluster: status.find((n) => n.type === 'cluster')?.name ?? null, nodes, jobs: jobs.length };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}

// The token is not part of the form: only the agent of a node creates it (POST …/token).
interface PveBody {
  name: string;
  url: string;
  fingerprint: string;
  agent?: { hostId: string };
}

const pveProps = {
  name: { type: 'string', maxLength: 64 },
  url: { type: 'string', maxLength: 256 },
  fingerprint: { type: 'string', maxLength: 128 },
} as const;
const pveAgentSchema = { type: 'object', required: ['hostId'], additionalProperties: false, properties: { hostId: { type: 'string', maxLength: 24 } } } as const;

const pveBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'url', 'fingerprint'],
  properties: { ...pveProps, agent: pveAgentSchema },
} as const;

interface PveTokenBody {
  hostId: string;
  tokenId: string;
  name: string;
  url: string;
  fingerprint: string;
}

const pveTokenBody = {
  type: 'object',
  additionalProperties: false,
  required: ['hostId', 'tokenId', 'name', 'url', 'fingerprint'],
  properties: { ...pveProps, hostId: { type: 'string', maxLength: 24 }, tokenId: { type: 'string', maxLength: 128 } },
} as const;

function pveDto(c: PveCluster) {
  const { tokenSecret, ...rest } = c;
  return { ...rest, hasSecret: !!tokenSecret, polledAt: c.polledAt ?? null, pollError: c.pollError ?? null };
}

// fields of the form (the poll writes the others meanwhile)
const pick = (c: PveCluster) => ({ id: c.id, name: c.name, url: c.url, fingerprint: c.fingerprint, ...(c.agent ? { agent: c.agent } : {}) });

// token: the one saved for the cluster (PUT, test) or the one being created (…/token)
function resolvePve(id: string, body: PveBody | PveTokenBody, current: PveCluster | undefined, token: Pick<PveCluster, 'tokenId' | 'tokenSecret'>): PveCluster | string {
  if (!CLUSTER_ID_RE.test(id)) return 'identifiant invalide (minuscules, chiffres, - et _)';
  const agent = 'hostId' in body ? { hostId: body.hostId } : (body.agent ?? current?.agent);
  const next: PveCluster = {
    ...current,
    id,
    name: body.name.trim() || id,
    url: body.url.trim().replace(/\/+$/, ''),
    fingerprint: body.fingerprint ? normalizeFingerprint(body.fingerprint) : '',
    tokenId: token.tokenId,
    tokenSecret: token.tokenSecret,
    ...(agent ? { agent } : {}),
  };
  if (agent && !parseId(agent.hostId)) return 'nœud invalide';
  if (!PBS_URL_RE.test(next.url)) return 'URL invalide (https://pve:8006)';
  if (next.fingerprint && !FINGERPRINT_RE.test(next.fingerprint)) return 'empreinte invalide (SHA-256, 32 octets en hexadécimal)';
  if (!PVE_TOKEN_ID_RE.test(next.tokenId)) return 'identifiant du jeton invalide (utilisateur@royaume!jeton)';
  if (next.timezone && !validTimeZone(next.timezone)) delete next.timezone;
  return next;
}
