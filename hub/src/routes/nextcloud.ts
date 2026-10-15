import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ObjectId } from 'mongodb';
import { AgentRequestError, agentRequest, isOnline } from '../agents.js';
import { DEFAULT_TIMEZONE, MAX_KEEP, clientState, groupConflict, jobView, refreshManaged, syncHost } from '../backupJobs.js';
import { config } from '../config.js';
import { backupJobs, hosts, parseId } from '../db.js';
import { publish } from '../events.js';
import { checkPlugin, isPluginJob, planJobs, type NextcloudDiscovery, type PluginInput } from '../nextcloud.js';
import { loadPbsSettings } from '../pbs.js';
import type { HostDoc } from '../types.js';

const pluginProps = {
  workDir: { type: 'string', maxLength: 1024 },
  keep: { type: 'integer', minimum: 0, maximum: MAX_KEEP },
  schedule: { type: 'string', maxLength: 128 },
  enabled: { type: 'boolean' },
  database: { type: ['string', 'null'], maxLength: 64 },
  config: { type: ['string', 'null'], maxLength: 64 },
  users: {
    type: 'array',
    maxItems: 500,
    items: {
      type: 'object',
      required: ['id', 'store'],
      additionalProperties: false,
      properties: { id: { type: 'string', maxLength: 64 }, store: { type: 'string', maxLength: 64 } },
    },
  },
} as const;

async function pluginHost(id: string, reply: FastifyReply): Promise<HostDoc | null> {
  // hidden unless BACKUP_NEXTCLOUD_AIO=true (particular to one setup)
  if (!config.backupNextcloudAio) {
    reply.code(404).send({ error: 'plugin Nextcloud AIO désactivé (BACKUP_NEXTCLOUD_AIO)' });
    return null;
  }
  const _id = parseId(id);
  const host = _id && (await hosts.findOne({ _id }));
  if (!host) {
    reply.code(404).send({ error: 'host not found' });
    return null;
  }
  return host;
}

async function discover(host: HostDoc, workDir: string) {
  return agentRequest<NextcloudDiscovery>(host._id.toHexString(), 'nextcloud_discover', { database: { databases: [], workDir, keep: 0 } }, 75_000);
}

async function changed(hostId: ObjectId) {
  await refreshManaged();
  await syncHost(hostId);
  publish('backups', {});
}

// Nextcloud AIO plugin of a host (nextcloud.ts): admin.
export function registerNextcloudRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/hosts/:id/nextcloud', async (req, reply) => {
    const host = await pluginHost(req.params.id, reply);
    if (!host) return;
    const list = await backupJobs.find({ hostId: host._id }).sort({ name: 1 }).toArray();
    return {
      // the agent knows the jobs and the instance runs on the host
      available: clientState(host.capabilities).nextcloud,
      plugin: host.nextcloud ?? null,
      jobs: list.filter(isPluginJob).map(jobView),
      datastores: ((await loadPbsSettings()).datastores ?? []).map((d) => d.store),
      timezone: DEFAULT_TIMEZONE,
    };
  });

  // What the agent finds on the host (form of the plugin).
  app.post<{ Params: { id: string }; Body: { workDir?: string } }>(
    '/api/hosts/:id/nextcloud/discover',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { workDir: pluginProps.workDir } } } },
    async (req, reply) => {
      const host = await pluginHost(req.params.id, reply);
      if (!host) return;
      if (!isOnline(host._id.toHexString())) return reply.code(409).send({ error: 'hôte hors ligne' });
      try {
        return await discover(host, req.body.workDir ?? '');
      } catch (e) {
        if (e instanceof AgentRequestError) return reply.code(502).send({ error: e.message });
        throw e;
      }
    },
  );

  // Saves the settings and generates the jobs: the agent is asked again (paths of the users).
  app.put<{ Params: { id: string }; Body: PluginInput }>(
    '/api/hosts/:id/nextcloud',
    { schema: { body: { type: 'object', additionalProperties: false, required: Object.keys(pluginProps), properties: pluginProps } } },
    async (req, reply) => {
      const host = await pluginHost(req.params.id, reply);
      if (!host) return;
      if (!clientState(host.capabilities).nextcloud) return reply.code(409).send({ error: "Nextcloud AIO non détecté sur cet hôte (ou agent à mettre à jour)" });
      if (!clientState(host.capabilities).mode) return reply.code(409).send({ error: "client PBS absent sur cet hôte : l'installer d'abord" });
      if (!isOnline(host._id.toHexString())) return reply.code(409).send({ error: 'hôte hors ligne' });
      const p: PluginInput = { ...req.body, workDir: req.body.workDir.trim(), schedule: req.body.schedule.trim() };
      let d: NextcloudDiscovery;
      try {
        d = await discover(host, p.workDir);
      } catch (e) {
        if (e instanceof AgentRequestError) return reply.code(502).send({ error: e.message });
        throw e;
      }
      const err = checkPlugin(p, d, ((await loadPbsSettings()).datastores ?? []).map((x) => x.store));
      if (err) return reply.code(400).send({ error: err });
      const list = await backupJobs.find({ hostId: host._id }).toArray();
      const plan = planJobs(host._id, p, d, list, DEFAULT_TIMEZONE);
      // every group checked before any write
      for (const j of plan.create) {
        const conflict = await groupConflict(host._id, j.store, j.ns, j.backupId);
        if (conflict) return reply.code(409).send({ error: `${j.name} : ${conflict}` });
      }
      for (const { job, set } of plan.update) {
        if (set.store !== job.store) {
          const conflict = await groupConflict(host._id, set.store!, job.ns, job.backupId, job._id);
          if (conflict) return reply.code(409).send({ error: `${set.name} : ${conflict}` });
        }
      }
      if (plan.create.length) await backupJobs.insertMany(plan.create);
      for (const { job, set } of plan.update) await backupJobs.updateOne({ _id: job._id }, { $set: set, $unset: { prepare: '' } });
      if (plan.remove.length) await backupJobs.deleteMany({ _id: { $in: plan.remove.map((j) => j._id) } });
      await hosts.updateOne({ _id: host._id }, { $set: { nextcloud: { ...p, dataDir: d.dataDir, updatedAt: new Date() } } });
      await changed(host._id);
      return { created: plan.create.length, updated: plan.update.length, removed: plan.remove.length };
    },
  );

  // Removes the plugin and its jobs; the snapshots stay on the PBS (orphan groups).
  app.delete<{ Params: { id: string } }>('/api/hosts/:id/nextcloud', async (req, reply) => {
    const host = await pluginHost(req.params.id, reply);
    if (!host) return;
    const r = await backupJobs.deleteMany({ hostId: host._id, 'plugin.name': 'nextcloud' });
    await hosts.updateOne({ _id: host._id }, { $unset: { nextcloud: '' } });
    await changed(host._id);
    return { removed: r.deletedCount };
  });
}
