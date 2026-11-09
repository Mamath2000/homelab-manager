import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { ObjectId } from 'mongodb';
import { actorOf, recordAudit, recordAuthFailure } from './audit.js';
import { config } from './config.js';
import { dummyPasswordHash, hashPassword, randomToken, sha256, verifyPasswordOrDummy } from './crypto.js';
import { apiKeys, sessions, users } from './db.js';
import { closeStreams } from './events.js';
import { accountKey, apiKeyLimit, ipKey, loginLimits, pairKey, tooManyAttempts } from './loginGuard.js';
import { passwordProblem } from './passwordPolicy.js';
import { finishLogin, loginChallenge, mfaRequiredFor, passkeysEnabled, reauthNeeded } from './passkeys.js';
import { allowedBeforePasskey, allowedBeforePasswordChange, authorize, sensitiveAction } from './profiles.js';
import { cookieSecure, httpsUrl, transport } from './transport.js';
import { SUPERADMIN, type SessionDoc, type UserDoc } from './types.js';

const COOKIE = 'hm_session';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserDoc;
    // the session the request came with (not set for an API key)
    sessionId?: string;
    // when that session was proven with a passkey
    mfaAt?: Date;
  }
}

// Decided on the matched route pattern, never on the raw URL: the router decodes
// percent-escapes ("/%61pi/hosts" is routed to "/api/hosts").
function isPublic(req: FastifyRequest) {
  const route = req.routeOptions.url;
  // unmatched requests only reach the 404 / SPA fallback
  if (!route) return true;
  // static UI and the notice of the old install script (the agents use their own TLS server)
  if (!route.startsWith('/api/')) return true;
  return route.startsWith('/api/auth/') || route === '/api/health';
}

// the superadmin only gets a short session out of its one-time password
const SUPERADMIN_SESSION_MS = 15 * 60_000;
const DAY_MS = 24 * 3600_000;
// a use moves the idle timeout at most once a minute: one write, not one per request
const TOUCH_MS = 60_000;
// sent by the UI on the requests it makes while nobody uses it (refreshes): they keep the session as it is
const BACKGROUND_HEADER = 'x-hm-background';

const idleMs = () => config.sessionIdleHours * 3600_000;

// Effective end of a session: its absolute end, or the idle timeout from its last use, whichever comes first.
export function sessionExpiry(endsAt: Date, lastSeenAt: Date, idle: number) {
  return new Date(Math.min(endsAt.getTime(), lastSeenAt.getTime() + idle));
}

function client(req: FastifyRequest) {
  return { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 256) };
}

async function startSession(req: FastifyRequest, reply: FastifyReply, user: UserDoc, mfa = false) {
  const token = randomToken();
  const now = new Date();
  const endsAt = new Date(now.getTime() + (user.profile === SUPERADMIN ? SUPERADMIN_SESSION_MS : config.sessionMaxDays * DAY_MS));
  await sessions.insertOne({
    _id: sha256(token),
    userId: user._id,
    expiresAt: sessionExpiry(endsAt, now, idleMs()),
    endsAt,
    createdAt: now,
    lastSeenAt: now,
    ...client(req),
    ...(mfa ? { mfaAt: now } : {}),
  });
  // the cookie lives until the absolute end; the idle timeout is decided here
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieSecure(req),
    expires: endsAt,
  });
}

// A use of the session (not a background refresh of the UI) moves its idle timeout. A session opened before
// homelab#291 gets an absolute end at its first request, no later than its former expiry.
async function touchSession(req: FastifyRequest, session: SessionDoc) {
  const background = req.headers[BACKGROUND_HEADER] === '1';
  const now = new Date();
  if (session.endsAt && (background || (session.lastSeenAt && now.getTime() - session.lastSeenAt.getTime() < TOUCH_MS))) return;
  const endsAt = session.endsAt ?? new Date(Math.min(session.expiresAt.getTime(), now.getTime() + config.sessionMaxDays * DAY_MS));
  const lastSeenAt = background && session.lastSeenAt ? session.lastSeenAt : now;
  await sessions.updateOne(
    { _id: session._id },
    { $set: { endsAt, lastSeenAt, expiresAt: sessionExpiry(endsAt, lastSeenAt, idleMs()), ...client(req) } },
  );
}

export const API_KEY_PREFIX = 'hm_';

export function newApiKey() {
  const key = API_KEY_PREFIX + randomToken();
  return { key, hash: sha256(key) };
}

// `Authorization: Bearer hm_…`: undefined when the request carries no key, null when it is unknown
async function userFromApiKey(req: FastifyRequest) {
  const match = /^Bearer (hm_\S+)$/.exec(req.headers.authorization ?? '');
  if (!match) return undefined;
  const key = await apiKeys.findOneAndUpdate({ hash: sha256(match[1]) }, { $set: { lastUsedAt: new Date() } });
  if (!key) return null;
  const user = await users.findOne({ _id: key.userId, profile: { $ne: SUPERADMIN } });
  if (user) req.apiKey = { id: key._id, name: key.name };
  return user;
}

async function userFromRequest(req: FastifyRequest) {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  const session = await sessions.findOne({ _id: sha256(token), expiresAt: { $gt: new Date() } });
  if (!session) return null;
  req.sessionId = session._id;
  req.mfaAt = session.mfaAt;
  await touchSession(req, session);
  return users.findOne({ _id: session.userId });
}

export function activeSessions(userId: ObjectId) {
  return sessions.find({ userId, expiresAt: { $gt: new Date() } }).sort({ lastSeenAt: -1 }).toArray();
}

// The id is the hash of the cookie token: it cannot be turned back into a session.
export function sessionDto(s: SessionDoc, current?: string) {
  return {
    id: s._id,
    createdAt: s.createdAt ?? null,
    lastSeenAt: s.lastSeenAt ?? null,
    expiresAt: s.expiresAt,
    ip: s.ip ?? null,
    userAgent: s.userAgent ?? null,
    current: s._id === current,
  };
}

// also closes the live streams of the account, whatever they were opened with
export function revokeSessions(user: Pick<UserDoc, '_id'>) {
  closeStreams({ userId: user._id });
  return sessions.deleteMany({ userId: user._id });
}

const loginSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    additionalProperties: false,
    properties: {
      username: { type: 'string', minLength: 1, maxLength: 64 },
      password: { type: 'string', minLength: 1, maxLength: 256 },
    },
  },
} as const;

function me(user: UserDoc, mfaAt?: Date) {
  return {
    username: user.username,
    displayName: user.displayName ?? '',
    profile: user.profile,
    mustChangePassword: !!user.mustChangePassword,
    // passkeys: offered by this hub, required for this account (MFA_REQUIRED), used by this session
    mfa: { available: passkeysEnabled(), required: mfaRequiredFor(user), satisfied: !!mfaAt },
    // optional features of the hub (environment variables)
    features: { standardisation: config.featureStandardisation },
    channel: config.channel,
  };
}

// Constant cost: scrypt runs whether the account exists, has a password, or is an expired superadmin, so that the
// response time does not tell these cases apart (homelab#292).
export async function checkPassword(user: UserDoc | null, password: string, verify = verifyPasswordOrDummy) {
  const usable =
    !!user?.passwordHash &&
    !!password &&
    !(user.profile === SUPERADMIN && !(user.passwordExpiresAt && user.passwordExpiresAt > new Date()));
  const ok = await verify(password, usable ? user!.passwordHash : null);
  return usable && ok;
}

// A failed login counts for the account from this client, for the client, and for the account from anywhere.
function loginFailed(req: FastifyRequest, account: string, ip: string) {
  loginLimits.pair.fail(pairKey(account, ip));
  if (loginLimits.ip.fail(ip)) req.log.warn({ ip }, 'login: too many failures from this client, blocked');
  const wait = loginLimits.account.fail(account);
  if (wait) req.log.warn({ account, waitMs: wait }, 'login: too many failures on this account from all clients, slowed down');
}

function loginWait(account: string, ip: string) {
  return Math.max(loginLimits.pair.check(pairKey(account, ip)), loginLimits.ip.check(ip), loginLimits.account.check(account));
}

async function openSession(req: FastifyRequest, reply: FastifyReply, user: UserDoc, mfa: boolean) {
  const now = new Date();
  await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: now } });
  await startSession(req, reply, user, mfa);
  void recordAudit({ category: 'auth', action: 'auth.login', actor: actorOf({ user }), ip: req.ip, ...(mfa ? { details: { passkey: true } } : {}) });
  return me(user, mfa ? now : undefined);
}

async function consumeSuperadminPassword() {
  const admin = await users.findOne({ profile: SUPERADMIN });
  if (!admin) return;
  await users.updateOne({ _id: admin._id }, { $set: { passwordHash: null }, $unset: { passwordExpiresAt: '' } });
  await sessions.deleteMany({ userId: admin._id });
}

export function registerAuth(app: FastifyInstance) {
  // computed once at start rather than on the first unknown account (which would then take twice as long)
  void dummyPasswordHash();
  app.addHook('onRequest', async (req, reply) => {
    if (isPublic(req)) return;
    // a key is a credential of its own: it never falls back to the session cookie
    if (req.headers.authorization) {
      const wait = apiKeyLimit.check(ipKey(req.ip));
      if (wait) return tooManyAttempts(reply, wait);
    }
    const byKey = await userFromApiKey(req);
    if (byKey === null) {
      if (apiKeyLimit.fail(ipKey(req.ip))) req.log.warn({ ip: req.ip }, 'too many unknown API keys from this client, blocked');
      recordAuthFailure('auth.apiKey', req.ip, null, 'clé d\'API inconnue');
    }
    const user = byKey === undefined ? await userFromRequest(req) : byKey;
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    const route = req.routeOptions.url!;
    // temporary password: it must be replaced before anything else (the key is not concerned)
    if (byKey === undefined && user.mustChangePassword && !allowedBeforePasswordChange(req.method, route)) {
      return reply.code(403).send({ error: 'password_change_required' });
    }
    // MFA_REQUIRED: an admin whose session was not proven with a passkey registers one first (the key is not concerned)
    if (byKey === undefined && mfaRequiredFor(user) && !req.mfaAt && !allowedBeforePasskey(req.method, route)) {
      return reply.code(403).send({ error: 'passkey_required' });
    }
    if (!authorize(user.profile, req.method, route)) return reply.code(403).send({ error: 'forbidden' });
    // sensitive action: an account with a passkey proves it again (POST /api/account/reauth), the key is not concerned
    if (byKey === undefined && sensitiveAction(req.method, route) && (await reauthNeeded(user, req.mfaAt))) {
      return reply.code(403).send({ error: 'reauth_required' });
    }
    req.user = user;
  });

  app.get('/api/auth/status', async (req) => {
    const user = await userFromRequest(req);
    // fresh install: log in as superadmin with the password printed in the hub logs
    const noAccounts = !user && (await users.countDocuments({ profile: { $ne: SUPERADMIN } })) === 0;
    const { https, hopClear } = transport(req);
    return {
      noAccounts,
      // Secure attribute of the cookie a login would get here: refused by the browser over plain http
      cookieSecure: cookieSecure(req),
      // how this request reached the hub (banners of the UI); the TLS port of the UI, when there is one
      transport: { https, hopClear },
      httpsUrl: https ? null : httpsUrl(req),
      user: user ? me(user, req.mfaAt) : null,
    };
  });

  app.post<{ Body: { username: string; password: string } }>(
    '/api/auth/login',
    { schema: loginSchema },
    async (req, reply) => {
      const account = accountKey(req.body.username);
      const ip = ipKey(req.ip);
      // refused before any lookup: the answer is the same for an unknown account
      const wait = loginWait(account, ip);
      if (wait) return tooManyAttempts(reply, wait);
      const user = await users.findOne({ username: accountKey(req.body.username) });
      // scrypt first, whether the account exists or not (constant time)
      if (!(await checkPassword(user, req.body.password)) || !user) {
        loginFailed(req, account, ip);
        // the name typed is kept only when it is an account: otherwise it may be a password typed in the wrong field
        recordAuthFailure('auth.login', req.ip, user ? user.username : null, user ? 'mot de passe incorrect' : 'compte inconnu');
        return reply.code(401).send({ error: 'invalid credentials' });
      }
      // the superadmin password is not consumed here: a login whose cookie never sticks (e.g. Secure cookie over
      // http) would lock the install out. It is consumed once a first account has set its own password.
      // Only this account from this client is cleared: a login of one's own account must not reset the counter of the
      // client (tries on other accounts), nor the one of the account from all clients (distributed attack).
      loginLimits.pair.reset(pairKey(account, ip));
      // an account with a passkey: no session yet, the browser answers the challenge (/api/auth/login/passkey)
      const challenge = await loginChallenge(user);
      if (challenge) return { passkey: challenge };
      return openSession(req, reply, user, false);
    },
  );

  app.post<{ Body: { ticket: string; response: AuthenticationResponseJSON } }>(
    '/api/auth/login/passkey',
    {
      schema: {
        body: {
          type: 'object',
          required: ['ticket', 'response'],
          additionalProperties: false,
          properties: { ticket: { type: 'string', minLength: 1, maxLength: 128 }, response: { type: 'object' } },
        },
      },
    },
    async (req, reply) => {
      const ip = ipKey(req.ip);
      const result = await finishLogin(req.body.ticket, req.body.response);
      if (!result) return reply.code(401).send({ error: 'passkey_expired' });
      const account = accountKey(result.user.username);
      if (!result.ok) {
        loginFailed(req, account, ip);
        recordAuthFailure('auth.login', req.ip, result.user.username, 'passkey refusée');
        return reply.code(401).send({ error: 'passkey_refused' });
      }
      return openSession(req, reply, result.user, true);
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) {
      const session = await sessions.findOneAndDelete({ _id: sha256(token) });
      closeStreams({ sessionId: sha256(token) });
      const user = session && (await users.findOne({ _id: session.userId }));
      if (user) void recordAudit({ category: 'auth', action: 'auth.logout', actor: actorOf({ user }), ip: req.ip });
    }
    reply.clearCookie(COOKIE, { path: '/', secure: cookieSecure(req) });
    return { ok: true };
  });

  app.post<{ Body: { currentPassword?: string; newPassword: string } }>(
    '/api/account/password',
    {
      schema: {
        body: {
          type: 'object',
          required: ['newPassword'],
          properties: {
            currentPassword: { type: 'string', maxLength: 256 },
            newPassword: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    async (req, reply) => {
      const user = req.user!;
      // with a temporary password the user just authenticated with it: no need to type it again
      if (!user.mustChangePassword) {
        const key = pairKey(accountKey(user.username), ipKey(req.ip));
        const wait = loginLimits.pair.check(key);
        if (wait) return tooManyAttempts(reply, wait);
        if (!(await checkPassword(user, req.body.currentPassword ?? ''))) {
          loginLimits.pair.fail(key);
          return reply.code(400).send({ error: 'current password is wrong' });
        }
      }
      const problem = passwordProblem(req.body.newPassword, user.username);
      if (problem) return reply.code(400).send({ error: problem });
      await users.updateOne(
        { _id: user._id },
        { $set: { passwordHash: await hashPassword(req.body.newPassword), mustChangePassword: false } },
      );
      // an account got past its temporary password: the bootstrap/recovery superadmin password has done its job
      if (user.mustChangePassword) await consumeSuperadminPassword();
      // other sessions (another browser, someone else) are closed, the current one is kept
      const current = req.cookies[COOKIE];
      await sessions.deleteMany({ userId: user._id, _id: { $ne: current ? sha256(current) : '' } });
      return { ok: true };
    },
  );

  // the sessions of the account, to see where it is open and close the ones it does not know
  app.get('/api/account/sessions', async (req) => {
    const list = await activeSessions(req.user!._id);
    return list.map((s) => sessionDto(s, req.sessionId));
  });

  app.delete<{ Params: { id: string } }>('/api/account/sessions/:id', async (req, reply) => {
    const user = req.user!;
    req.auditNote = { target: { kind: 'account', id: user._id.toHexString(), name: user.username } };
    const gone = await sessions.findOneAndDelete({ _id: req.params.id, userId: user._id });
    if (!gone) return reply.code(404).send({ error: 'session not found' });
    closeStreams({ sessionId: gone._id });
    if (gone._id === req.sessionId) reply.clearCookie(COOKIE, { path: '/', secure: cookieSecure(req) });
    return reply.code(204).send();
  });
}
