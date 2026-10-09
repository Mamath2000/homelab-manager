import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto.js';
import { sessions, users } from './db.js';
import type { UserDoc } from './types.js';

const COOKIE = 'hm_session';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserDoc;
  }
}

// Paths reachable without a session: login flow, agent endpoints, static UI.
function isPublic(rawUrl: string) {
  const url = rawUrl.split('?')[0];
  if (!url.startsWith('/api/')) return true;
  return url.startsWith('/api/auth/') || url === '/api/health';
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

async function startSession(reply: FastifyReply, user: UserDoc) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + config.sessionDays * 24 * 3600 * 1000);
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

const credentialsSchema = {
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

export function registerAuth(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    if (isPublic(req.url)) return;
    const user = await userFromRequest(req);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    req.user = user;
  });

  app.get('/api/auth/status', async (req) => {
    const setupRequired = (await users.countDocuments()) === 0;
    const user = setupRequired ? null : await userFromRequest(req);
    return { setupRequired, user: user ? { username: user.username } : null };
  });

  // First run: create the admin account. Only possible while no user exists.
  app.post<{ Body: { username: string; password: string } }>(
    '/api/auth/setup',
    { schema: credentialsSchema },
    async (req, reply) => {
      if ((await users.countDocuments()) > 0) return reply.code(409).send({ error: 'already configured' });
      if (req.body.password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters' });
      const doc = {
        username: req.body.username.trim(),
        passwordHash: await hashPassword(req.body.password),
        createdAt: new Date(),
      };
      const { insertedId } = await users.insertOne(doc as UserDoc);
      await startSession(reply, { ...doc, _id: insertedId });
      return { username: doc.username };
    },
  );

  app.post<{ Body: { username: string; password: string } }>(
    '/api/auth/login',
    { schema: credentialsSchema },
    async (req, reply) => {
      if (tooManyFailures(req.ip)) return reply.code(429).send({ error: 'too many attempts, retry in a minute' });
      const user = await users.findOne({ username: req.body.username.trim() });
      if (!user || !(await verifyPassword(req.body.password, user.passwordHash))) {
        recordFailure(req.ip);
        return reply.code(401).send({ error: 'invalid credentials' });
      }
      failures.delete(req.ip);
      await startSession(reply, user);
      return { username: user.username };
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
      if (!(await verifyPassword(req.body.currentPassword, user.passwordHash))) {
        return reply.code(400).send({ error: 'current password is wrong' });
      }
      await users.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(req.body.newPassword) } });
      return { ok: true };
    },
  );
}
