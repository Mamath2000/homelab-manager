import type { FastifyInstance } from 'fastify';
import { STORE_RE } from '../backupJobs.js';
import { parseCalendar } from '../calendar.js';
import { backups, settings } from '../db.js';
import { publish } from '../events.js';
import {
  OFFSITE_DEFAULTS,
  RATE_RE,
  loadRemoteSettings,
  notCopiable,
  pollOffsite,
  remoteReady,
  runSyncJob,
  sameGroupElsewhere,
  syncJobId,
  targetNamespaces,
} from '../offsite.js';
import { FINGERPRINT_RE, PBS_URL_RE, backupDto, loadPbsSettings, normalizeFingerprint, pbsGet } from '../pbs.js';
import { PBS_TOKEN_ACLS, PbsAgentError, checkLink, ensurePbsToken, offsiteHubAcls } from '../pbsAgent.js';
import type { BackupDoc, BackupOffsite, PbsAgentLink, PbsRemoteSettings } from '../types.js';

// Secondary PBS and the copy of the backups to it (offsite.ts). Settings: admin (/api/settings/*); running
// a copy now: operator too (roles.ts).

function remoteDto(r: PbsRemoteSettings) {
  const { _id, tokenSecret, readerTokenSecret, remoteHash, ...rest } = r;
  void _id;
  void remoteHash;
  return { ...rest, hasSecret: !!tokenSecret, hasReaderSecret: !!readerTokenSecret };
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
}

const remoteBody = {
  type: 'object',
  additionalProperties: false,
  required: ['enabled', 'url', 'fingerprint'],
  properties: { enabled: { type: 'boolean' }, url: { type: 'string', maxLength: 256 }, fingerprint: { type: 'string', maxLength: 128 }, agent: agentLinkSchema },
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
  };
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
  schedule?: string;
  transferLast?: number | null;
  rateIn?: string | null;
}

export const offsiteSchema = {
  type: 'object',
  required: ['enabled'],
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    schedule: { type: 'string', maxLength: 64 },
    transferLast: { type: ['integer', 'null'], minimum: 1, maximum: 1000 },
    rateIn: { type: ['string', 'null'], maxLength: 16 },
  },
} as const;

// Settings of the copy of a group, checked; error message or the new offsite member.
export async function offsiteOf(b: BackupDoc, body: OffsiteBody): Promise<BackupOffsite | string> {
  const cur = b.offsite;
  const next: BackupOffsite = {
    ...cur,
    enabled: body.enabled,
    schedule: (body.schedule ?? cur?.schedule ?? OFFSITE_DEFAULTS.schedule).trim(),
    transferLast: body.transferLast !== undefined ? body.transferLast : (cur?.transferLast ?? OFFSITE_DEFAULTS.transferLast),
    rateIn: body.rateIn !== undefined ? body.rateIn?.trim() || null : (cur?.rateIn ?? OFFSITE_DEFAULTS.rateIn),
    jobId: syncJobId(b._id),
    since: cur?.enabled ? cur.since : Date.now(),
  };
  if (!parseCalendar(next.schedule)) return 'planification invalide (ex. 06:00, mon..fri 21:00)';
  if (next.rateIn && !RATE_RE.test(next.rateIn)) return 'débit invalide (ex. 10MiB, 500KB)';
  if (!next.enabled) return next;
  const why = notCopiable(b);
  if (why) return why;
  const r = await loadRemoteSettings();
  if (!remoteReady(r)) return 'PBS de secours non configuré ou désactivé (Paramètres › Sauvegardes)';
  const others = await backups.find({ 'offsite.enabled': true }, { projection: { _id: 1, store: 1, ns: 1, type: 1, backupId: 1 } }).toArray();
  const twin = sameGroupElsewhere(b, others);
  if (twin) return `${b.ns || 'racine'}/${b.type}/${b.backupId} est déjà copié depuis le datastore ${twin.store} : une seule copie par groupe`;
  // the sync job cannot create the target namespace (no Datastore.Modify for the token of the hub)
  if (b.ns && !cur?.enabled) {
    let nss: string[];
    try {
      nss = await targetNamespaces(r);
    } catch (err) {
      return `PBS de secours : ${(err as Error).message}`;
    }
    if (!nss.includes(b.ns)) return `namespace ${b.ns} absent du datastore ${r.store} du PBS de secours : le créer dans PBS, puis réessayer`;
  }
  return next;
}

export function registerOffsiteRoutes(app: FastifyInstance) {
  app.get('/api/settings/pbs-remote', async () => remoteDto(await loadRemoteSettings()));

  app.put<{ Body: RemoteBody }>('/api/settings/pbs-remote', { schema: { body: remoteBody } }, async (req, reply) => {
    const next = await resolve(req.body);
    if (typeof next === 'string') return reply.code(400).send({ error: next });
    await settings.replaceOne({ _id: 'pbs-remote' }, next, { upsert: true });
    if (next.enabled) pollOffsite(req.log).catch(() => {});
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
      return { settings: remoteDto(await loadRemoteSettings()), created: t.created, applied: t.applied, removed: t.removed };
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
      return { settings: remoteDto(await loadRemoteSettings()), created: t.created, applied: t.applied, removed: t.removed };
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

  // Runs the copy now (operator); its result comes with the next poll of the secondary.
  app.post<{ Params: { id: string } }>('/api/backups/:id/offsite/run', async (req, reply) => {
    const b = await backups.findOne({ _id: req.params.id });
    if (!b?.offsite?.enabled) return reply.code(409).send({ error: 'copie déportée non activée pour cette sauvegarde' });
    const r = await loadRemoteSettings();
    if (!remoteReady(r)) return reply.code(409).send({ error: 'PBS de secours non configuré ou désactivé' });
    try {
      const upid = await runSyncJob(r, b.offsite.jobId);
      return { ok: true, upid };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
