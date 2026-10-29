import { createContext, useContext } from 'react';
import type { Me } from './api';

// What the signed-in user may see and do. The hub enforces the same rules (hub/src/profiles.ts).
export function rights(me: Me) {
  return {
    ...me,
    isSuperAdmin: me.profile === 'superadmin',
    // run jobs: checks, updates, cleanup, reboot, lock, agent updates
    canWrite: me.profile === 'admin' || me.profile === 'operator',
    // add / edit / delete hosts, agent tokens
    canManage: me.profile === 'admin',
    canSettings: me.profile === 'admin',
    canAccounts: me.profile === 'admin' || me.profile === 'superadmin',
  };
}

export type Rights = ReturnType<typeof rights>;

export const MeContext = createContext<Rights | null>(null);

export function useMe() {
  const me = useContext(MeContext);
  if (!me) throw new Error('MeContext missing');
  return me;
}

export const PROFILE_LABELS: Record<Me['profile'], string> = {
  admin: 'Admin',
  operator: 'Opérateur',
  viewer: 'Lecture',
  superadmin: 'Super admin',
};
