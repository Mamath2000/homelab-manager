import type { FastifyInstance } from 'fastify';
import { backups, hosts, parseId, settings } from '../db.js';
import { publish } from '../events.js';
import {
  FINGERPRINT_RE,
  PBS_URL_RE,
  TOKEN_ID_RE,
  backupDto,
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
      groups: list.map((b) => backupDto(b, s.staleHours)),
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

  // host it belongs to (null: no host; "auto": automatic matching again), own threshold, ignored (admin)
  app.patch<{ Params: { id: string }; Body: { hostId?: string | null; staleHours?: number | null; ignored?: boolean } }>(
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
            ignored: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const b = await backups.findOne({ _id: req.params.id });
      if (!b) return reply.code(404).send({ error: 'sauvegarde introuvable' });
      const set: Record<string, unknown> = {};
      const unset: Record<string, ''> = {};
      if (req.body.hostId !== undefined) {
        if (req.body.hostId === 'auto') {
          unset.hostPinned = '';
          set.hostId = null; // matched again at the next poll
        } else if (req.body.hostId === null) {
          set.hostId = null;
          set.hostPinned = true;
        } else {
          const _id = parseId(req.body.hostId);
          if (!_id || !(await hosts.findOne({ _id }, { projection: { _id: 1 } }))) return reply.code(400).send({ error: 'hôte introuvable' });
          set.hostId = _id;
          set.hostPinned = true;
        }
      }
      if (req.body.staleHours !== undefined) set.staleHours = req.body.staleHours;
      if (req.body.ignored !== undefined) set.ignored = req.body.ignored;
      await backups.updateOne({ _id: b._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
      publish('backups', {});
      if (req.body.hostId === 'auto') pollPbs(req.log).catch(() => {});
      const s = await loadPbsSettings();
      return backupDto((await backups.findOne({ _id: b._id }))!, s.staleHours);
    },
  );

  // a group no longer on the PBS (gone) can be forgotten (admin)
  app.delete<{ Params: { id: string } }>('/api/backups/:id', async (req, reply) => {
    const res = await backups.deleteOne({ _id: req.params.id, gone: true });
    if (!res.deletedCount) return reply.code(409).send({ error: 'seul un groupe disparu du PBS peut être oublié' });
    publish('backups', {});
    return reply.code(204).send();
  });
}
