import type { UserDoc } from './types.js';

// What each profile may call, decided on the matched route pattern (see isPublic in auth.ts).
// Anything not explicitly allowed is refused.
//   admin     everything (the journal of the key actions is theirs alone)
//   operator  reads (not the compose files) + runs jobs (updates, cleanup, reboot, lock, agent updates; not shutdown: checked on the job route) (standardisation: checks and applies the values an admin set, never changes them); no hosts, settings or accounts
//   viewer    reads only (no job output, container logs or compose files)
//   superadmin  accounts only: list, create, reset passwords (first install and recovery)
export function authorize(profile: UserDoc['profile'], method: string, route: string) {
  const read = method === 'GET' || method === 'HEAD';
  const accounts = route === '/api/users' || route.startsWith('/api/users/');
  // agent settings only expose the distributed agent version (shown in the header)
  const settings = route.startsWith('/api/settings/') && route !== '/api/settings/agents';
  const ownPassword = method === 'POST' && route === '/api/account/password';
  // one's own sessions and passkeys: list them, close a session, register or remove a passkey, prove it again
  const ownAccount =
    route === '/api/account/sessions' ||
    (method === 'DELETE' && route === '/api/account/sessions/:id') ||
    route === '/api/account/passkeys' ||
    route === '/api/account/passkeys/options' ||
    (method === 'DELETE' && route === '/api/account/passkeys/:id') ||
    (method === 'POST' && (route === '/api/account/reauth' || route === '/api/account/reauth/options'));
  // journal of the key actions (who did what, addresses): admins only
  const audit = route === '/api/audit' || route.startsWith('/api/audit/');
  // container logs may hold secrets: not for read-only accounts; compose files: admins only
  // the targets of a database restore are found by running commands in the containers of the hosts: admins only
  const dbRestoreRead = route.startsWith('/api/db-restore');
  const stackLogs = route === '/api/hosts/:id/stacks/:stack/logs';
  const stackCompose = route === '/api/hosts/:id/stacks/:stack/compose';
  switch (profile) {
    case 'admin':
      return true;
    case 'operator':
      if (read) return !accounts && !settings && !audit && !dbRestoreRead && !stackCompose;
      return (
        ownPassword ||
        ownAccount ||
        (method === 'POST' &&
          (route === '/api/hosts/:id/jobs' ||
            route === '/api/jobs/bulk' ||
            route === '/api/jobs/docker-update' ||
            route === '/api/hosts/:id/setup/check' ||
            route === '/api/hosts/:id/refresh' ||
            route === '/api/backups/refresh' ||
            route === '/api/backup-jobs/:jobId/run' ||
            route === '/api/backups/:id/offsite/run'))
      );
    case 'viewer':
      if (read) return !accounts && !settings && !stackLogs && !stackCompose && !audit && !dbRestoreRead;
      return ownPassword || ownAccount;
    case 'superadmin':
      return (
        (read && route === '/api/users') ||
        (method === 'POST' && (route === '/api/users' || route === '/api/users/:id/reset-password'))
      );
    default:
      return false;
  }
}

// While a temporary password is in use, only changing it (and reading who is logged in) is allowed.
export function allowedBeforePasswordChange(method: string, route: string) {
  return method === 'POST' && route === '/api/account/password';
}

// MFA_REQUIRED, admin session not proven with a passkey: only registering one is allowed.
export function allowedBeforePasskey(method: string, route: string) {
  return (
    ((method === 'GET' || method === 'POST') && route === '/api/account/passkeys') ||
    (method === 'POST' && route === '/api/account/passkeys/options') ||
    (method === 'POST' && route === '/api/account/password')
  );
}

// Sensitive actions (homelab#291): an account with a passkey proves it again before them, when its last proof is too
// old (passkeys.ts). What gives access or a credential, changes what the hub may do on the hosts, or overwrites data;
// not what only takes access away (revocation of a key, a session, a disconnection).
export const SENSITIVE_ACTIONS = new Set([
  // accounts and API keys
  'POST /api/users',
  'PATCH /api/users/:id',
  'DELETE /api/users/:id',
  'POST /api/users/:id/reset-password',
  'POST /api/users/:id/api-keys',
  'POST /api/account/passkeys/options',
  'POST /api/account/passkeys',
  'DELETE /api/account/passkeys/:id',
  'DELETE /api/account/passkeys',
  'DELETE /api/users/:id/passkeys',
  // settings: credentials of Home Assistant, PBS, Proxmox VE, roles (Omada…), agent distribution
  'PUT /api/settings/homeassistant',
  'PUT /api/settings/agents',
  'PUT /api/settings/pbs',
  'POST /api/settings/pbs/token',
  'PUT /api/settings/pbs-remote',
  'POST /api/settings/pbs-remote/token',
  'PUT /api/settings/pve/clusters/:id',
  'POST /api/settings/pve/clusters/:id/token',
  'DELETE /api/settings/pve/clusters/:id',
  'POST /api/roles',
  'PUT /api/roles/:id',
  'DELETE /api/roles/:id',
  'POST /api/roles/:id/mqtt-security/enable',
  'POST /api/roles/:id/mqtt-security/reset',
  'POST /api/roles/:id/mqtt-accounts',
  'PUT /api/roles/:id/mqtt-anonymous',
  'PUT /api/roles/:id/mqtt-accounts/:username',
  'DELETE /api/roles/:id/mqtt-accounts/:username',
  // standardisation and access manifest
  'PUT /api/settings/setup',
  'PUT /api/hosts/:id/setup',
  'PUT /api/hosts/:id/access-keys/ack',
  'POST /api/settings/access/apply',
  // agents: install command (enrollment code), renewal of the certificate, revocation, removal of the host
  'POST /api/hosts/:id/enroll',
  'POST /api/hosts/:id/cert-renew',
  'POST /api/hosts/:id/revoke',
  'DELETE /api/hosts/:id',
  // restore of a database
  'POST /api/db-restore',
]);

export const sensitiveAction = (method: string, route: string) => SENSITIVE_ACTIONS.has(`${method} ${route}`);
