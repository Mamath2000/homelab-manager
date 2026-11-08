import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorOf, recordAudit, recordAuthFailure } from './audit.js';
import { config } from './config.js';
import { dummyPasswordHash, hashPassword, randomToken, sha256, verifyPasswordOrDummy } from './crypto.js';
import { apiKeys, sessions, users } from './db.js';
import { closeStreams } from './events.js';
import { accountKey, apiKeyLimit, ipKey, loginLimits, pairKey, tooManyAttempts } from './loginGuard.js';
import { allowedBeforePasswordChange, authorize } from './profiles.js';
import { cookieSecure, httpsUrl, transport } from './transport.js';
import { SUPERADMIN, type UserDoc } from './types.js';

const COOKIE = 'hm_session';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserDoc;
    // the session the request came with (not set for an API key)
    sessionId?: string;
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

async function startSession(req: FastifyRequest, reply: FastifyReply, user: UserDoc) {
  const token = randomToken();
  const ttl = user.profile === SUPERADMIN ? SUPERADMIN_SESSION_MS : config.sessionDays * 24 * 3600 * 1000;
  const expiresAt = new Date(Date.now() + ttl);
  await sessions.insertOne({ _id: sha256(token), userId: user._id, expiresAt });
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieSecure(req),
    expires: expiresAt,
  });
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
  return users.findOne({ _id: session.userId });
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

function me(user: UserDoc) {
  return {
    username: user.username,
    displayName: user.displayName ?? '',
    profile: user.profile,
    mustChangePassword: !!user.mustChangePassword,
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
    if (!authorize(user.profile, req.method, route)) return reply.code(403).send({ error: 'forbidden' });
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
      user: user ? me(user) : null,
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
      await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
      await startSession(req, reply, user);
      void recordAudit({ category: 'auth', action: 'auth.login', actor: actorOf({ user }), ip: req.ip });
      return me(user);
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
            newPassword: { type: 'string', minLength: 8, maxLength: 256 },
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
}
