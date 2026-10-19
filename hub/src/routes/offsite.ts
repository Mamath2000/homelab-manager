import type { FastifyInstance } from 'fastify';
import { STORE_RE } from '../backupJobs.js';
import { backups, settings } from '../db.js';
import { publish } from '../events.js';
import {
  AdhocError,
  HHMM_RE,
  adhocBlocker,
  loadRemoteSettings,
  notCopiable,
  offsiteState,
  pollOffsite,
  remoteReady,
  runAdhoc,
  sameGroupElsewhere,
  seriesView,
  startOf,
  syncJobId,
  syncOffsiteAgent,
  targetNamespaces,
} from '../offsite.js';
import { FINGERPRINT_RE, PBS_URL_RE, backupDto, loadPbsSettings, normalizeFingerprint, pbsConnected, pbsGet } from '../pbs.js';
import { disconnectRemote, remoteConfigured } from '../disconnect.js';
import { PBS_TOKEN_ACLS, PbsAgentError, checkLink, ensurePbsToken, offsiteHubAcls, sameLink } from '../pbsAgent.js';
import type { BackupDoc, BackupOffsite, PbsAgentLink, PbsRemoteSettings } from '../types.js';

// Secondary PBS and the copy of the backups to it (offsite.ts). Settings: admin (/api/settings/*); running
// a copy now: operator too (roles.ts).

async function remoteDto(r: PbsRemoteSettings) {
  const { _id, tokenSecret, readerTokenSecret, remoteHash, agentAck, agentError, agentReport, ...rest } = r;
  void _id;
  void remoteHash;
  void agentAck;
  void agentError;
  void agentReport;
  return { ...rest, startTime: startOf(r), series: await seriesView(r), hasSecret: !!tokenSecret, hasReaderSecret: !!readerTokenSecret, connected: remoteReady(r) };
}

const agentLinkSchema = {
  type: 'object',
  required: ['hostId', 'mode'],
  additionalProperties: false,
  properties: { hostId: { type: 'string', maxLength: 24 }, mode: { type: 'string', enum: ['native', 'container'] }, container: { type: 'string', maxLength: 128 } },
} as const;

interface RemoteBody {
  url: string;
  fingerprint: string;
  agent?: PbsAgentLink;
  startTime?: string;
}

const remoteBody = {
  type: 'object',
  additionalProperties: false,
  required: ['url', 'fingerprint'],
  properties: { url: { type: 'string', maxLength: 256 }, fingerprint: { type: 'string', maxLength: 128 }, agent: agentLinkSchema, startTime: { type: 'string', maxLength: 5 } },
} as const;

const nativeOrContainer = (a: PbsAgentLink): PbsAgentLink => (a.mode === 'native' ? { hostId: a.hostId, mode: 'native' } : a);

async function resolve(body: RemoteBody): Promise<PbsRemoteSettings | string> {
  const current = await loadRemoteSettings();
  const next: PbsRemoteSettings = {
    ...current,
    url: body.url.trim().replace(/\/+$/, ''),
    fingerprint: body.fingerprint ? normalizeFingerprint(body.fingerprint) : '',
    ...(body.agent ? { agent: nativeOrContainer(body.agent) } : {}),
    ...(body.startTime !== undefined ? { startTime: body.startTime } : {}),
  };
  if (body.startTime !== undefined && !HHMM_RE.test(body.startTime)) return 'heure de départ invalide (HH:MM)';
  if (next.url && !PBS_URL_RE.test(next.url)) return 'URL invalide (https://pbs:8007)';
  if (next.fingerprint && !FINGERPRINT_RE.test(next.fingerprint)) return 'empreinte invalide (SHA-256, 32 octets en hexadécimal)';
  if (next.agent) {
    const bad = checkLink(next.agent);
    if (bad) return bad;
    if (await isMainPbsHost(next.agent.hostId)) return 'cet hôte porte le PBS principal : choisir un autre hôte pour le PBS de secours';
  }
  if (next.url && !pbsConnected(await loadPbsSettings())) return 'PBS principal non connecté';
  return next;
}

// The secondary cannot be the main PBS: its host is the one the main PBS is linked to.
async function isMainPbsHost(hostId: string) {
  return (await loadPbsSettings()).agent?.hostId === hostId;
}

interface OffsiteBody {
  enabled: boolean;
}

export const offsiteSchema = {
  type: 'object',
  required: ['enabled'],
  additionalProperties: false,
  properties: { enabled: { type: 'boolean' } },
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
  if (!remoteReady(r)) return { ok: false, error: 'PBS de secours non connecté (Paramètres › Sauvegardes)' };
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

// Copy of a group enabled or not, checked; error message or the new offsite member.
export async function offsiteOf(b: BackupDoc, body: OffsiteBody): Promise<BackupOffsite | string> {
  const cur = b.offsite;
  // settings of before #186 (schedule, rate, queue) are dropped
  const { transferLast, rateIn, schedule, queued, ...kept } = (cur ?? {}) as BackupOffsite & Record<'transferLast' | 'rateIn' | 'schedule' | 'queued', unknown>;
  void [transferLast, rateIn, schedule, queued];
  const next: BackupOffsite = {
    ...kept,
    enabled: body.enabled,
    jobId: syncJobId(b.store, b.ns),
    since: cur?.enabled ? cur.since : Date.now(),
  };
  if (!next.enabled) return next;
  // already copied: its namespace is there (not asked again)
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
    if (remoteReady(next)) pollOffsite(req.log).catch(() => {});
    // not complete: the agent of the secondary has no series to start
    else syncOffsiteAgent().catch((err) => req.log.warn({ err }, 'offsite series definition not sent'));
    publish('backups', {});
    return remoteDto(next);
  });

  // datastores the token of the hub sees, and the namespaces of the target one
  app.post<{ Body: RemoteBody }>('/api/settings/pbs-remote/test', { schema: { body: remoteBody } }, async (req, reply) => {
    const next = await resolve(req.body);
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
      if (await isMainPbsHost(agent.hostId)) return reply.code(400).send({ error: 'cet hôte porte le PBS principal : choisir un autre hôte pour le PBS de secours' });
      let t;
      try {
        t = await ensurePbsToken(agent, req.body.tokenId.trim(), offsiteHubAcls(store), sameLink(current.agent, agent) ? current : null);
      } catch (err) {
        if (err instanceof PbsAgentError) return reply.code(409).send({ error: err.message });
        throw err;
      }
      // the remote entry belongs to the token: written again with the next one
      await settings.updateOne({ _id: 'pbs-remote' }, { $set: { agent, store, tokenId: t.tokenId, tokenSecret: t.tokenSecret }, $unset: { remoteHash: '' } }, { upsert: true });
      req.log.info({ tokenId: t.tokenId, store, created: t.created, rotated: t.rotated, applied: t.applied, removed: t.removed }, 'secondary PBS token set by the agent');
      pollOffsite(req.log).catch(() => {});
      return { settings: await remoteDto(await loadRemoteSettings()), created: t.created, rotated: t.rotated, applied: t.applied, removed: t.removed };
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
      req.log.info({ tokenId: t.tokenId, created: t.created, rotated: t.rotated, applied: t.applied, removed: t.removed }, 'reader token of the main PBS set by the agent');
      pollOffsite(req.log).catch(() => {});
      return { settings: await remoteDto(await loadRemoteSettings()), created: t.created, rotated: t.rotated, applied: t.applied, removed: t.removed };
    },
  );

  // Disconnection of the secondary (disconnect.ts): series, sync jobs hlm-*, remote hlm-main and both tokens
  // removed; the copies stay on it.
  app.post('/api/settings/pbs-remote/disconnect', async (req, reply) => {
    if (!remoteConfigured(await loadRemoteSettings())) return reply.code(409).send({ error: 'aucun PBS de secours configuré' });
    try {
      return await disconnectRemote(req.log);
    } catch (err) {
      if (err instanceof PbsAgentError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  // Copy of a group: enabled or not (admin). Disabled: its group leaves the filter of its sync job (the job is
  // removed with the last group of its namespace), the copy stays.
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

  // Copies now the last verified snapshot of the group (operator): a temporary sync job, followed as a job of
  // the hub (console, Activité) and removed at its end. May run beside the daily series; refused for a group
  // already being copied, up to date, or with nothing verified to copy.
  app.post<{ Params: { id: string } }>('/api/backups/:id/offsite/run', async (req, reply) => {
    const b = await backups.findOne({ _id: req.params.id });
    if (!b) return reply.code(404).send({ error: 'sauvegarde introuvable' });
    const r = await loadRemoteSettings();
    if (!remoteReady(r)) return reply.code(409).send({ error: 'PBS de secours non configuré ou désactivé' });
    const why = notCopiable(b) ?? adhocBlocker(b, offsiteState(b));
    if (why) return reply.code(409).send({ error: why, jobId: b.offsite?.running?.jobId || null });
    try {
      return { ok: true, ...(await runAdhoc(r, b, req.log)) };
    } catch (err) {
      if (err instanceof AdhocError) return reply.code(409).send({ error: err.message });
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
