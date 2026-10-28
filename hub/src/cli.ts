// Account recovery, run inside the hub container: `docker compose exec hub hm-admin <command>`.
import { closeDb, connectDb } from './db.js';
import { issueSuperadminPassword } from './superadmin.js';
import { SUPERADMIN } from './types.js';

const VALIDITY_MINUTES = 15;

const usage = `usage: hm-admin <command>

  superadmin   one-time password for the "${SUPERADMIN}" account (valid ${VALIDITY_MINUTES} min),
               which can list and create accounts and reset their passwords`;

async function superadmin() {
  const password = await issueSuperadminPassword(VALIDITY_MINUTES);
  console.log(`user:     ${SUPERADMIN}`);
  console.log(`password: ${password}`);
  console.log(`single use, valid ${VALIDITY_MINUTES} minutes`);
}

const [command] = process.argv.slice(2);
let code = 0;
await connectDb();
try {
  if (command === 'superadmin') await superadmin();
  else throw new Error(usage);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  code = 1;
} finally {
  await closeDb();
}
process.exit(code);
