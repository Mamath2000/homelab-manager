import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { disconnectAgent } from '../agents.js';
import { randomToken, sha256 } from '../crypto.js';
import { hosts, jobs, parseId } from '../db.js';
import { publish } from '../events.js';
import { hostDto } from '../hostDto.js';
import { hubUrl, installCommand } from '../hubUrl.js';
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

function newToken(id: ObjectId) {
  const secret = randomToken();
  return { token: `${id.toHexString()}.${secret}`, tokenHash: sha256(secret) };
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
      const _id = new ObjectId();
      const { token, tokenHash } = newToken(_id);
      const doc: HostDoc = {
        _id,
        name: req.body.name.trim(),
        group: req.body.group?.trim() || undefined,
        tokenHash,
        createdAt: new Date(),
      };
      await hosts.insertOne(doc);
      const dto = hostDto(doc);
      publish('host', dto);
      const url = hubUrl(req);
      reply.code(201);
      return { host: dto, token, installCommand: url ? installCommand(url, token) : null };
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

  // Issue a new agent token; the previous one stops working immediately.
  app.post<{ Params: { id: string } }>('/api/hosts/:id/token', async (req, reply) => {
    const _id = parseId(req.params.id);
    if (!_id) return reply.code(404).send({ error: 'host not found' });
    const { token, tokenHash } = newToken(_id);
    const res = await hosts.updateOne({ _id }, { $set: { tokenHash } });
    if (res.matchedCount === 0) return reply.code(404).send({ error: 'host not found' });
    disconnectAgent(req.params.id);
    const url = hubUrl(req);
    return { token, installCommand: url ? installCommand(url, token) : null };
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
      const packages = req.body.packages ?? [];
      if (!validPackages(packages)) return reply.code(400).send({ error: 'invalid package name' });
      const job = await createJob(host, req.body.action, packages, 'manual');
      reply.code(202);
      return jobDto(job);
    },
  );
}
