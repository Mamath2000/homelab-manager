import type { FastifyInstance } from 'fastify';
import { isOnline } from '../agents.js';
import { hosts, parseId, settings } from '../db.js';
import { hostDto } from '../hostDto.js';
import { MAX_TEXT, canSetup, checkAllHosts, checkHostSetup, isListOption, loadSetupProfile, overridesError, profileError } from '../setup.js';
import { MOTD_STYLES, PROMPT_STYLES, SETUP_OPTIONS, type SetupOption, type SetupOverrides, type SetupProfile } from '../types.js';

const packages = { type: 'array', maxItems: 300, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } };
const keys = { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 16384 } };
const text = { type: 'string', maxLength: MAX_TEXT };
const prompt = { type: 'string', enum: PROMPT_STYLES };
const motd = { type: 'string', enum: MOTD_STYLES };

// JSON schema of the value of each option
const valueSchema: Record<SetupOption, object> = {
  packages,
  ssh_password: { type: 'boolean' },
  root_keys: keys,
  root_aliases: text,
  root_prompt: prompt,
  root_motd: motd,
  user: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'sudoNoPassword'],
    properties: { name: { type: 'string', maxLength: 32 }, sudoNoPassword: { type: 'boolean' } },
  },
  user_keys: keys,
  user_aliases: text,
  user_prompt: prompt,
  user_motd: motd,
};

const profileBody = {
  type: 'object',
  additionalProperties: false,
  required: ['autoApply', 'options', 'fastfetch'],
  properties: {
    autoApply: { type: 'boolean' },
    options: {
      type: 'object',
      additionalProperties: false,
      required: SETUP_OPTIONS,
      properties: Object.fromEntries(
        SETUP_OPTIONS.map((k) => [
          k,
          { type: 'object', additionalProperties: false, required: ['enabled', 'value'], properties: { enabled: { type: 'boolean' }, value: valueSchema[k] } },
        ]),
      ),
    },
    fastfetch: text,
  },
};

const overridesBody = {
  type: 'object',
  additionalProperties: false,
  required: ['overrides'],
  properties: {
    overrides: {
      type: 'object',
      additionalProperties: false,
      // one flat schema per option (no oneOf: Fastify's ajv removes additional properties while trying
      // each branch); overridesError checks that the mode has its field
      properties: Object.fromEntries(
        SETUP_OPTIONS.map((k) => [
          k,
          {
            type: 'object',
            additionalProperties: false,
            required: ['mode'],
            properties: {
              mode: { type: 'string', enum: isListOption(k) ? ['off', 'custom', 'extra'] : ['off', 'custom'] },
              value: valueSchema[k],
              ...(isListOption(k) ? { add: valueSchema[k] } : {}),
            },
          },
        ]),
      ),
    },
  },
};

type ProfileBody = Omit<SetupProfile, '_id'>;

const trimKeys = (l: string[]) => l.map((k) => k.trim()).filter(Boolean);

export function registerSetupRoutes(app: FastifyInstance) {
  // standard configuration (admin: /api/settings/*)
  app.get('/api/settings/setup', async () => {
    const { _id, ...p } = await loadSetupProfile();
    return p;
  });

  app.put<{ Body: ProfileBody }>('/api/settings/setup', { schema: { body: profileBody } }, async (req, reply) => {
    const o = req.body.options;
    const next: SetupProfile = {
      ...req.body,
      _id: 'setup',
      options: {
        ...o,
        root_keys: { ...o.root_keys, value: trimKeys(o.root_keys.value) },
        user_keys: { ...o.user_keys, value: trimKeys(o.user_keys.value) },
        user: { ...o.user, value: { ...o.user.value, name: o.user.value.name.trim() } },
      },
    };
    const err = profileError(next);
    if (err) return reply.code(400).send({ error: err });
    await settings.replaceOne({ _id: 'setup' }, next, { upsert: true });
    // conformity is measured against the profile: check every host again
    checkAllHosts().catch((e) => req.log.warn({ err: e }, 'standardisation check failed'));
    const { _id, ...p } = next;
    return p;
  });

  // what every role sees on a host page: the standard values, shown next to the host ones
  app.get('/api/setup', async () => {
    const p = await loadSetupProfile();
    return { autoApply: p.autoApply, options: p.options };
  });

  // values of one host that differ from the standard configuration; checked again when online
  app.put<{ Params: { id: string }; Body: { overrides: SetupOverrides } }>('/api/hosts/:id/setup', { schema: { body: overridesBody } }, async (req, reply) => {
    const _id = parseId(req.params.id);
    const host = _id && (await hosts.findOne({ _id }));
    if (!host) return reply.code(404).send({ error: 'host not found' });
    const err = overridesError(await loadSetupProfile(), req.body.overrides);
    if (err) return reply.code(400).send({ error: err });
    const updated = (await hosts.findOneAndUpdate({ _id: host._id }, { $set: { setupOverrides: req.body.overrides } }, { returnDocument: 'after' }))!;
    if (canSetup(updated) && isOnline(req.params.id)) {
      checkHostSetup(host._id).catch((e) => req.log.warn({ err: e }, 'standardisation check failed'));
    }
    return hostDto(updated);
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
