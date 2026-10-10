import type { FastifyInstance } from 'fastify';
import { hosts, jobs, parseId } from '../db.js';
import { agentOutdated } from '../agentBinaries.js';
import { createJob, jobDto } from '../jobs.js';
import { applySetup, canSetup, loadSetupProfile, resetAndApplySetup, resetError } from '../setup.js';
import { APT_ACTIONS, DOCKER_ACTIONS, JOB_ACTIONS, SETUP_OPTIONS, hasApt, type JobAction, type SetupOption } from '../types.js';

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
  app.post<{ Body: { hostIds: string[]; action: JobAction; options?: SetupOption[] } }>(
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
            // setup_apply: options of the standard to apply, replacing the values of each host
            options: { type: 'array', minItems: 1, maxItems: SETUP_OPTIONS.length, uniqueItems: true, items: { type: 'string', enum: SETUP_OPTIONS } },
          },
        },
      },
    },
    async (req, reply) => {
      // stack actions name a stack of one host: they go through /api/hosts/:id/jobs
      if ((DOCKER_ACTIONS as readonly string[]).includes(req.body.action)) {
        return reply.code(400).send({ error: 'action Docker par stack : à lancer hôte par hôte' });
      }
      if (req.body.options && req.body.action !== 'setup_apply') return reply.code(400).send({ error: 'options ne concerne que la standardisation' });
      const ids = req.body.hostIds.map(parseId).filter((x) => x !== null);
      let targets = await hosts.find({ _id: { $in: ids } }).toArray();
      // agents that are up to date or cannot update themselves are skipped
      if (req.body.action === 'agent_update') {
        targets = targets.filter((h) => h.capabilities?.includes('agent_update') && agentOutdated(h) === true);
      }
      if (req.body.action === 'docker_check') targets = targets.filter((h) => h.capabilities?.includes('docker'));
      if ((APT_ACTIONS as readonly string[]).includes(req.body.action)) targets = targets.filter(hasApt);
      const created = [];
      // standardisation: the chosen options back to the standard on every host (their own values are
      // dropped) and applied; without options, each host with its own values
      if (req.body.action === 'setup_apply') {
        const { options } = req.body;
        const setupTargets = targets.filter(canSetup);
        if (!options) {
          for (const host of setupTargets) created.push(jobDto(await applySetup(host, 'manual')));
        } else {
          const p = await loadSetupProfile();
          const outside = options.filter((k) => !p.options[k].enabled);
          if (outside.length) return reply.code(400).send({ error: `options hors du standard : ${outside.join(', ')}` });
          // all or nothing: no host is changed when one of them would be refused
          const errors = setupTargets.map((h) => resetError(p, h, options)).filter((e) => e !== null);
          if (errors.length) return reply.code(400).send({ error: errors.join(' ; ') });
          for (const host of setupTargets) created.push(jobDto(await resetAndApplySetup(p, host, options)));
        }
        reply.code(202);
        return created;
      }
      for (const host of targets) created.push(jobDto(await createJob(host, req.body.action, [], 'manual')));
      reply.code(202);
      return created;
    },
  );
}
