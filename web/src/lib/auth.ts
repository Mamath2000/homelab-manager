import { createContext, useContext } from 'react';
import type { Me } from './api';

// What the signed-in user may see and do. The hub enforces the same rules (hub/src/roles.ts).
export function rights(me: Me) {
  return {
    ...me,
    isSuperAdmin: me.role === 'superadmin',
    canWrite: me.role === 'admin' || me.role === 'monitor',
    canSettings: me.role === 'admin' || me.role === 'monitor',
    canAccounts: me.role === 'admin' || me.role === 'superadmin',
  };
}

export type Rights = ReturnType<typeof rights>;

export const MeContext = createContext<Rights | null>(null);

export function useMe() {
  const me = useContext(MeContext);
  if (!me) throw new Error('MeContext missing');
  return me;
}

export const ROLE_LABELS: Record<Me['role'], string> = {
  admin: 'Admin',
  monitor: 'Monitor',
  viewer: 'Viewer',
  superadmin: 'Super admin',
};
