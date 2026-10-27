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

// a password already issued and not expired survives restarts (only its hash is stored, it cannot be shown again)
export function hasActiveSuperadminPassword(admin: { passwordHash?: string | null; passwordExpiresAt?: Date } | null) {
  return !!admin?.passwordHash && !!admin.passwordExpiresAt && admin.passwordExpiresAt > new Date();
}

export function shouldResetSuperadminPassword(value = process.env.HM_RESET_SUPERADMIN_PASSWORD) {
  return value === 'true';
}

// On HAOS, the recovery option requests a fresh one-time password at startup.
// Otherwise, a fresh install gets one until its first regular account is created.
export async function bootstrapSuperadmin() {
  if (shouldResetSuperadminPassword()) {
    const password = await issueSuperadminPassword(15);
    const lines = [
      '',
      '================================================================',
      '  Homelab Manager : réinitialisation demandée',
      `  Connexion :      ${SUPERADMIN}`,
      `  Mot de passe :   ${password}`,
      '  Usage unique, valable 15 min : désactive ensuite la demande dans la configuration HAOS.',
      '================================================================',
      '',
    ];
    process.stdout.write(lines.join('\n'));
    return;
  }

  if (await hasAccounts()) return;
  if (hasActiveSuperadminPassword(await users.findOne({ username: SUPERADMIN, role: SUPERADMIN }))) {
    process.stdout.write(
      [
        '',
        '================================================================',
        '  Homelab Manager : aucun compte, le mot de passe du premier démarrage est toujours valable',
        `  (il n'est affiché qu'une fois ; perdu : docker exec homelab-manager hm-admin ${SUPERADMIN})`,
        '================================================================',
        '',
      ].join('\n'),
    );
    return;
  }
  const password = await issueSuperadminPassword(24 * 60);
  const lines = [
    '',
    '================================================================',
    '  Homelab Manager : premier démarrage, aucun compte',
    `  Connexion :      ${SUPERADMIN}`,
    `  Mot de passe :   ${password}`,
    '  Usage unique, valable 24 h : crée ensuite les comptes depuis la page Comptes.',
    `  (perdu : docker exec homelab-manager hm-admin ${SUPERADMIN} ; expiré : redémarre le hub)`,
    '================================================================',
    '',
  ];
  // plain text rather than a JSON log line, to be readable in `docker compose logs hub`
  process.stdout.write(lines.join('\n'));
}
