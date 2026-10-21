import type { FastifyInstance } from 'fastify';
import { hosts, jobs, parseId } from '../db.js';
import { agentOutdated } from '../agentBinaries.js';
import { STACK_RE, updatableStacks } from '../docker.js';
import { createJob, jobDto, securityPackages } from '../jobs.js';
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

  // Same action on several hosts at once: full upgrades, or the security updates of each host
  // (securityOnly); package lists are per host.
  app.post<{ Body: { hostIds: string[]; action: JobAction; options?: SetupOption[]; securityOnly?: boolean } }>(
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
            securityOnly: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      // stack actions name a stack of one host: they go through /api/hosts/:id/jobs
      if ((DOCKER_ACTIONS as readonly string[]).includes(req.body.action)) {
        return reply.code(400).send({ error: 'action Docker par stack : à lancer hôte par hôte' });
      }
      // lock names a session of one host; shutdown is never grouped
      if (req.body.action === 'lock' || req.body.action === 'shutdown') return reply.code(400).send({ error: 'action à lancer hôte par hôte' });
      if (req.body.options && req.body.action !== 'setup_apply') return reply.code(400).send({ error: 'options ne concerne que la standardisation' });
      if (req.body.securityOnly && req.body.action !== 'apt_upgrade') return reply.code(400).send({ error: 'securityOnly ne concerne que apt_upgrade' });
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
      for (const host of targets) {
        // hosts without security update are left out (never a full upgrade by mistake)
        const packages = req.body.securityOnly ? securityPackages(host) : [];
        if (req.body.securityOnly && !packages.length) continue;
        created.push(jobDto(await createJob(host, req.body.action, packages, 'manual')));
      }
      reply.code(202);
      return created;
    },
  );

  // Update of the stacks with a newer image, several hosts at once (dashboard): one docker_update job
  // per stack. A stack that is no longer to update (or unmanaged, or gone) is left out.
  app.post<{ Body: { targets: { hostId: string; stack: string }[] } }>(
    '/api/jobs/docker-update',
    {
      schema: {
        body: {
          type: 'object',
          required: ['targets'],
          additionalProperties: false,
          properties: {
            targets: {
              type: 'array',
              minItems: 1,
              maxItems: 500,
              items: {
                type: 'object',
                required: ['hostId', 'stack'],
                additionalProperties: false,
                properties: { hostId: { type: 'string' }, stack: { type: 'string', pattern: STACK_RE.source } },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const ids = [...new Set(req.body.targets.map((t) => t.hostId))].map(parseId).filter((x) => x !== null);
      const byId = new Map((await hosts.find({ _id: { $in: ids } }).toArray()).map((h) => [h._id.toHexString(), h]));
      const created = [];
      for (const t of req.body.targets) {
        const host = byId.get(t.hostId);
        if (!host || !updatableStacks(host).includes(t.stack)) continue;
        created.push(jobDto(await createJob(host, 'docker_update', [], 'manual', { stack: t.stack })));
      }
      reply.code(202);
      return created;
    },
  );
}
