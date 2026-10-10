import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { AgentRequestError, agentRequest, disconnectAgent, isOnline } from '../agents.js';
import { SERVICE_RE, STACK_RE, findStack, isUnmanaged } from '../docker.js';
import { randomToken, sha256 } from '../crypto.js';
import { hosts, jobs, parseId } from '../db.js';
import { publish } from '../events.js';
import { hostDto } from '../hostDto.js';
import { agentCommands } from '../hubUrl.js';
import { createJob, jobDto, validPackages } from '../jobs.js';
import { APT_ACTIONS, DOCKER_ACTIONS, JOB_ACTIONS, hasApt, type HostDoc, type JobAction } from '../types.js';

const hostBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 64 },
    group: { type: 'string', maxLength: 64 },
  },
} as const;

const jobBody = {
  type: 'object',
  required: ['action'],
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: JOB_ACTIONS },
    packages: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 128 } },
    stack: { type: 'string', maxLength: 64 },
    service: { type: 'string', maxLength: 64 },
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
function newEnrollCode() {
  let code = randomToken(24);
  // base64url: never start with a dash, which would read like an option on a command line
  while (code.startsWith('-')) code = randomToken(24);
  const expiresAt = new Date(Date.now() + ENROLL_VALIDITY_MS);
  return { code, expiresAt, fields: { enrollCodeHash: sha256(code), enrollExpiresAt: expiresAt } };
}

async function installInfo(req: FastifyRequest, code: string, expiresAt: Date) {
  const cmd = await agentCommands(req);
  return { installCommand: cmd ? cmd.install(code) : null, expiresAt };
}

export function registerHostRoutes(app: FastifyInstance) {
  app.get('/api/hosts', async () => {
    const list = await hosts.find().sort({ group: 1, name: 1 }).toArray();
    return list.map(hostDto);
  });

  app.post<{ Body: { name: string; group?: string } }>(
    '/api/hosts',
    { schema: { body: { ...hostBody, required: ['name'] } } },
    async (req, reply) => {
      const enroll = newEnrollCode();
      const doc: HostDoc = {
        _id: new ObjectId(),
        name: req.body.name.trim(),
        group: req.body.group?.trim() || undefined,
        ...enroll.fields,
        createdAt: new Date(),
      };
      await hosts.insertOne(doc);
      const dto = hostDto(doc);
      publish('host', dto);
      reply.code(201);
      return { host: dto, ...(await installInfo(req, enroll.code, enroll.expiresAt)) };
    },
  );

  app.get<{ Params: { id: string } }>('/api/hosts/:id', async (req, reply) => {
    const _id = parseId(req.params.id);
    const host = _id && (await hosts.findOne({ _id }));
    if (!host) return reply.code(404).send({ error: 'host not found' });
    return hostDto(host);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; group?: string } }>(
    '/api/hosts/:id',
    { schema: { body: hostBody } },
    async (req, reply) => {
      const _id = parseId(req.params.id);
      const set: Partial<HostDoc> = {};
      if (req.body.name !== undefined) set.name = req.body.name.trim();
      if (req.body.group !== undefined) set.group = req.body.group.trim();
      const host = _id && (await hosts.findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' }));
      if (!host) return reply.code(404).send({ error: 'host not found' });
      const dto = hostDto(host);
      publish('host', dto);
      return dto;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/hosts/:id', async (req, reply) => {
    const _id = parseId(req.params.id);
    const res = _id && (await hosts.deleteOne({ _id }));
    if (!res || res.deletedCount === 0) return reply.code(404).send({ error: 'host not found' });
    disconnectAgent(req.params.id);
    await jobs.deleteMany({ hostId: _id });
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
    return installInfo(req, enroll.code, enroll.expiresAt);
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

  app.get<{ Params: { id: string } }>('/api/hosts/:id/jobs', async (req, reply) => {
    const _id = parseId(req.params.id);
    if (!_id) return reply.code(404).send({ error: 'host not found' });
    const list = await jobs.find({ hostId: _id }, { projection: { log: 0 } }).sort({ createdAt: -1 }).limit(50).toArray();
    return list.map((j) => jobDto(j));
  });

  app.post<{ Params: { id: string }; Body: { action: JobAction; packages?: string[]; stack?: string; service?: string } }>(
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
      const { action, stack, service } = req.body;
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
      } else if (stack || service) {
        return reply.code(400).send({ error: 'stack et service ne concernent que les actions Docker' });
      }
      const packages = req.body.packages ?? [];
      if (!validPackages(packages)) return reply.code(400).send({ error: 'invalid package name' });
      const job = await createJob(host, action, packages, 'manual', { stack, service });
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
