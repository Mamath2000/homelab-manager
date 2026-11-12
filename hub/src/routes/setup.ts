import type { FastifyInstance } from 'fastify';
import { settingsDiff } from '../audit.js';
import { isOnline } from '../agents.js';
import { config } from '../config.js';
import { hosts, parseId, settings } from '../db.js';
import { publish } from '../events.js';
import { hostDto } from '../hostDto.js';
import { MAX_TEXT, applySetup, canSetup, checkAllHosts, checkHostSetup, effectiveValues, isListOption, loadSetupProfile, overridesError, profileError } from '../setup.js';
import { ACCESS_OPTIONS, MOTD_STYLES, PROMPT_STYLES, SETUP_OPTIONS, type SetupOption, type SetupOverrides, type SetupProfile } from '../types.js';

const packages = { type: 'array', maxItems: 300, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } };
const keys = { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 16384 } };
const text = { type: 'string', maxLength: MAX_TEXT };
const prompt = { type: 'string', enum: PROMPT_STYLES };
const motd = { type: 'string', enum: MOTD_STYLES };

// JSON schema of the value of each option
const valueSchema: Record<SetupOption, object> = {
  packages,
  ssh_password: { type: 'boolean' },
  // a log-server role of the hub ("": no forwarding)
  log_forward: { type: 'object', additionalProperties: false, required: ['role'], properties: { role: { type: 'string', maxLength: 32 } } },
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
  required: ['autoApply', 'options', 'fastfetch', 'starship'],
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
    starship: text,
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
  // FEATURE_STANDARDISATION off: no route (404)
  if (!config.featureStandardisation) return;
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
    const before = await loadSetupProfile();
    await settings.replaceOne({ _id: 'setup' }, next, { upsert: true });
    // the options with their values (SSH keys as fingerprints), the rest by name
    const top = settingsDiff(before, next, ['_id', 'options']);
    const opts = settingsDiff(before.options, next.options, [], true);
    req.auditNote = { details: { changed: [...top.changed, ...opts.changed], values: { ...top.values, ...opts.values } } };
    // conformity is measured against the profile: check every host again
    checkAllHosts().catch((e) => req.log.warn({ err: e }, 'standardisation check failed'));
    const { _id, ...p } = next;
    return p;
  });

  // Pushes the access options (root keys, sudo user and its keys) to the hosts that manage them, after a change of the
  // standard. Offline hosts keep the old keys (their check shows the difference) until the next application.
  app.post('/api/settings/access/apply', async (req, reply) => {
    const p = await loadSetupProfile();
    let started = 0;
    const offline: string[] = [];
    for (const host of await hosts.find({ capabilities: 'setup' }).toArray()) {
      if (!canSetup(host)) continue;
      const v = effectiveValues(p, host.setupOverrides);
      if (!ACCESS_OPTIONS.some((k) => k in v)) continue;
      if (!isOnline(host._id.toHexString())) {
        offline.push(host.name);
        continue;
      }
      await applySetup(host, 'manual', [...ACCESS_OPTIONS]);
      started++;
    }
    req.auditNote = { details: { started, offline } };
    reply.code(202);
    return { started, offline };
  });

  // what every profile sees on a host page: the standard values, shown next to the host ones
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
    req.auditNote = { target: { kind: 'host', id: req.params.id, name: host.name }, details: settingsDiff(host.setupOverrides, req.body.overrides, [], true) };
    if (canSetup(updated) && isOnline(req.params.id)) {
      checkHostSetup(host._id).catch((e) => req.log.warn({ err: e }, 'standardisation check failed'));
    }
    return hostDto(updated);
  });

  // Validates (or cancels the validation of) a key found on the host outside the manifest: it no longer raises the
  // « nouvelle clé SSH » badge. Bound to the fingerprint, dropped by the next check once the key has left the host.
  app.put<{ Params: { id: string }; Body: { account: string; fingerprint: string; acknowledged: boolean } }>(
    '/api/hosts/:id/access-keys/ack',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['account', 'fingerprint', 'acknowledged'],
          properties: {
            account: { type: 'string', minLength: 1, maxLength: 64 },
            fingerprint: { type: 'string', minLength: 1, maxLength: 128 },
            acknowledged: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const _id = parseId(req.params.id);
      const host = _id && (await hosts.findOne({ _id }));
      if (!host) return reply.code(404).send({ error: 'host not found' });
      const { account, fingerprint, acknowledged } = req.body;
      const same = (a: { account: string; fingerprint: string }) => a.account === account && a.fingerprint === fingerprint;
      const key = host.setup?.access?.keys.find(same);
      if (acknowledged && (!key || key.managed)) return reply.code(404).send({ error: "clé inconnue sur cet hôte ou déjà gérée par le manifeste" });
      const kept = (host.ackedKeys ?? []).filter((a) => !same(a));
      const ackedKeys = acknowledged ? [...kept, { account, fingerprint }] : kept;
      const updated = (await hosts.findOneAndUpdate({ _id: host._id }, { $set: { ackedKeys } }, { returnDocument: 'after' }))!;
      req.auditNote = { target: { kind: 'host', id: req.params.id, name: host.name }, details: { account, fingerprint, acknowledged, comment: key?.comment } };
      publish('host', hostDto(updated));
      return hostDto(updated);
    },
  );

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
