import type { FastifyInstance } from 'fastify';
import { isOnline } from '../agents.js';
import { hosts, parseId, settings } from '../db.js';
import { hostDto } from '../hostDto.js';
import { MAX_TEXT, canSetup, checkAllHosts, checkHostSetup, loadSetupProfile, profileError } from '../setup.js';
import { MOTD_STYLES, PROMPT_STYLES, SETUP_MODULES, type SetupProfile } from '../types.js';

const profileBody = {
  type: 'object',
  additionalProperties: false,
  required: ['autoApply', 'modules', 'user', 'sudoNoPassword', 'packages', 'sshKeys', 'allowPassword', 'aliases', 'prompt', 'motd', 'fastfetch'],
  properties: {
    autoApply: { type: 'boolean' },
    modules: { type: 'array', maxItems: SETUP_MODULES.length, uniqueItems: true, items: { type: 'string', enum: SETUP_MODULES } },
    user: { type: 'string', maxLength: 32 },
    sudoNoPassword: { type: 'boolean' },
    packages: { type: 'array', maxItems: 300, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
    sshKeys: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 16384 } },
    allowPassword: { type: 'boolean' },
    aliases: { type: 'string', maxLength: MAX_TEXT },
    prompt: { type: 'string', enum: PROMPT_STYLES },
    motd: { type: 'string', enum: MOTD_STYLES },
    fastfetch: { type: 'string', maxLength: MAX_TEXT },
  },
} as const;

type ProfileBody = Omit<SetupProfile, '_id'>;

export function registerSetupRoutes(app: FastifyInstance) {
  // standard configuration (admin: /api/settings/*)
  app.get('/api/settings/setup', async () => {
    const { _id, ...p } = await loadSetupProfile();
    return p;
  });

  app.put<{ Body: ProfileBody }>('/api/settings/setup', { schema: { body: profileBody } }, async (req, reply) => {
    const next: SetupProfile = {
      ...req.body,
      _id: 'setup',
      user: req.body.user.trim(),
      sshKeys: req.body.sshKeys.map((k) => k.trim()).filter(Boolean),
    };
    const err = profileError(next);
    if (err) return reply.code(400).send({ error: err });
    await settings.replaceOne({ _id: 'setup' }, next, { upsert: true });
    // conformity is measured against the profile: check every host again
    checkAllHosts().catch((e) => req.log.warn({ err: e }, 'standardisation check failed'));
    const { _id, ...p } = next;
    return p;
  });

  // what every role sees on a host page: the options of the standard configuration and its user
  app.get('/api/setup', async () => {
    const p = await loadSetupProfile();
    return { modules: p.modules, user: p.user, autoApply: p.autoApply };
  });

  app.post<{ Params: { id: string } }>('/api/hosts/:id/setup/check', async (req, reply) => {
    const _id = parseId(req.params.id);
    const host = _id && (await hosts.findOne({ _id }));
    if (!host) return reply.code(404).send({ error: 'host not found' });
    if (!canSetup(host)) return reply.code(400).send({ error: "la standardisation n'est pas disponible sur cet hôte" });
    if (!isOnline(req.params.id)) return reply.code(409).send({ error: 'hôte hors ligne' });
    try {
      await checkHostSetup(host._id);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
    return hostDto((await hosts.findOne({ _id: host._id }))!);
  });
}
