import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { disconnectAgent } from '../agents.js';
import { randomToken, sha256 } from '../crypto.js';
import { hosts, jobs, parseId } from '../db.js';
import { publish } from '../events.js';
import { hostDto } from '../hostDto.js';
import { agentCommands } from '../hubUrl.js';
import { createJob, jobDto, validPackages } from '../jobs.js';
import { JOB_ACTIONS, type HostDoc, type JobAction } from '../types.js';

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
  },
} as const;

export const ENROLL_VALIDITY_MS = 24 * 3600 * 1000;

// Single-use code of the install command; only its hash is stored.
function newEnrollCode() {
  const code = randomToken(24);
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

  app.post<{ Params: { id: string }; Body: { action: JobAction; packages?: string[] } }>(
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
      const packages = req.body.packages ?? [];
      if (!validPackages(packages)) return reply.code(400).send({ error: 'invalid package name' });
      const job = await createJob(host, req.body.action, packages, 'manual');
      reply.code(202);
      return jobDto(job);
    },
  );
}
