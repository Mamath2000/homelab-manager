import type { FastifyInstance } from 'fastify';
import { MongoServerError } from 'mongodb';
import { revokeSessions } from '../auth.js';
import { hashPassword, randomToken } from '../crypto.js';
import { parseId, users } from '../db.js';
import { ROLES, SUPERADMIN, type Role, type UserDoc } from '../types.js';

function dto(u: UserDoc) {
  return {
    id: u._id.toHexString(),
    username: u.username,
    role: u.role,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt ?? null,
    mustChangePassword: !!u.mustChangePassword,
  };
}

// Shown once to the admin, to be handed over; the user must replace it at the first login.
async function temporaryPassword() {
  const password = randomToken(9);
  return { password, fields: { passwordHash: await hashPassword(password), mustChangePassword: true } };
}

const username = { type: 'string', minLength: 1, maxLength: 64, pattern: '\\S' } as const;
const role = { type: 'string', enum: ROLES } as const;

function reserved(name: string) {
  return name.toLowerCase() === SUPERADMIN;
}

function duplicate(err: unknown) {
  return err instanceof MongoServerError && err.code === 11000;
}

// Only admins reach these routes, except listing, creation and reset, also open to the superadmin (roles.ts).
export function registerUserRoutes(app: FastifyInstance) {
  // the superadmin account is managed with `hm-admin` only, never through the API
  async function target(id: string) {
    const _id = parseId(id);
    return _id && users.findOne({ _id, role: { $ne: SUPERADMIN } });
  }

  async function lastAdmin(u: UserDoc) {
    return u.role === 'admin' && (await users.countDocuments({ role: 'admin' })) <= 1;
  }

  app.get('/api/users', async () => {
    const list = await users.find({ role: { $ne: SUPERADMIN } }).sort({ username: 1 }).toArray();
    return list.map(dto);
  });

  // New accounts get a temporary password, returned once.
  app.post<{ Body: { username: string; role: Role } }>(
    '/api/users',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'role'],
          additionalProperties: false,
          properties: { username, role },
        },
      },
    },
    async (req, reply) => {
      const name = req.body.username.trim();
      if (reserved(name)) return reply.code(400).send({ error: 'reserved username' });
      const temp = await temporaryPassword();
      const doc = { username: name, role: req.body.role, ...temp.fields, createdAt: new Date() };
      try {
        const { insertedId } = await users.insertOne(doc as UserDoc);
        return { user: dto({ ...doc, _id: insertedId }), temporaryPassword: temp.password };
      } catch (err) {
        if (duplicate(err)) return reply.code(409).send({ error: 'username already taken' });
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { username?: string; role?: Role } }>(
    '/api/users/:id',
    {
      schema: {
        body: { type: 'object', additionalProperties: false, properties: { username, role } },
      },
    },
    async (req, reply) => {
      const user = await target(req.params.id);
      if (!user) return reply.code(404).send({ error: 'user not found' });
      const set: Partial<UserDoc> = {};
      if (req.body.username !== undefined) {
        const name = req.body.username.trim();
        if (reserved(name)) return reply.code(400).send({ error: 'reserved username' });
        set.username = name;
      }
      const roleChanged = req.body.role !== undefined && req.body.role !== user.role;
      if (roleChanged) {
        if (await lastAdmin(user)) return reply.code(409).send({ error: 'cannot demote the last admin' });
        set.role = req.body.role;
      }
      try {
        const updated = await users.findOneAndUpdate({ _id: user._id }, { $set: set }, { returnDocument: 'after' });
        if (!updated) return reply.code(404).send({ error: 'user not found' });
        // sessions carry no role, but log the user out so the UI reloads with the new rights
        if (roleChanged) await revokeSessions(user);
        return dto(updated);
      } catch (err) {
        if (duplicate(err)) return reply.code(409).send({ error: 'username already taken' });
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/users/:id', async (req, reply) => {
    const user = await target(req.params.id);
    if (!user) return reply.code(404).send({ error: 'user not found' });
    if (user._id.equals(req.user!._id)) return reply.code(409).send({ error: 'cannot delete your own account' });
    if (await lastAdmin(user)) return reply.code(409).send({ error: 'cannot delete the last admin' });
    await users.deleteOne({ _id: user._id });
    await revokeSessions(user);
    return reply.code(204).send();
  });

  // New temporary password, returned once; the user's sessions are closed.
  app.post<{ Params: { id: string } }>('/api/users/:id/reset-password', async (req, reply) => {
    const user = await target(req.params.id);
    if (!user) return reply.code(404).send({ error: 'user not found' });
    const temp = await temporaryPassword();
    await users.updateOne({ _id: user._id }, { $set: temp.fields });
    await revokeSessions(user);
    return { user: dto({ ...user, ...temp.fields }), temporaryPassword: temp.password };
  });
}
