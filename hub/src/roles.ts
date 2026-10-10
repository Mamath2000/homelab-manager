import type { UserDoc } from './types.js';

// What each role may call, decided on the matched route pattern (see isPublic in auth.ts).
// Anything not explicitly allowed is refused.
//   admin     everything
//   operator  reads + runs jobs (updates, cleanup, reboot, agent updates) + standardisation of a host; no hosts, settings or accounts
//   viewer    reads only
//   superadmin  accounts only: list, create, reset passwords (first install and recovery)
export function authorize(role: UserDoc['role'], method: string, route: string) {
  const read = method === 'GET' || method === 'HEAD';
  const accounts = route === '/api/users' || route.startsWith('/api/users/');
  // agent settings only expose the distributed agent version (shown in the header)
  const settings = route.startsWith('/api/settings/') && route !== '/api/settings/agents';
  const ownPassword = method === 'POST' && route === '/api/account/password';
  // container logs and compose files may hold secrets: not for read-only accounts
  const stackDetails = route === '/api/hosts/:id/stacks/:stack/logs' || route === '/api/hosts/:id/stacks/:stack/compose';
  switch (role) {
    case 'admin':
      return true;
    case 'operator':
      if (read) return !accounts && !settings;
      return (
        ownPassword ||
        (method === 'POST' && (route === '/api/hosts/:id/jobs' || route === '/api/jobs/bulk' || route === '/api/hosts/:id/setup/check')) ||
        (method === 'PUT' && route === '/api/hosts/:id/setup')
      );
    case 'viewer':
      if (read) return !accounts && !settings && !stackDetails;
      return ownPassword;
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
