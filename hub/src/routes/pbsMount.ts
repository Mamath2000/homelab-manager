import type { FastifyInstance } from 'fastify';
import { activeMount, groupSnapshots, mount, mountableGroups, mountDestinations, mountSources, PbsMountError, SOURCES, unmount } from '../pbsMount.js';
import { loadPbsSettings } from '../pbs.js';
import type { PbsMountSource } from '../types.js';

// Read-only mount of a snapshot of a PBS (pbsMount.ts): the steps of the window (PBS, backup, snapshot and
// archive, destination), the mount and the unmount. Mounting is for admins (profiles.ts: no other profile writes here).

const sourceParam = {
  type: 'object',
  required: ['source'],
  properties: { source: { type: 'string', enum: SOURCES } },
} as const;

const mountBody = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'groupId', 'time', 'archive', 'hostId'],
  properties: {
    source: { type: 'string', enum: SOURCES },
    groupId: { type: 'string', maxLength: 400 },
    time: { type: 'integer', minimum: 1 },
    archive: { type: 'string', maxLength: 128 },
    hostId: { type: 'string', maxLength: 24 },
  },
} as const;

type Source = { source: PbsMountSource };

export function registerPbsMountRoutes(app: FastifyInstance) {
  const fail = (err: unknown) => {
    if (err instanceof PbsMountError) return { code: 400, error: err.message };
    return { code: 502, error: (err as Error).message };
  };

  app.get('/api/pbs-mount', async () => {
    const [h, pbs] = await Promise.all([activeMount(), loadPbsSettings()]);
    return {
      sources: await mountSources(),
      active: h ? { hostId: h._id.toHexString(), hostName: h.name } : null,
      mountRoot: pbs.mountRoot ?? '/srv/pbs-restore',
    };
  });

  app.get<{ Params: Source }>('/api/pbs-mount/:source/groups', { schema: { params: sourceParam } }, async (req, reply) => {
    try {
      return await mountableGroups(req.params.source);
    } catch (err) {
      const f = fail(err);
      return reply.code(f.code).send({ error: f.error });
    }
  });

  app.get<{ Params: Source; Querystring: { group: string } }>(
    '/api/pbs-mount/:source/snapshots',
    { schema: { params: sourceParam, querystring: { type: 'object', required: ['group'], properties: { group: { type: 'string', maxLength: 400 } } } } },
    async (req, reply) => {
      try {
        return await groupSnapshots(req.params.source, req.query.group);
      } catch (err) {
        const f = fail(err);
        return reply.code(f.code).send({ error: f.error });
      }
    },
  );

  app.get<{ Params: Source }>('/api/pbs-mount/:source/destinations', { schema: { params: sourceParam } }, async (req, reply) => {
    try {
      return await mountDestinations(req.params.source);
    } catch (err) {
      const f = fail(err);
      return reply.code(f.code).send({ error: f.error });
    }
  });

  app.post<{ Body: { source: PbsMountSource; groupId: string; time: number; archive: string; hostId: string } }>(
    '/api/pbs-mount',
    { schema: { body: mountBody } },
    async (req, reply) => {
      try {
        return await mount(req.body, req.log);
      } catch (err) {
        const f = fail(err);
        return reply.code(f.code).send({ error: f.error });
      }
    },
  );

  // the record left when something could not be done now (an agent offline), null when all is clean
  app.post('/api/pbs-mount/unmount', async (req) => ({ pending: await unmount(req.log) }));
}
