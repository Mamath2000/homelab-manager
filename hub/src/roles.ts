import type { UserDoc } from './types.js';

// What each role may call, decided on the matched route pattern (see isPublic in auth.ts).
// Anything not explicitly allowed is refused.
export function authorize(role: UserDoc['role'], method: string, route: string) {
  const read = method === 'GET' || method === 'HEAD';
  const accounts = route === '/api/users' || route.startsWith('/api/users/');
  switch (role) {
    case 'admin':
      return true;
    case 'monitor':
      return !accounts;
    case 'viewer':
      if (read) return !accounts && !route.startsWith('/api/settings/');
      return method === 'POST' && route === '/api/account/password';
    case 'superadmin':
      return (
        (read && route === '/api/users') || (method === 'POST' && route === '/api/users/:id/reset-password')
      );
    default:
      return false;
  }
}
