import type { FastifyInstance } from 'fastify';
import { hosts, jobs, parseId } from '../db.js';
import { agentOutdated } from '../agentBinaries.js';
import { createJob, jobDto } from '../jobs.js';
import { JOB_ACTIONS, type JobAction } from '../types.js';

export function registerJobRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: number } }>(
    '/api/jobs',
    { schema: { querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } } } } },
    async (req) => {
      const list = await jobs
        .find({}, { projection: { log: 0 } })
        .sort({ createdAt: -1 })
        .limit(req.query.limit ?? 100)
        .toArray();
      return list.map((j) => jobDto(j));
    },
  );

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const _id = parseId(req.params.id);
    const job = _id && (await jobs.findOne({ _id }));
    if (!job) return reply.code(404).send({ error: 'job not found' });
    return jobDto(job, true);
  });

  // Same action on several hosts at once (full upgrades only, package lists are per host).
  app.post<{ Body: { hostIds: string[]; action: JobAction } }>(
    '/api/jobs/bulk',
    {
      schema: {
        body: {
          type: 'object',
          required: ['hostIds', 'action'],
          additionalProperties: false,
          properties: {
            hostIds: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string' } },
            action: { type: 'string', enum: JOB_ACTIONS },
          },
        },
      },
    },
    async (req, reply) => {
      const ids = req.body.hostIds.map(parseId).filter((x) => x !== null);
      let targets = await hosts.find({ _id: { $in: ids } }).toArray();
      // agents that are up to date or cannot update themselves are skipped
      if (req.body.action === 'agent_update') {
        targets = targets.filter((h) => h.capabilities?.includes('agent_update') && agentOutdated(h) === true);
      }
      const created = [];
      for (const host of targets) created.push(jobDto(await createJob(host, req.body.action, [], 'manual')));
      reply.code(202);
      return created;
    },
  );
}
