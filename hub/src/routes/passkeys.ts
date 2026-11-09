import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { FastifyInstance } from 'fastify';
import { parseId, passkeys, sessions } from '../db.js';
import { finishRegistration, mfaRequiredFor, passkeyDto, passkeysEnabled, registrationOptions, userPasskeys } from '../passkeys.js';

// The passkeys of the logged-in account (homelab#291). Registering one needs a session of the account (the challenge
// is bound to it), not an API key.
export function registerPasskeyRoutes(app: FastifyInstance) {
  app.get('/api/account/passkeys', async (req) => (await userPasskeys(req.user!._id)).map(passkeyDto));

  app.post('/api/account/passkeys/options', async (req, reply) => {
    if (!passkeysEnabled()) return reply.code(409).send({ error: 'passkeys_disabled' });
    if (!req.sessionId) return reply.code(400).send({ error: 'session_required' });
    return registrationOptions(req.user!, req.sessionId);
  });

  app.post<{ Body: { name: string; response: RegistrationResponseJSON } }>(
    '/api/account/passkeys',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'response'],
          additionalProperties: false,
          properties: { name: { type: 'string', minLength: 1, maxLength: 64, pattern: '\\S' }, response: { type: 'object' } },
        },
      },
    },
    async (req, reply) => {
      const user = req.user!;
      if (!passkeysEnabled()) return reply.code(409).send({ error: 'passkeys_disabled' });
      if (!req.sessionId) return reply.code(400).send({ error: 'session_required' });
      const doc = await finishRegistration(user, req.sessionId, req.body.name.trim(), req.body.response).catch(() => null);
      if (!doc) return reply.code(400).send({ error: 'passkey_refused' });
      req.auditNote = { target: { kind: 'account', id: user._id.toHexString(), name: user.username }, details: { passkey: doc.name } };
      // the session holds a passkey of the account now: MFA_REQUIRED is satisfied without logging in again
      await sessions.updateOne({ _id: req.sessionId }, { $set: { mfaAt: new Date() } });
      return passkeyDto(doc);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/account/passkeys/:id', async (req, reply) => {
    const user = req.user!;
    const id = parseId(req.params.id);
    const key = id && (await passkeys.findOne({ _id: id, userId: user._id }));
    if (!key) return reply.code(404).send({ error: 'passkey not found' });
    req.auditNote = { target: { kind: 'account', id: user._id.toHexString(), name: user.username }, details: { passkey: key.name } };
    // MFA_REQUIRED: the last passkey of an admin stays (removing it would lift the obligation)
    if (mfaRequiredFor(user) && (await passkeys.countDocuments({ userId: user._id })) <= 1) {
      return reply.code(409).send({ error: 'last passkey' });
    }
    await passkeys.deleteOne({ _id: key._id });
    return reply.code(204).send();
  });
}
