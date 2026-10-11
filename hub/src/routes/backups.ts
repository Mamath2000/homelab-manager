import type { FastifyInstance } from 'fastify';
import { backups, hosts, parseId, settings } from '../db.js';
import { publish } from '../events.js';
import {
  FINGERPRINT_RE,
  PBS_URL_RE,
  TOKEN_ID_RE,
  backupDto,
  orphanDto,
  fetchFingerprint,
  loadPbsSettings,
  normalizeFingerprint,
  pbsGet,
  pollPbs,
} from '../pbs.js';
import type { PbsSettings } from '../types.js';

// the token secret never leaves the hub
function settingsDto(s: PbsSettings) {
  const { _id, tokenSecret, ...rest } = s;
  return { ...rest, hasSecret: !!tokenSecret };
}

interface SettingsBody {
  enabled: boolean;
  url: string;
  fingerprint: string;
  tokenId: string;
  tokenSecret?: string; // absent: unchanged
  staleHours: number;
}

const settingsBody = {
  type: 'object',
  additionalProperties: false,
  required: ['enabled', 'url', 'fingerprint', 'tokenId', 'staleHours'],
  properties: {
    enabled: { type: 'boolean' },
    url: { type: 'string', maxLength: 256 },
    fingerprint: { type: 'string', maxLength: 128 },
    tokenId: { type: 'string', maxLength: 128 },
    tokenSecret: { type: 'string', maxLength: 128 },
    staleHours: { type: 'integer', minimum: 1, maximum: 24 * 60 },
  },
} as const;

// Merges the body with the stored settings and validates it; error message or the settings.
async function resolve(body: SettingsBody): Promise<PbsSettings | string> {
  const current = await loadPbsSettings();
  const next: PbsSettings = {
    ...current,
    ...body,
    url: body.url.trim().replace(/\/+$/, ''),
    fingerprint: body.fingerprint ? normalizeFingerprint(body.fingerprint) : '',
    tokenId: body.tokenId.trim(),
    tokenSecret: body.tokenSecret ?? current.tokenSecret,
    _id: 'pbs',
  };
  if (next.url && !PBS_URL_RE.test(next.url)) return 'URL invalide (https://pbs:8007)';
  if (next.fingerprint && !FINGERPRINT_RE.test(next.fingerprint)) return 'empreinte invalide (SHA-256, 32 octets en hexadécimal)';
  if (next.tokenId && !TOKEN_ID_RE.test(next.tokenId)) return 'identifiant du jeton invalide (utilisateur@royaume!jeton)';
  if (next.enabled && (!next.url || !next.tokenId || !next.tokenSecret)) return 'URL, identifiant et secret du jeton sont requis';
  return next;
}

export function registerBackupRoutes(app: FastifyInstance) {
  // --- settings (admin: /api/settings/*)
  app.get('/api/settings/pbs', async () => settingsDto(await loadPbsSettings()));

  app.put<{ Body: SettingsBody }>('/api/settings/pbs', { schema: { body: settingsBody } }, async (req, reply) => {
    const next = await resolve(req.body);
    if (typeof next === 'string') return reply.code(400).send({ error: next });
    await settings.replaceOne({ _id: 'pbs' }, next, { upsert: true });
    if (next.enabled) pollPbs(req.log).catch(() => {});
    else publish('backups', {});
    return settingsDto(next);
  });

  app.post<{ Body: SettingsBody }>('/api/settings/pbs/test', { schema: { body: settingsBody } }, async (req, reply) => {
    const next = await resolve({ ...req.body, enabled: true });
    if (typeof next === 'string') return reply.code(400).send({ error: next });
    try {
      const stores = await pbsGet<{ store: string }[]>(next, '/admin/datastore');
      return { ok: true, datastores: stores.map((d) => d.store) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  app.post<{ Body: { url: string } }>(
    '/api/settings/pbs/fingerprint',
    { schema: { body: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string', maxLength: 256 } } } } },
    async (req, reply) => {
      const url = req.body.url.trim().replace(/\/+$/, '');
      if (!PBS_URL_RE.test(url)) return reply.code(400).send({ error: 'URL invalide (https://pbs:8007)' });
      try {
        return { fingerprint: await fetchFingerprint(url) };
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );

  // --- groups (every role reads)
  app.get('/api/backups', async () => {
    const s = await loadPbsSettings();
    const list = await backups.find().sort({ store: 1, ns: 1, backupId: 1 }).toArray();
    return {
      enabled: s.enabled,
      polledAt: s.polledAt ?? null,
      pollError: s.pollError ?? null,
      staleHours: s.staleHours,
      datastores: s.datastores ?? [],
      // followed: the groups attached to a host; the others are only listed, to be attached
      groups: list.filter((b) => b.hostId).map((b) => backupDto(b, s.staleHours)),
      orphans: list.filter((b) => !b.hostId).map(orphanDto),
    };
  });

  app.post('/api/backups/refresh', async (req, reply) => {
    const s = await loadPbsSettings();
    if (!s.enabled) return reply.code(409).send({ error: 'suivi PBS désactivé (Paramètres > Sauvegardes)' });
    await pollPbs(req.log);
    const after = await loadPbsSettings();
    if (after.pollError) return reply.code(502).send({ error: after.pollError });
    return { ok: true };
  });

  // host of a group (null: detached) and own threshold, from the list of the backups page (admin)
  app.patch<{ Params: { id: string }; Body: { hostId?: string | null; staleHours?: number | null } }>(
    '/api/backups/:id',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            hostId: { type: ['string', 'null'], maxLength: 24 },
            staleHours: { type: ['integer', 'null'], minimum: 1, maximum: 24 * 60 },
          },
        },
      },
    },
    async (req, reply) => {
      const b = await backups.findOne({ _id: req.params.id });
      if (!b) return reply.code(404).send({ error: 'sauvegarde introuvable' });
      const set: Record<string, unknown> = {};
      if (req.body.hostId !== undefined) {
        if (req.body.hostId === null) set.hostId = null;
        else {
          const _id = parseId(req.body.hostId);
          if (!_id || !(await hosts.findOne({ _id }, { projection: { _id: 1 } }))) return reply.code(400).send({ error: 'hôte introuvable' });
          set.hostId = _id;
        }
      }
      if (req.body.staleHours !== undefined) set.staleHours = req.body.staleHours;
      await backups.updateOne({ _id: b._id }, { $set: set });
      publish('backups', {});
      const s = await loadPbsSettings();
      return backupDto((await backups.findOne({ _id: b._id }))!, s.staleHours);
    },
  );

  // Backups of a host, chosen on its page: these groups are attached to it (moved from another host
  // if need be), the ones it had and that are not in the list become orphans (admin).
  app.put<{ Params: { id: string }; Body: { ids: string[] } }>(
    '/api/hosts/:id/backups',
    {
      schema: {
        body: {
          type: 'object',
          required: ['ids'],
          additionalProperties: false,
          properties: { ids: { type: 'array', maxItems: 500, uniqueItems: true, items: { type: 'string', maxLength: 512 } } },
        },
      },
    },
    async (req, reply) => {
      const _id = parseId(req.params.id);
      if (!_id || !(await hosts.findOne({ _id }, { projection: { _id: 1 } }))) return reply.code(404).send({ error: 'host not found' });
      const found = await backups.countDocuments({ _id: { $in: req.body.ids } });
      if (found !== req.body.ids.length) return reply.code(400).send({ error: 'sauvegarde introuvable' });
      await backups.updateMany({ hostId: _id, _id: { $nin: req.body.ids } }, { $set: { hostId: null } });
      await backups.updateMany({ _id: { $in: req.body.ids } }, { $set: { hostId: _id } });
      publish('backups', {});
      const s = await loadPbsSettings();
      return (await backups.find({ hostId: _id }).toArray()).map((b) => backupDto(b, s.staleHours));
    },
  );

  // an orphan no longer on the PBS (gone) can be forgotten (admin)
  app.delete<{ Params: { id: string } }>('/api/backups/:id', async (req, reply) => {
    const res = await backups.deleteOne({ _id: req.params.id, gone: true, hostId: null });
    if (!res.deletedCount) return reply.code(409).send({ error: 'seule une sauvegarde orpheline disparue du PBS peut être oubliée' });
    publish('backups', {});
    return reply.code(204).send();
  });
}
