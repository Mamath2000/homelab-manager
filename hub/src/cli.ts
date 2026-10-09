// Account recovery, run inside the hub container: `docker compose exec hub hm-admin <command>`.
import { closeDb, connectDb, sessions, users } from './db.js';
import { hashPassword, randomToken } from './crypto.js';
import { SUPERADMIN, type UserDoc } from './types.js';

const VALIDITY_MINUTES = 15;

const usage = `usage: hm-admin <command>

  superadmin               one-time password for the "superadmin" account (valid ${VALIDITY_MINUTES} min),
                           which can only list accounts and reset their passwords
  create-admin <username>  create an admin account; its password is chosen at the first login`;

async function superadmin() {
  const existing = await users.findOne({ username: SUPERADMIN });
  if (existing && existing.role !== SUPERADMIN) throw new Error(`a regular account is named "${SUPERADMIN}"`);
  const password = randomToken(18);
  await users.updateOne(
    { username: SUPERADMIN },
    {
      $set: {
        role: SUPERADMIN,
        passwordHash: await hashPassword(password),
        passwordExpiresAt: new Date(Date.now() + VALIDITY_MINUTES * 60_000),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
  if (existing) await sessions.deleteMany({ userId: existing._id });
  console.log(`user:     ${SUPERADMIN}`);
  console.log(`password: ${password}`);
  console.log(`single use, valid ${VALIDITY_MINUTES} minutes`);
}

async function createAdmin(name: string | undefined) {
  const username = name?.trim();
  if (!username) throw new Error(usage);
  if (username.toLowerCase() === SUPERADMIN) throw new Error('reserved username');
  if (await users.findOne({ username })) throw new Error(`"${username}" already exists (reset it with hm-admin superadmin)`);
  const doc = { username, role: 'admin', passwordHash: null, createdAt: new Date() };
  await users.insertOne(doc as UserDoc);
  console.log(`admin "${username}" created: log in with this username and an empty password to choose one`);
}

const [command, arg] = process.argv.slice(2);
let code = 0;
await connectDb();
try {
  if (command === 'superadmin') await superadmin();
  else if (command === 'create-admin') await createAdmin(arg);
  else throw new Error(usage);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  code = 1;
} finally {
  await closeDb();
}
process.exit(code);
