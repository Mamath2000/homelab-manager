import type { FastifyInstance } from 'fastify';
import { STORE_RE } from '../backupJobs.js';
import { backups, settings } from '../db.js';
import { publish } from '../events.js';
import {
  HHMM_RE,
  OFFSITE_DEFAULTS,
  RATE_RE,
  loadRemoteSettings,
  notCopiable,
  pollOffsite,
  remoteReady,
  followTask,
  runSyncJob,
  queueOf,
  queueView,
  sameGroupElsewhere,
  syncJobId,
  syncOffsiteAgent,
  targetNamespaces,
} from '../offsite.js';
import { FINGERPRINT_RE, PBS_URL_RE, backupDto, loadPbsSettings, normalizeFingerprint, pbsGet } from '../pbs.js';
import { PBS_TOKEN_ACLS, PbsAgentError, checkLink, ensurePbsToken, offsiteHubAcls } from '../pbsAgent.js';
import type { BackupDoc, BackupOffsite, OffsiteQueueSettings, PbsAgentLink, PbsRemoteSettings } from '../types.js';

// Secondary PBS and the copy of the backups to it (offsite.ts). Settings: admin (/api/settings/*); running
// a copy now: operator too (roles.ts).

async function remoteDto(r: PbsRemoteSettings) {
  const { _id, tokenSecret, readerTokenSecret, remoteHash, queueAck, queueError, queueReport, ...rest } = r;
  void _id;
  void remoteHash;
  void queueAck;
  void queueError;
  void queueReport;
  return { ...rest, queue: queueOf(r), queueState: await queueView(r), hasSecret: !!tokenSecret, hasReaderSecret: !!readerTokenSecret };
}

const agentLinkSchema = {
  type: 'object',
  required: ['hostId', 'mode'],
  additionalProperties: false,
  properties: { hostId: { type: 'string', maxLength: 24 }, mode: { type: 'string', enum: ['native', 'container'] }, container: { type: 'string', maxLength: 128 } },
} as const;

interface RemoteBody {
  enabled: boolean;
  url: string;
  fingerprint: string;
  agent?: PbsAgentLink;
  queue?: OffsiteQueueSettings;
}

const queueSchema = {
  type: 'object',
  required: ['windowStart', 'windowEnd', 'concurrency', 'minDelayH', 'countMaintenance'],
  additionalProperties: false,
  properties: {
    windowStart: { type: 'string', maxLength: 5 },
    windowEnd: { type: 'string', maxLength: 5 },
    concurrency: { type: 'integer', minimum: 1, maximum: 8 },
    minDelayH: { type: 'integer', minimum: 0, maximum: 720 },
    countMaintenance: { type: 'boolean' },
  },
} as const;

const remoteBody = {
  type: 'object',
  additionalProperties: false,
  required: ['enabled', 'url', 'fingerprint'],
  properties: { enabled: { type: 'boolean' }, url: { type: 'string', maxLength: 256 }, fingerprint: { type: 'string', maxLength: 128 }, agent: agentLinkSchema, queue: queueSchema },
} as const;

const nativeOrContainer = (a: PbsAgentLink): PbsAgentLink => (a.mode === 'native' ? { hostId: a.hostId, mode: 'native' } : a);

async function resolve(body: RemoteBody): Promise<PbsRemoteSettings | string> {
  const current = await loadRemoteSettings();
  const next: PbsRemoteSettings = {
    ...current,
    enabled: body.enabled,
    url: body.url.trim().replace(/\/+$/, ''),
    fingerprint: body.fingerprint ? normalizeFingerprint(body.fingerprint) : '',
    ...(body.agent ? { agent: nativeOrContainer(body.agent) } : {}),
    ...(body.queue ? { queue: body.queue } : {}),
  };
  if (body.queue && (!HHMM_RE.test(body.queue.windowStart) || !HHMM_RE.test(body.queue.windowEnd))) return 'plage horaire invalide (HH:MM)';
  if (next.url && !PBS_URL_RE.test(next.url)) return 'URL invalide (https://pbs:8007)';
  if (next.fingerprint && !FINGERPRINT_RE.test(next.fingerprint)) return 'empreinte invalide (SHA-256, 32 octets en hexadécimal)';
  if (next.agent) {
    const bad = checkLink(next.agent);
    if (bad) return bad;
  }
  if (next.enabled) {
    if (!next.url || !next.tokenSecret || !next.store) return 'URL, datastore cible et jeton du hub requis : créer le jeton avec l’agent du PBS de secours';
    if (!next.readerTokenSecret) return 'jeton lecteur du PBS principal requis';
    if (!(await loadPbsSettings()).url) return 'PBS principal non configuré';
  }
  return next;
}

interface OffsiteBody {
  enabled: boolean;
  schedule?: string; // ignored: the queue of the agent of the secondary runs the copies (#185)
  rateIn?: string | null;
}

export const offsiteSchema = {
  type: 'object',
  required: ['enabled'],
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    schedule: { type: 'string', maxLength: 64 },
    rateIn: { type: ['string', 'null'], maxLength: 16 },
  },
} as const;

// Levels of the namespace of a group missing on the target datastore of the secondary, parents first (the
// sync job cannot create them: no Datastore.Modify for the token of the hub); [] when all are there.
export function missingLevels(ns: string, present: string[]) {
  const parts = ns.split('/').filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/')).filter((l) => !present.includes(l));
}

// Commands creating them, from a shell of the secondary PBS
export const namespaceCommands = (levels: string[], store: string) => levels.map((l) => `proxmox-backup-client namespace create ${l} --repository root@pam@localhost:${store}`);

export interface OffsiteCheck {
  ok: boolean;
  error?: string;
  // namespace to create first on the secondary
  namespace?: { ns: string; store: string; missing: string[]; commands: string[] };
}

// Can this group be copied now: copiable, secondary ready, not copied from another datastore, its namespace
// on the target datastore. Asked as soon as the copy is enabled in the interface, checked again on save.
export async function checkOffsite(b: BackupDoc): Promise<OffsiteCheck> {
  const why = notCopiable(b);
  if (why) return { ok: false, error: why };
  const r = await loadRemoteSettings();
  if (!remoteReady(r)) return { ok: false, error: 'PBS de secours non configuré ou désactivé (Paramètres › Sauvegardes)' };
  const others = await backups.find({ 'offsite.enabled': true }, { projection: { _id: 1, store: 1, ns: 1, type: 1, backupId: 1 } }).toArray();
  const twin = sameGroupElsewhere(b, others);
  if (twin) return { ok: false, error: `${b.ns || 'racine'}/${b.type}/${b.backupId} est déjà copié depuis le datastore ${twin.store} : une seule copie par groupe` };
  if (!b.ns) return { ok: true };
  let present: string[];
  try {
    present = await targetNamespaces(r);
  } catch (err) {
    return { ok: false, error: `PBS de secours : ${(err as Error).message}` };
  }
  const missing = missingLevels(b.ns, present);
  if (!missing.length) return { ok: true };
  return {
    ok: false,
    error: `namespace ${b.ns} absent du datastore ${r.store} du PBS de secours`,
    namespace: { ns: b.ns, store: r.store, missing, commands: namespaceCommands(missing, r.store) },
  };
}

// Settings of the copy of a group, checked; error message or the new offsite member.
export async function offsiteOf(b: BackupDoc, body: OffsiteBody): Promise<BackupOffsite | string> {
  const cur = b.offsite;
  const { transferLast, ...kept } = (cur ?? {}) as BackupOffsite & { transferLast?: unknown };
  void transferLast; // no longer set: one snapshot per run (TRANSFER_LAST)
  const next: BackupOffsite = {
    ...kept,
    enabled: body.enabled,
    rateIn: body.rateIn !== undefined ? body.rateIn?.trim() || null : (cur?.rateIn ?? OFFSITE_DEFAULTS.rateIn),
    jobId: syncJobId(b._id),
    since: cur?.enabled ? cur.since : Date.now(),
  };
  if (next.rateIn && !RATE_RE.test(next.rateIn)) return 'débit invalide (ex. 10MiB, 500KB)';
  if (!next.enabled) return next;
  // already copied: its namespace is there (not asked again at each change of settings)
  if (cur?.enabled) {
    const why = notCopiable(b);
    return why ?? next;
  }
  const check = await checkOffsite(b);
  if (!check.ok) return check.namespace ? `${check.error} : le créer d'abord (${check.namespace.commands.join(' ; ')})` : check.error!;
  return next;
}

export function registerOffsiteRoutes(app: FastifyInstance) {
  app.get('/api/settings/pbs-remote', async () => remoteDto(await loadRemoteSettings()));

  app.put<{ Body: RemoteBody }>('/api/settings/pbs-remote', { schema: { body: remoteBody } }, async (req, reply) => {
    const next = await resolve(req.body);
    if (typeof next === 'string') return reply.code(400).send({ error: next });
    await settings.replaceOne({ _id: 'pbs-remote' }, next, { upsert: true });
    if (next.enabled) pollOffsite(req.log).catch(() => {});
    // disabled: the agent of the secondary empties its queue
    else syncOffsiteAgent().catch((err) => req.log.warn({ err }, 'offsite queue definition not sent'));
    publish('backups', {});
    return remoteDto(next);
  });

  // datastores the token of the hub sees, and the namespaces of the target one
  app.post<{ Body: RemoteBody }>('/api/settings/pbs-remote/test', { schema: { body: remoteBody } }, async (req, reply) => {
    const next = await resolve({ ...req.body, enabled: false });
    if (typeof next === 'string') return reply.code(400).send({ error: next });
    if (!next.url || !next.tokenSecret) return reply.code(400).send({ error: 'adresse et jeton du hub requis' });
    try {
      const stores = await pbsGet<{ store: string }[]>(next, '/admin/datastore');
      return { ok: true, datastores: stores.map((d) => d.store), namespaces: next.store ? await targetNamespaces(next) : [] };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // token of the hub on the secondary, created by its agent, for the target datastore; saved at once
  app.post<{ Body: { agent: PbsAgentLink; tokenId: string; store: string } }>(
    '/api/settings/pbs-remote/token',
    {
      schema: {
        body: {
          type: 'object',
          required: ['agent', 'tokenId', 'store'],
          additionalProperties: false,
          properties: { agent: agentLinkSchema, tokenId: { type: 'string', maxLength: 128 }, store: { type: 'string', maxLength: 64 } },
        },
      },
    },
    async (req, reply) => {
      const { store } = req.body;
      if (!STORE_RE.test(store)) return reply.code(400).send({ error: 'datastore cible invalide' });
      const current = await loadRemoteSettings();
      const agent = nativeOrContainer(req.body.agent);
      let t;
      try {
        t = await ensurePbsToken(agent, req.body.tokenId.trim(), offsiteHubAcls(store), current);
      } catch (err) {
        if (err instanceof PbsAgentError) return reply.code(409).send({ error: err.message });
        throw err;
      }
      // the remote entry belongs to the token: written again with the next one
      await settings.updateOne({ _id: 'pbs-remote' }, { $set: { agent, store, tokenId: t.tokenId, tokenSecret: t.tokenSecret }, $unset: { remoteHash: '' } }, { upsert: true });
      req.log.info({ tokenId: t.tokenId, store, created: t.created, applied: t.applied, removed: t.removed }, 'secondary PBS token set by the agent');
      if (current.enabled) pollOffsite(req.log).catch(() => {});
      return { settings: await remoteDto(await loadRemoteSettings()), created: t.created, applied: t.applied, removed: t.removed };
    },
  );

  // reader token on the main PBS (used by the secondary to pull), created by the agent of the main PBS
  app.post<{ Body: { tokenId: string } }>(
    '/api/settings/pbs-remote/reader-token',
    { schema: { body: { type: 'object', required: ['tokenId'], additionalProperties: false, properties: { tokenId: { type: 'string', maxLength: 128 } } } } },
    async (req, reply) => {
      const main = await loadPbsSettings();
      if (!main.agent) return reply.code(409).send({ error: 'PBS principal non relié à son agent (Paramètres › Sauvegardes)' });
      const current = await loadRemoteSettings();
      let t;
      try {
        t = await ensurePbsToken(main.agent, req.body.tokenId.trim(), PBS_TOKEN_ACLS.reader, { tokenId: current.readerTokenId, tokenSecret: current.readerTokenSecret });
      } catch (err) {
        if (err instanceof PbsAgentError) return reply.code(409).send({ error: err.message });
        throw err;
      }
      await settings.updateOne({ _id: 'pbs-remote' }, { $set: { readerTokenId: t.tokenId, readerTokenSecret: t.tokenSecret } }, { upsert: true });
      req.log.info({ tokenId: t.tokenId, created: t.created, applied: t.applied, removed: t.removed }, 'reader token of the main PBS set by the agent');
      if (current.enabled) pollOffsite(req.log).catch(() => {});
      return { settings: await remoteDto(await loadRemoteSettings()), created: t.created, applied: t.applied, removed: t.removed };
    },
  );

  // Copy of a group: enabled / settings (admin). Disabled: its sync job is removed, the copy stays.
  app.put<{ Params: { id: string }; Body: OffsiteBody }>('/api/backups/:id/offsite', { schema: { body: offsiteSchema } }, async (req, reply) => {
    const b = await backups.findOne({ _id: req.params.id });
    if (!b) return reply.code(404).send({ error: 'sauvegarde introuvable' });
    const offsite = await offsiteOf(b, req.body);
    if (typeof offsite === 'string') return reply.code(409).send({ error: offsite });
    await backups.updateOne({ _id: b._id }, { $set: { offsite } });
    // the sync job follows (reconciliation, then the state): published when done
    pollOffsite(req.log).catch(() => {});
    publish('backups', {});
    return backupDto((await backups.findOne({ _id: b._id }))!);
  });

  // Whether the group can be copied now (asked when the copy is enabled in the interface).
  app.get<{ Params: { id: string } }>('/api/backups/:id/offsite/check', async (req, reply) => {
    const b = await backups.findOne({ _id: req.params.id });
    if (!b) return reply.code(404).send({ error: 'sauvegarde introuvable' });
    return checkOffsite(b);
  });

  // Runs the copy now (operator); its result comes with the next poll of the secondary.
  app.post<{ Params: { id: string } }>('/api/backups/:id/offsite/run', async (req, reply) => {
    const b = await backups.findOne({ _id: req.params.id });
    if (!b?.offsite?.enabled) return reply.code(409).send({ error: 'copie déportée non activée pour cette sauvegarde' });
    const r = await loadRemoteSettings();
    if (!remoteReady(r)) return reply.code(409).send({ error: 'PBS de secours non configuré ou désactivé' });
    if (b.offsite.running) return reply.code(409).send({ error: 'copie déjà en cours', jobId: b.offsite.running.jobId || null });
    let upid: string;
    try {
      upid = await runSyncJob(r, b.offsite.jobId);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
    // followed as a job of the hub on the host of the backup: console and Activité
    const jobId = await followTask(r, b, upid, 'manual', req.log);
    return { ok: true, upid, jobId };
  });
}
