import type { FastifyInstance } from 'fastify';
import { MongoServerError } from 'mongodb';
import { revokeSessions } from '../auth.js';
import { parseId, users } from '../db.js';
import { ROLES, SUPERADMIN, type Role, type UserDoc } from '../types.js';

function dto(u: UserDoc) {
  return {
    id: u._id.toHexString(),
    username: u.username,
    role: u.role,
    createdAt: u.createdAt,
    passwordPending: u.passwordHash === null,
  };
}

const username = { type: 'string', minLength: 1, maxLength: 64, pattern: '\\S' } as const;
const role = { type: 'string', enum: ROLES } as const;

function reserved(name: string) {
  return name.toLowerCase() === SUPERADMIN;
}

function duplicate(err: unknown) {
  return err instanceof MongoServerError && err.code === 11000;
}

// Only admins reach these routes, except the listing and the reset that the superadmin may use (roles.ts).
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

  // New accounts have no password: the user chooses it at the first login.
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
      const doc = { username: name, role: req.body.role, passwordHash: null, createdAt: new Date() };
      try {
        const { insertedId } = await users.insertOne(doc as UserDoc);
        return dto({ ...doc, _id: insertedId });
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

  // The password is cleared: the user chooses a new one at the next login.
  app.post<{ Params: { id: string } }>('/api/users/:id/reset-password', async (req, reply) => {
    const user = await target(req.params.id);
    if (!user) return reply.code(404).send({ error: 'user not found' });
    await users.updateOne({ _id: user._id }, { $set: { passwordHash: null } });
    await revokeSessions(user);
    return dto({ ...user, passwordHash: null });
  });
}
