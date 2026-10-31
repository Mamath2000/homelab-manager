import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { AgentRequestError, REFRESH_SCOPES, agentRequest, disconnectAgent, isOnline, refreshAgent, type RefreshScope } from '../agents.js';
import { SERVICE_RE, STACK_RE, findStack, isExternal, isUnmanaged } from '../docker.js';
import { randomToken, sha256 } from '../crypto.js';
import { backups, equipments, healthMetrics, hosts, jobs, parseId, probes } from '../db.js';
import { allAlertDays, hostAlertDays } from '../alerts.js';
import { DOMAINS, evaluateAll, evaluateEquipments } from '../monitoring.js';
import { publish } from '../events.js';
import { hostDto } from '../hostDto.js';
import { isVirtualizedHealthHost } from '../health.js';
import { agentCommands } from '../hubUrl.js';
import { loadAgentSettings } from '../agentUpdate.js';
import { createJob, jobDto, validPackages } from '../jobs.js';
import { forgetHost } from '../pbs.js';
import { equipmentProbes, hostProbes } from '../probes.js';
import { checkHostLinks } from '../catalog.js';
import { applySetup, canSetup } from '../setup.js';
import { APT_ACTIONS, DOCKER_ACTIONS, JOB_ACTIONS, SETUP_OPTIONS, hasApt, type AccessNetwork, type HaHostDetail, type HostDoc, type JobAction, type SetupOverrides } from '../types.js';
import { haLevelSchema, normalizeHostDetail } from '../homeassistant/detail.js';
import { carriedBy, carrierDeleteError } from '../roles.js';

const hostBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 64 },
    // '': no site
    siteId: { type: 'string', maxLength: 24 },
    tags: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', maxLength: 24 } },
    roaming: { type: 'boolean' },
    critical: { type: 'boolean' },
    haExcluded: { type: 'boolean' },
    // level of detail in Home Assistant; null: the global level
    haDetail: haLevelSchema,
  },
} as const;

// Creation only: the access network is fixed afterwards (changing it means reinstalling the agent).
const createHostBody = {
  ...hostBody,
  required: ['name'],
  properties: { ...hostBody.properties, accessNetwork: { type: 'string', enum: ['lan', 'tailscale'] } },
} as const;

// Hosts of the Tailscale access network (typically third parties) start unmanaged: every standard
// option off, and not published to Home Assistant. Both stay editable afterwards.
export const UNMANAGED: SetupOverrides = Object.fromEntries(SETUP_OPTIONS.map((k) => [k, { mode: 'off' }]));

// Instant commands of the UPS the UI offers; same list on the agent.
const UPS_COMMANDS = ['beeper.enable', 'beeper.disable', 'beeper.mute', 'test.battery.start.quick'] as const;

const jobBody = {
  type: 'object',
  required: ['action'],
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: JOB_ACTIONS },
    packages: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 128 } },
    stack: { type: 'string', maxLength: 64 },
    service: { type: 'string', maxLength: 64 },
    sessionId: { type: 'integer', minimum: 0 },
  },
} as const;

const stackParams = {
  type: 'object',
  required: ['id', 'stack'],
  properties: { id: { type: 'string' }, stack: { type: 'string', pattern: STACK_RE.source } },
} as const;

// Host with Docker for the stack routes; sends the error itself and returns null otherwise.
async function dockerHost(id: string, stack: string, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  const _id = parseId(id);
  const host = _id && (await hosts.findOne({ _id }));
  if (!host) {
    reply.code(404).send({ error: 'host not found' });
    return null;
  }
  if (!host.capabilities?.includes('docker') || !findStack(host, stack)) {
    reply.code(404).send({ error: 'stack introuvable sur cet hôte' });
    return null;
  }
  if (!isOnline(id)) {
    reply.code(409).send({ error: 'hôte hors ligne' });
    return null;
  }
  return host;
}

function agentError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
  if (err instanceof AgentRequestError) return reply.code(502).send({ error: err.message });
  throw err;
}

export const ENROLL_VALIDITY_MS = 24 * 3600 * 1000;

// Single-use code of the install command; only its hash is stored.
export function newEnrollCode() {
  let code = randomToken(24);
  // base64url: never start with a dash, which would read like an option on a command line
  while (code.startsWith('-')) code = randomToken(24);
  const expiresAt = new Date(Date.now() + ENROLL_VALIDITY_MS);
  return { code, expiresAt, fields: { enrollCodeHash: sha256(code), enrollExpiresAt: expiresAt } };
}

async function installInfo(req: FastifyRequest, code: string, expiresAt: Date, network: AccessNetwork = 'lan') {
  const cmd = await agentCommands(req, network);
  return { installCommand: cmd ? cmd.install(code) : null, haosToken: cmd ? cmd.haosToken(code) : null, expiresAt };
}

export function registerHostRoutes(app: FastifyInstance) {
  app.get('/api/hosts', async () => {
    const list = await hosts.find().sort({ name: 1 }).toArray();
    return list.map(hostDto);
  });

  app.post<{ Body: { name: string; siteId?: string; tags?: string[]; roaming?: boolean; critical?: boolean; haExcluded?: boolean; accessNetwork?: AccessNetwork } }>(
    '/api/hosts',
    { schema: { body: createHostBody } },
    async (req, reply) => {
      const linkError = await checkHostLinks(req.body.siteId, req.body.tags);
      if (linkError) return reply.code(400).send({ error: linkError });
      const tailscale = req.body.accessNetwork === 'tailscale';
      if (tailscale && !(await loadAgentSettings()).tailscaleHub) {
        return reply.code(400).send({ error: "adresse du hub sur Tailscale non renseignée (Paramètres > Agent)" });
      }
      const enroll = newEnrollCode();
      const doc: HostDoc = {
        _id: new ObjectId(),
        name: req.body.name.trim(),
        siteId: req.body.siteId || undefined,
        tags: req.body.tags?.length ? req.body.tags : undefined,
        roaming: req.body.roaming || undefined,
        critical: req.body.critical || undefined,
        // Tailscale: excluded unless the request says otherwise
        haExcluded: (tailscale ? req.body.haExcluded !== false : req.body.haExcluded) || undefined,
        ...(tailscale ? { accessNetwork: 'tailscale' as const, setupOverrides: UNMANAGED } : {}),
        ...enroll.fields,
        createdAt: new Date(),
      };
      await hosts.insertOne(doc);
      const dto = hostDto(doc);
      publish('host', dto);
      reply.code(201);
      return { host: dto, ...(await installInfo(req, enroll.code, enroll.expiresAt, doc.accessNetwork)) };
    },
  );

  app.get<{ Params: { id: string } }>('/api/hosts/:id', async (req, reply) => {
    const _id = parseId(req.params.id);
    const host = _id && (await hosts.findOne({ _id }));
    if (!host) return reply.code(404).send({ error: 'host not found' });
    return hostDto(host);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; siteId?: string; tags?: string[]; roaming?: boolean; critical?: boolean; haExcluded?: boolean; haDetail?: HaHostDetail | null } }>(
    '/api/hosts/:id',
    { schema: { body: hostBody } },
    async (req, reply) => {
      const _id = parseId(req.params.id);
      const linkError = await checkHostLinks(req.body.siteId, req.body.tags);
      if (linkError) return reply.code(400).send({ error: linkError });
      const set: Partial<HostDoc> = {};
      // flags and links: stored only when set
      const unset: Partial<Record<'roaming' | 'critical' | 'haExcluded' | 'haDetail' | 'siteId', ''>> = {};
      if (req.body.name !== undefined) set.name = req.body.name.trim();
      if (req.body.siteId) set.siteId = req.body.siteId;
      else if (req.body.siteId === '') unset.siteId = '';
      if (req.body.tags !== undefined) set.tags = req.body.tags;
      for (const flag of ['roaming', 'critical', 'haExcluded'] as const) {
        if (req.body[flag]) set[flag] = true;
        else if (req.body[flag] === false) unset[flag] = '';
      }
      // haDetail replaces the old "excluded" flag
      if (req.body.haDetail) {
        set.haDetail = normalizeHostDetail(req.body.haDetail)!;
        unset.haExcluded = '';
        delete set.haExcluded;
      } else if (req.body.haDetail === null) {
        unset.haDetail = '';
        unset.haExcluded = '';
        delete set.haExcluded;
      }
      const update = Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set };
      const host = _id && (await hosts.findOneAndUpdate({ _id }, update, { returnDocument: 'after' }));
      if (!host) return reply.code(404).send({ error: 'host not found' });
      const dto = hostDto(host);
      publish('host', dto);
      return dto;
    },
  );

  // several hosts at once (hosts list): same level of detail for all
  app.post<{ Body: { ids: string[]; haDetail: HaHostDetail | null } }>(
    '/api/hosts/ha-detail',
    {
      schema: {
        body: {
          type: 'object',
          required: ['ids', 'haDetail'],
          additionalProperties: false,
          properties: { ids: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', maxLength: 24 } }, haDetail: haLevelSchema },
        },
      },
    },
    async (req, reply) => {
      const _ids = req.body.ids.map(parseId);
      if (_ids.some((id) => !id)) return reply.code(400).send({ error: 'identifiant invalide' });
      const filter = { _id: { $in: _ids as ObjectId[] } };
      await hosts.updateMany(
        filter,
        req.body.haDetail ? { $set: { haDetail: normalizeHostDetail(req.body.haDetail)! }, $unset: { haExcluded: '' } } : { $unset: { haDetail: '', haExcluded: '' } },
      );
      const list = await hosts.find(filter).toArray();
      for (const h of list) publish('host', hostDto(h));
      return list.map(hostDto);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/hosts/:id', async (req, reply) => {
    const _id = parseId(req.params.id);
    // its record is what revokes the token of the mount
    if (_id && (await hosts.countDocuments({ _id, pbsMount: { $exists: true } }))) return reply.code(409).send({ error: 'une sauvegarde est montée sur cet hôte : la démonter d’abord' });
    const carried = carrierDeleteError('host', _id ? carriedBy(_id) : []);
    if (carried) return reply.code(409).send({ error: carried });
    const res = _id && (await hosts.deleteOne({ _id }));
    if (!res || res.deletedCount === 0) return reply.code(404).send({ error: 'host not found' });
    disconnectAgent(req.params.id);
    await jobs.deleteMany({ hostId: _id });
    await healthMetrics.deleteMany({ hostId: _id });
    await probes.deleteMany({ 'subject.kind': 'host', 'subject.id': _id });
    publish('probe.config', {});
    await forgetHost(_id);
    publish('host.deleted', { id: req.params.id });
    return reply.code(204).send();
  });

  // New install command (single-use code, 24 h). The current agent keeps working until the
  // new installation enrolls and replaces its certificate.
  app.post<{ Params: { id: string } }>('/api/hosts/:id/enroll', async (req, reply) => {
    const _id = parseId(req.params.id);
    if (!_id) return reply.code(404).send({ error: 'host not found' });
    const enroll = newEnrollCode();
    const updated = await hosts.findOneAndUpdate({ _id }, { $set: enroll.fields }, { returnDocument: 'after' });
    if (!updated) return reply.code(404).send({ error: 'host not found' });
    publish('host', hostDto(updated));
    return installInfo(req, enroll.code, enroll.expiresAt, updated.accessNetwork);
  });

  // Revokes the agent: its certificate (or legacy token) and pending code stop working at once.
  app.post<{ Params: { id: string } }>('/api/hosts/:id/revoke', async (req, reply) => {
    const _id = parseId(req.params.id);
    if (!_id) return reply.code(404).send({ error: 'host not found' });
    const updated = await hosts.findOneAndUpdate(
      { _id },
      { $unset: { certFingerprint: '', certIssuedAt: '', tokenHash: '', enrollCodeHash: '', enrollExpiresAt: '' } },
      { returnDocument: 'after' },
    );
    if (!updated) return reply.code(404).send({ error: 'host not found' });
    disconnectAgent(req.params.id);
    // the socket closes asynchronously
    const dto = { ...hostDto(updated), online: false };
    publish('host', dto);
    return dto;
  });

  // alerts of the last days (APT, Docker, backups), for the timeline of the host page
  app.get<{ Params: { id: string } }>('/api/hosts/:id/alerts', async (req, reply) => {
    const _id = parseId(req.params.id);
    if (!_id || !(await hosts.countDocuments({ _id }, { limit: 1 }))) return reply.code(404).send({ error: 'host not found' });
    return { days: await hostAlertDays(_id) };
  });

  // the same for every host (timeline of the dashboard, by site)
  app.get('/api/alerts', async () => allAlertDays());

  // live status of every host and equipment by domain and followed element (monitoring.ts); every profile reads
  app.get('/api/status', async () => ({
    domains: DOMAINS,
    hosts: evaluateAll(await hosts.find().toArray(), await backups.find({ hostId: { $ne: null } }).toArray(), Date.now(), await hostProbes()),
    equipments: evaluateEquipments(await equipments.find().toArray(), await equipmentProbes()),
  }));

  app.get<{ Params: { id: string } }>('/api/hosts/:id/jobs', async (req, reply) => {
    const _id = parseId(req.params.id);
    if (!_id) return reply.code(404).send({ error: 'host not found' });
    const list = await jobs.find({ hostId: _id }, { projection: { log: 0 } }).sort({ createdAt: -1 }).limit(50).toArray();
    return list.map((j) => jobDto(j));
  });

  app.post<{ Params: { id: string }; Body: { action: JobAction; packages?: string[]; stack?: string; service?: string; sessionId?: number } }>(
    '/api/hosts/:id/jobs',
    { schema: { body: jobBody } },
    async (req, reply) => {
      const _id = parseId(req.params.id);
      const host = _id && (await hosts.findOne({ _id }));
      if (!host) return reply.code(404).send({ error: 'host not found' });
      if (req.body.action === 'agent_update' && !host.capabilities?.includes('agent_update')) {
        return reply.code(400).send({ error: "cet agent ne sait pas se mettre à jour : réinstalle-le une fois avec la commande d'installation" });
      }
      if (req.body.action === 'reboot' && !host.capabilities?.includes('reboot')) {
        return reply.code(400).send({ error: "l'agent de cet hôte ne sait pas redémarrer : mets-le à jour" });
      }
      if (req.body.action === 'shutdown' && !host.capabilities?.includes('shutdown')) {
        return reply.code(400).send({ error: "l'agent de cet hôte ne sait pas éteindre : mets-le à jour" });
      }
      // shutdown: operators restart and lock, only an admin powers a host off
      if (req.body.action === 'shutdown' && req.user!.profile !== 'admin') return reply.code(403).send({ error: 'forbidden' });
      if (req.body.action === 'lock') {
        if (!host.capabilities?.includes('lock')) return reply.code(400).send({ error: "l'agent de cet hôte ne sait pas verrouiller une session : mets-le à jour" });
        if (!host.sessions?.sessions.some((s) => s.id === req.body.sessionId)) return reply.code(400).send({ error: 'session inconnue sur cet hôte' });
      } else if (req.body.sessionId !== undefined) {
        return reply.code(400).send({ error: 'sessionId ne concerne que le verrouillage' });
      }
      const { action, stack, service, sessionId } = req.body;
      if (action === 'setup_apply') {
        if (!canSetup(host)) return reply.code(400).send({ error: "la standardisation n'est pas disponible sur cet hôte (Debian / Ubuntu, agent à jour)" });
        // the values of the host: standard configuration and its overrides (PUT /api/hosts/:id/setup)
        const job = await applySetup(host, 'manual');
        reply.code(202);
        return jobDto(job);
      }
      if ((APT_ACTIONS as readonly string[]).includes(action) && !hasApt(host)) {
        return reply.code(400).send({ error: "pas d'APT sur cet hôte" });
      }
      if (action.startsWith('docker_') && !host.capabilities?.includes('docker')) {
        return reply.code(400).send({ error: "Docker (avec compose v2) n'est pas disponible sur cet hôte" });
      }
      // stack actions need a stack of the last report; docker_check covers the whole host
      if ((DOCKER_ACTIONS as readonly string[]).includes(action)) {
        if (!stack || !STACK_RE.test(stack) || (service && !SERVICE_RE.test(service))) {
          return reply.code(400).send({ error: 'stack ou service invalide' });
        }
        if (!findStack(host, stack, service)) return reply.code(404).send({ error: 'stack ou service introuvable sur cet hôte' });
        if (isUnmanaged(host, stack)) return reply.code(409).send({ error: 'stack non managée : aucune action depuis Homelab Manager' });
        if (isExternal(host, stack, service)) return reply.code(409).send({ error: 'conteneur hors du fichier compose : aucune action' });
      } else if (stack || service) {
        return reply.code(400).send({ error: 'stack et service ne concernent que les actions Docker' });
      }
      const packages = req.body.packages ?? [];
      if (!validPackages(packages)) return reply.code(400).send({ error: 'invalid package name' });
      const job = await createJob(host, action, packages, 'manual', { stack, service, sessionId });
      reply.code(202);
      return jobDto(job);
    },
  );

  // Last lines of the logs of a stack, or of one of its services.
  app.get<{ Params: { id: string; stack: string }; Querystring: { service?: string; tail?: number } }>(
    '/api/hosts/:id/stacks/:stack/logs',
    {
      schema: {
        params: stackParams,
        querystring: {
          type: 'object',
          properties: {
            service: { type: 'string', pattern: SERVICE_RE.source },
            tail: { type: 'integer', minimum: 1, maximum: 2000 },
          },
        },
      },
    },
    async (req, reply) => {
      const host = await dockerHost(req.params.id, req.params.stack, reply);
      if (!host) return;
      try {
        return await agentRequest<{ logs: string }>(req.params.id, 'docker_logs', {
          stack: req.params.stack,
          service: req.query.service,
          tail: req.query.tail ?? 200,
        });
      } catch (err) {
        return agentError(reply, err);
      }
    },
  );

  // Compose files of a stack as they are on the host (env files with masked values).
  app.get<{ Params: { id: string; stack: string } }>(
    '/api/hosts/:id/stacks/:stack/compose',
    { schema: { params: stackParams } },
    async (req, reply) => {
      const host = await dockerHost(req.params.id, req.params.stack, reply);
      if (!host) return;
      try {
        return await agentRequest<{ files: { path: string; content: string; masked?: boolean }[] }>(req.params.id, 'docker_compose_file', {
          stack: req.params.stack,
        });
      } catch (err) {
        return agentError(reply, err);
      }
    },
  );

  // The agent reads again what it reports on its own (system, APT state, Docker stacks, Home Assistant
  // backups, UPS), or only the scopes asked; local state only, the checks on the network stay jobs.
  app.post<{ Params: { id: string }; Body: { scopes?: RefreshScope[] } | undefined }>(
    '/api/hosts/:id/refresh',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: { scopes: { type: 'array', maxItems: REFRESH_SCOPES.length, uniqueItems: true, items: { type: 'string', enum: REFRESH_SCOPES } } },
        },
      },
    },
    async (req, reply) => {
      const _id = parseId(req.params.id);
      const host = _id && (await hosts.findOne({ _id }, { projection: { capabilities: 1 } }));
      if (!host) return reply.code(404).send({ error: 'host not found' });
      if (!host.capabilities?.includes('refresh')) return reply.code(400).send({ error: "agent trop ancien pour l'actualisation : le mettre à jour" });
      try {
        return await refreshAgent(req.params.id, req.body?.scopes);
      } catch (err) {
        return agentError(reply, err);
      }
    },
  );

  // Physical disks smartctl can read on the host, offered in its SMART options (nothing is stored).
  app.get<{ Params: { id: string } }>('/api/hosts/:id/health/smart/candidates', async (req, reply) => {
    const _id = parseId(req.params.id);
    const host = _id && (await hosts.findOne({ _id }, { projection: { capabilities: 1, info: 1 } }));
    if (!host) return reply.code(404).send({ error: 'host not found' });
    if (isVirtualizedHealthHost(host)) return reply.code(409).send({ error: 'SMART désactivé sur les hôtes virtualisés' });
    if (!host.capabilities?.includes('smart')) return reply.code(409).send({ error: 'SMART indisponible sur cet agent (smartmontools absent ou agent trop ancien)' });
    try {
      return await agentRequest<{ candidates: unknown[] }>(req.params.id, 'smart_scan', {}, 40_000);
    } catch (err) {
      return agentError(reply, err);
    }
  });

  // Instant command on the UPS of the host: beeper and quick battery test only (the agent checks
  // its own list again and holds the NUT credentials).
  app.post<{ Params: { id: string }; Body: { command: (typeof UPS_COMMANDS)[number] } }>(
    '/api/hosts/:id/ups/command',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: { type: 'object', required: ['command'], additionalProperties: false, properties: { command: { type: 'string', enum: UPS_COMMANDS } } },
      },
    },
    async (req, reply) => {
      const _id = parseId(req.params.id);
      const host = _id && (await hosts.findOne({ _id }));
      if (!host) return reply.code(404).send({ error: 'host not found' });
      if (!host.capabilities?.includes('ups_control')) {
        return reply.code(400).send({ error: "les actions sur l'onduleur ne sont pas configurées sur cet hôte (voir la doc Onduleur)" });
      }
      try {
        await agentRequest(req.params.id, 'ups_command', { upsCmd: req.body.command });
      } catch (err) {
        return agentError(reply, err);
      }
      return { ok: true };
    },
  );

  // Forgets a stack whose containers were removed (it stays listed as "down" otherwise).
  app.delete<{ Params: { id: string; stack: string } }>(
    '/api/hosts/:id/stacks/:stack',
    { schema: { params: stackParams } },
    async (req, reply) => {
      const host = await dockerHost(req.params.id, req.params.stack, reply);
      if (!host) return;
      try {
        await agentRequest(req.params.id, 'docker_forget', { stack: req.params.stack });
      } catch (err) {
        return agentError(reply, err);
      }
      return reply.code(204).send();
    },
  );

  // Stops (or resumes) managing a stack that has its own update system: still listed, read-only.
  app.put<{ Params: { id: string; stack: string }; Body: { managed: boolean } }>(
    '/api/hosts/:id/stacks/:stack/managed',
    {
      schema: {
        params: stackParams,
        body: { type: 'object', required: ['managed'], additionalProperties: false, properties: { managed: { type: 'boolean' } } },
      },
    },
    async (req, reply) => {
      const _id = parseId(req.params.id);
      const host = _id && (await hosts.findOne({ _id }));
      if (!host) return reply.code(404).send({ error: 'host not found' });
      if (!host.capabilities?.includes('docker') || !findStack(host, req.params.stack)) {
        return reply.code(404).send({ error: 'stack introuvable sur cet hôte' });
      }
      const update = req.body.managed ? { $pull: { unmanagedStacks: req.params.stack } } : { $addToSet: { unmanagedStacks: req.params.stack } };
      const updated = await hosts.findOneAndUpdate({ _id }, update, { returnDocument: 'after' });
      if (!updated) return reply.code(404).send({ error: 'host not found' });
      const dto = hostDto(updated);
      publish('host', dto);
      return dto;
    },
  );
}
