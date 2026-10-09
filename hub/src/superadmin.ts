import { hashPassword, randomToken } from './crypto.js';
import { sessions, users } from './db.js';
import { SUPERADMIN } from './types.js';

// One-time password of the built-in "superadmin" account, which manages accounts only.
// A new password invalidates the previous one and closes a running superadmin session.
export async function issueSuperadminPassword(validityMinutes: number) {
  const existing = await users.findOne({ username: SUPERADMIN });
  if (existing && existing.role !== SUPERADMIN) throw new Error(`a regular account is named "${SUPERADMIN}"`);
  const password = randomToken(12);
  await users.updateOne(
    { username: SUPERADMIN },
    {
      $set: {
        role: SUPERADMIN,
        passwordHash: await hashPassword(password),
        passwordExpiresAt: new Date(Date.now() + validityMinutes * 60_000),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
  if (existing) await sessions.deleteMany({ userId: existing._id });
  return password;
}

export function hasAccounts() {
  return users.countDocuments({ role: { $ne: SUPERADMIN } }).then((n) => n > 0);
}

// Fresh install: no account yet, so the superadmin gets a password printed in the logs; it is
// used once to create the first accounts. Re-issued at every start until an account exists.
export async function bootstrapSuperadmin() {
  if (await hasAccounts()) return;
  const password = await issueSuperadminPassword(24 * 60);
  const lines = [
    '',
    '================================================================',
    '  Homelab Manager : premier démarrage, aucun compte',
    `  Connexion :      ${SUPERADMIN}`,
    `  Mot de passe :   ${password}`,
    '  Usage unique, valable 24 h : crée ensuite les comptes depuis la page Comptes.',
    '  (perdu ou expiré : redémarre le hub pour en obtenir un nouveau)',
    '================================================================',
    '',
  ];
  // plain text rather than a JSON log line, to be readable in `docker compose logs hub`
  process.stdout.write(lines.join('\n'));
}
