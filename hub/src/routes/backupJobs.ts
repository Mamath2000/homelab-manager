import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { isOnline } from '../agents.js';
import { DEFAULT_TIMEZONE, TOKEN_ID_RE, checkJob, currentHash, groupConflict, jobView, refreshManaged, syncHost, type JobInput } from '../backupJobs.js';
import { backupJobs, backups, hosts, parseId } from '../db.js';
import { publish } from '../events.js';
import { createJob, jobDto } from '../jobs.js';
import { loadPbsSettings } from '../pbs.js';

const jobProps = {
  name: { type: 'string', minLength: 1, maxLength: 64 },
  archives: {
    type: 'array',
    minItems: 1,
    maxItems: 20,
    items: {
      type: 'object',
      required: ['name', 'path'],
      additionalProperties: false,
      properties: { name: { type: 'string', maxLength: 64 }, path: { type: 'string', maxLength: 1024 } },
    },
  },
  excludes: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 256 } },
  store: { type: 'string', maxLength: 64 },
  ns: { type: 'string', maxLength: 256 },
  backupId: { type: 'string', maxLength: 64 },
  schedule: { type: 'string', maxLength: 128 },
  timezone: { type: 'string', maxLength: 64 },
  enabled: { type: 'boolean' },
} as const;

const required = ['name', 'archives', 'excludes', 'store', 'ns', 'schedule', 'enabled'] as const;

async function changed(hostId: ObjectId) {
  await refreshManaged();
  await syncHost(hostId);
  publish('backups', {});
}

// Backups of directories run by the agent of a host (see backupJobs.ts). Settings of a host: admin;
// running a job now: operator too (roles.ts).
export function registerBackupJobRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/hosts/:id/backup-jobs', async (req, reply) => {
    const _id = parseId(req.params.id);
    const host = _id && (await hosts.findOne({ _id }));
    if (!host) return reply.code(404).send({ error: 'host not found' });
    const pbs = await loadPbsSettings();
    const list = await backupJobs.find({ hostId: _id }).sort({ name: 1 }).toArray();
    return {
      // the agent can run the client, natively or in a container
      mode: host.capabilities?.includes('backup:native') ? 'native' : host.capabilities?.includes('backup:docker') ? 'docker' : null,
      credential: host.pbsCredential ? { tokenId: host.pbsCredential.tokenId, updatedAt: host.pbsCredential.updatedAt, store: host.pbsCredential.store ?? null } : null,
      sync: host.backupSync ? { ...host.backupSync, current: host.backupSync.hash === (await currentHash(host)) } : null,
      pbsReady: pbs.enabled && !!pbs.url,
      datastores: (pbs.datastores ?? []).map((d) => d.store),
      timezone: pbs.timezone || DEFAULT_TIMEZONE,
      jobs: list.map(jobView),
    };
  });

  app.put<{ Params: { id: string }; Body: { tokenId: string; tokenSecret?: string } | null }>(
    '/api/hosts/:id/pbs-credential',
    {
      schema: {
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['tokenId'],
          properties: { tokenId: { type: 'string', maxLength: 128 }, tokenSecret: { type: 'string', maxLength: 128 } },
        },
      },
    },
    async (req, reply) => {
      const _id = parseId(req.params.id);
      const host = _id && (await hosts.findOne({ _id }));
      if (!host) return reply.code(404).send({ error: 'host not found' });
      if (req.body === null) {
        await hosts.updateOne({ _id }, { $unset: { pbsCredential: '' } });
      } else {
        const tokenId = req.body.tokenId.trim();
        const tokenSecret = req.body.tokenSecret?.trim() || host.pbsCredential?.tokenSecret;
        if (!TOKEN_ID_RE.test(tokenId)) return reply.code(400).send({ error: 'identifiant du jeton invalide (utilisateur@royaume!jeton)' });
        if (!tokenSecret) return reply.code(400).send({ error: 'secret du jeton requis' });
        // entered by hand: the datastore of its rights is not known
        await hosts.updateOne({ _id }, { $set: { pbsCredential: { tokenId, tokenSecret, updatedAt: new Date() } } });
      }
      await changed(_id);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: JobInput }>(
    '/api/hosts/:id/backup-jobs',
    { schema: { body: { type: 'object', additionalProperties: false, required: [...required, 'backupId'], properties: jobProps } } },
    async (req, reply) => {
      const _id = parseId(req.params.id);
      const host = _id && (await hosts.findOne({ _id }));
      if (!host) return reply.code(404).send({ error: 'host not found' });
      const pbs = await loadPbsSettings();
      const body = { ...req.body, timezone: req.body.timezone || pbs.timezone || DEFAULT_TIMEZONE };
      const err = checkJob(body, true);
      if (err) return reply.code(400).send({ error: err });
      const conflict = await groupConflict(_id, body.store, body.ns, body.backupId!);
      if (conflict) return reply.code(409).send({ error: conflict });
      const now = new Date();
      const doc = {
        _id: new ObjectId(),
        hostId: _id,
        name: body.name.trim(),
        archives: body.archives,
        excludes: body.excludes,
        store: body.store,
        ns: body.ns,
        backupId: body.backupId!,
        schedule: body.schedule.trim(),
        timezone: body.timezone,
        enabled: body.enabled,
        createdAt: now,
        updatedAt: now,
        lastRun: null,
      };
      await backupJobs.insertOne(doc);
      await changed(_id);
      reply.code(201);
      return jobView(doc);
    },
  );

  // The backup id (group on the PBS) is fixed: a new one would start a new history.
  app.put<{ Params: { jobId: string }; Body: JobInput }>(
    '/api/backup-jobs/:jobId',
    { schema: { body: { type: 'object', additionalProperties: false, required: [...required], properties: jobProps } } },
    async (req, reply) => {
      const _id = parseId(req.params.jobId);
      const cur = _id && (await backupJobs.findOne({ _id }));
      if (!cur) return reply.code(404).send({ error: 'job introuvable' });
      if (req.body.backupId !== undefined && req.body.backupId !== cur.backupId) return reply.code(400).send({ error: "l'identifiant de sauvegarde ne change pas" });
      const body = { ...req.body, timezone: req.body.timezone || cur.timezone };
      const err = checkJob(body, false);
      if (err) return reply.code(400).send({ error: err });
      if (body.store !== cur.store || body.ns !== cur.ns) {
        const conflict = await groupConflict(cur.hostId, body.store, body.ns, cur.backupId, cur._id);
        if (conflict) return reply.code(409).send({ error: conflict });
      }
      const set = {
        name: body.name.trim(),
        archives: body.archives,
        excludes: body.excludes,
        store: body.store,
        ns: body.ns,
        schedule: body.schedule.trim(),
        timezone: body.timezone,
        enabled: body.enabled,
        updatedAt: new Date(),
      };
      await backupJobs.updateOne({ _id }, { $set: set });
      await changed(cur.hostId);
      return jobView({ ...cur, ...set });
    },
  );

  // The snapshots stay on the PBS; the group becomes an orphan.
  app.delete<{ Params: { jobId: string } }>('/api/backup-jobs/:jobId', async (req, reply) => {
    const _id = parseId(req.params.jobId);
    const cur = _id && (await backupJobs.findOne({ _id }));
    if (!cur) return reply.code(404).send({ error: 'job introuvable' });
    await backupJobs.deleteOne({ _id });
    await changed(cur.hostId);
    return reply.code(204).send();
  });

  app.post<{ Params: { jobId: string } }>('/api/backup-jobs/:jobId/run', async (req, reply) => {
    const _id = parseId(req.params.jobId);
    const bj = _id && (await backupJobs.findOne({ _id }));
    if (!bj) return reply.code(404).send({ error: 'job introuvable' });
    const host = await hosts.findOne({ _id: bj.hostId });
    if (!host) return reply.code(404).send({ error: 'host not found' });
    if (!isOnline(host._id.toHexString())) return reply.code(409).send({ error: 'hôte hors ligne' });
    if (!host.capabilities?.includes('backup')) return reply.code(400).send({ error: "l'agent de cet hôte ne sait pas sauvegarder (client PBS absent, ou agent à mettre à jour)" });
    const g = await backups.findOne({ 'managed.jobId': bj._id.toHexString() });
    if (g?.managed && !g.managed.synced) return reply.code(409).send({ error: "l'agent n'a pas encore appliqué la définition de ce job" });
    const job = await createJob(host, 'backup_run', [], 'manual', { backupJob: bj._id.toHexString(), backupJobName: bj.name });
    reply.code(202);
    return jobDto(job);
  });
}
