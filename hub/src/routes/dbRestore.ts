import type { FastifyInstance } from 'fastify';
import { checkRestore, DbRestoreError, restorableGroups, restorableSnapshots, restoreTargets, startRestore } from '../dbRestore.js';
import { PbsMountError, SOURCES } from '../pbsMount.js';
import type { PbsMountSource } from '../types.js';

// Restore of a database dump into a new database (dbRestore.ts): the steps of the dialog (backup, snapshot and
// dump, target, checks) and the start. For admins (profiles.ts: no other profile writes here).

const sourceParam = { type: 'object', required: ['source'], properties: { source: { type: 'string', enum: SOURCES } } } as const;

const targetProps = {
  hostId: { type: 'string', maxLength: 24 },
  container: { type: 'string', maxLength: 128 },
  jobId: { type: 'string', maxLength: 24 },
  username: { type: 'string', maxLength: 128 },
  password: { type: 'string', maxLength: 1024 },
  authSource: { type: 'string', maxLength: 48 },
  target: { type: 'string', maxLength: 48 },
} as const;

const checkBody = {
  type: 'object',
  additionalProperties: false,
  required: ['hostId', 'container', 'target'],
  properties: { ...targetProps, size: { type: 'integer', minimum: 0 } },
} as const;

const startBody = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'groupId', 'time', 'archive', 'hostId', 'container', 'target'],
  properties: {
    ...targetProps,
    source: { type: 'string', enum: SOURCES },
    groupId: { type: 'string', maxLength: 400 },
    time: { type: 'integer', minimum: 1 },
    archive: { type: 'string', maxLength: 128 },
  },
} as const;

type Source = { source: PbsMountSource };

export function registerDbRestoreRoutes(app: FastifyInstance) {
  const fail = (err: unknown) => (err instanceof DbRestoreError || err instanceof PbsMountError ? { code: 400, error: err.message } : { code: 502, error: (err as Error).message });

  app.get<{ Params: Source }>('/api/db-restore/:source/groups', { schema: { params: sourceParam } }, async (req, reply) => {
    try {
      return await restorableGroups(req.params.source);
    } catch (err) {
      const f = fail(err);
      return reply.code(f.code).send({ error: f.error });
    }
  });

  app.get<{ Params: Source; Querystring: { group: string } }>(
    '/api/db-restore/:source/snapshots',
    { schema: { params: sourceParam, querystring: { type: 'object', required: ['group'], properties: { group: { type: 'string', maxLength: 400 } } } } },
    async (req, reply) => {
      try {
        return await restorableSnapshots(req.params.source, req.query.group);
      } catch (err) {
        const f = fail(err);
        return reply.code(f.code).send({ error: f.error });
      }
    },
  );

  app.get<{ Querystring: { kind: 'mongodb' | 'postgres' } }>(
    '/api/db-restore/targets',
    { schema: { querystring: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['mongodb', 'postgres'] } } } } },
    async (req, reply) => {
      try {
        return await restoreTargets(req.query.kind);
      } catch (err) {
        const f = fail(err);
        return reply.code(f.code).send({ error: f.error });
      }
    },
  );

  app.post<{ Body: Parameters<typeof checkRestore>[0] }>('/api/db-restore/check', { schema: { body: checkBody } }, async (req, reply) => {
    try {
      return await checkRestore(req.body);
    } catch (err) {
      const f = fail(err);
      return reply.code(f.code).send({ error: f.error });
    }
  });

  app.post<{ Body: Parameters<typeof startRestore>[0] }>('/api/db-restore', { schema: { body: startBody } }, async (req, reply) => {
    try {
      return await startRestore(req.body, req.log);
    } catch (err) {
      const f = fail(err);
      return reply.code(f.code).send({ error: f.error });
    }
  });
}
