import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto.js';
import { sessions, users } from './db.js';
import { authorize } from './roles.js';
import { SUPERADMIN, type UserDoc } from './types.js';

const COOKIE = 'hm_session';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserDoc;
  }
}

// Decided on the matched route pattern, never on the raw URL: the router decodes
// percent-escapes ("/%61pi/hosts" is routed to "/api/hosts").
function isPublic(req: FastifyRequest) {
  const route = req.routeOptions.url;
  // unmatched requests only reach the 404 / SPA fallback
  if (!route) return true;
  // static UI, install script, agent socket (authenticated by its own token)
  if (!route.startsWith('/api/')) return true;
  return route.startsWith('/api/auth/') || route === '/api/health';
}

// naive in-memory brute-force protection, plenty for a LAN-only tool
const failures = new Map<string, { count: number; until: number }>();
function tooManyFailures(ip: string) {
  const f = failures.get(ip);
  return !!f && f.count >= 5 && f.until > Date.now();
}
function recordFailure(ip: string) {
  const f = failures.get(ip);
  const fresh = !f || f.until < Date.now();
  failures.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 60_000 });
}

// the superadmin only gets a short session out of its one-time password
const SUPERADMIN_SESSION_MS = 15 * 60_000;

async function startSession(reply: FastifyReply, user: UserDoc) {
  const token = randomToken();
  const ttl = user.role === SUPERADMIN ? SUPERADMIN_SESSION_MS : config.sessionDays * 24 * 3600 * 1000;
  const expiresAt = new Date(Date.now() + ttl);
  await sessions.insertOne({ _id: sha256(token), userId: user._id, expiresAt });
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    expires: expiresAt,
  });
}

async function userFromRequest(req: FastifyRequest) {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  const session = await sessions.findOne({ _id: sha256(token), expiresAt: { $gt: new Date() } });
  if (!session) return null;
  return users.findOne({ _id: session.userId });
}

export function revokeSessions(user: Pick<UserDoc, '_id'>) {
  return sessions.deleteMany({ userId: user._id });
}

const loginSchema = {
  body: {
    type: 'object',
    required: ['username'],
    additionalProperties: false,
    properties: {
      username: { type: 'string', minLength: 1, maxLength: 64 },
      // empty or absent: only valid for an account whose password was reset
      password: { type: 'string', maxLength: 256 },
    },
  },
} as const;

const setPasswordSchema = {
  body: {
    type: 'object',
    required: ['username', 'newPassword'],
    additionalProperties: false,
    properties: {
      username: { type: 'string', minLength: 1, maxLength: 64 },
      newPassword: { type: 'string', minLength: 8, maxLength: 256 },
    },
  },
} as const;

function me(user: UserDoc) {
  return { username: user.username, role: user.role };
}

async function checkPassword(user: UserDoc, password: string) {
  if (!user.passwordHash || !password) return false;
  if (user.role === SUPERADMIN && !(user.passwordExpiresAt && user.passwordExpiresAt > new Date())) return false;
  return verifyPassword(password, user.passwordHash);
}

export function registerAuth(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    if (isPublic(req)) return;
    const user = await userFromRequest(req);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    if (!authorize(user.role, req.method, req.routeOptions.url!)) return reply.code(403).send({ error: 'forbidden' });
    req.user = user;
  });

  app.get('/api/auth/status', async (req) => {
    const user = await userFromRequest(req);
    // fresh install: the first admin is created with `hm-admin create-admin`
    const noAccounts = !user && (await users.countDocuments({ role: { $ne: SUPERADMIN } })) === 0;
    return { noAccounts, user: user ? me(user) : null };
  });

  app.post<{ Body: { username: string; password?: string } }>(
    '/api/auth/login',
    { schema: loginSchema },
    async (req, reply) => {
      if (tooManyFailures(req.ip)) return reply.code(429).send({ error: 'too many attempts, retry in a minute' });
      const user = await users.findOne({ username: req.body.username.trim() });
      const password = req.body.password ?? '';
      // reset account: the user picks a new password (POST /api/auth/set-password)
      if (user && user.role !== SUPERADMIN && user.passwordHash === null && !password) {
        return { passwordSetupRequired: true };
      }
      if (!user || !(await checkPassword(user, password))) {
        recordFailure(req.ip);
        return reply.code(401).send({ error: 'invalid credentials' });
      }
      if (user.role === SUPERADMIN) {
        // one-time password: consumed atomically, so it can never open a second session
        const { modifiedCount } = await users.updateOne(
          { _id: user._id, passwordHash: user.passwordHash },
          { $set: { passwordHash: null }, $unset: { passwordExpiresAt: '' } },
        );
        if (modifiedCount !== 1) return reply.code(401).send({ error: 'invalid credentials' });
      }
      failures.delete(req.ip);
      await startSession(reply, user);
      return me(user);
    },
  );

  app.post<{ Body: { username: string; newPassword: string } }>(
    '/api/auth/set-password',
    { schema: setPasswordSchema },
    async (req, reply) => {
      if (tooManyFailures(req.ip)) return reply.code(429).send({ error: 'too many attempts, retry in a minute' });
      const user = await users.findOneAndUpdate(
        { username: req.body.username.trim(), passwordHash: null, role: { $ne: SUPERADMIN } },
        { $set: { passwordHash: await hashPassword(req.body.newPassword) } },
        { returnDocument: 'after' },
      );
      if (!user) {
        recordFailure(req.ip);
        return reply.code(400).send({ error: 'no password to set for this account' });
      }
      failures.delete(req.ip);
      await startSession(reply, user);
      return me(user);
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await sessions.deleteOne({ _id: sha256(token) });
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/api/account/password',
    {
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', maxLength: 256 },
            newPassword: { type: 'string', minLength: 8, maxLength: 256 },
          },
        },
      },
    },
    async (req, reply) => {
      const user = req.user!;
      if (!(await checkPassword(user, req.body.currentPassword))) {
        return reply.code(400).send({ error: 'current password is wrong' });
      }
      await users.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(req.body.newPassword) } });
      return { ok: true };
    },
  );
}
