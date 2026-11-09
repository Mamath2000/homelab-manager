// Account recovery, run inside the hub container: `docker compose exec hub hm-admin <command>`.
import { recordAudit } from './audit.js';
import { closeDb, connectDb, passkeys, sessions, users } from './db.js';
import { issueSuperadminPassword } from './superadmin.js';
import { SUPERADMIN } from './types.js';

const VALIDITY_MINUTES = 15;

const usage = `usage: hm-admin <command>

  superadmin              one-time password for the "${SUPERADMIN}" account (valid ${VALIDITY_MINUTES} min),
                          which can list and create accounts and reset their passwords
  reset-passkeys <user>   removes the passkeys of an account (lost passkey) and closes its sessions;
                          with MFA_REQUIRED, an admin registers a new one at the next login`;

async function superadmin() {
  const password = await issueSuperadminPassword(VALIDITY_MINUTES);
  await recordAudit({ category: 'auth', action: 'auth.superadminIssued', actor: { kind: 'cli', name: 'hm-admin' }, details: { validityMinutes: VALIDITY_MINUTES } });
  console.log(`user:     ${SUPERADMIN}`);
  console.log(`password: ${password}`);
  console.log(`single use, valid ${VALIDITY_MINUTES} minutes`);
}

async function resetPasskeys(name: string | undefined) {
  if (!name) throw new Error(usage);
  const user = await users.findOne({ username: name.trim().toLowerCase(), profile: { $ne: SUPERADMIN } });
  if (!user) throw new Error(`no account "${name}"`);
  const { deletedCount } = await passkeys.deleteMany({ userId: user._id });
  await sessions.deleteMany({ userId: user._id });
  await recordAudit({
    category: 'account',
    action: 'account.passkeysReset',
    actor: { kind: 'cli', name: 'hm-admin' },
    target: { kind: 'account', id: user._id.toHexString(), name: user.username },
    details: { removed: deletedCount },
  });
  console.log(`${deletedCount} passkey(s) removed from ${user.username}, sessions closed`);
}

const [command, arg] = process.argv.slice(2);
let code = 0;
await connectDb();
try {
  if (command === 'superadmin') await superadmin();
  else if (command === 'reset-passkeys') await resetPasskeys(arg);
  else throw new Error(usage);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  code = 1;
} finally {
  await closeDb();
}
process.exit(code);
