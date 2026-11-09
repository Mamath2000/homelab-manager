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

// Double authentication of an account, shown the same way everywhere (components/MfaStatus.tsx):
//   on       at least one passkey
//   missing  admin without a passkey while they are required (MFA_REQUIRED): registered at the next login
//   off      no passkey
//   none     no password: the account never logs in to the UI (API keys only)
export type MfaState = 'on' | 'missing' | 'off' | 'none';

export function mfaState(a: { profile: Me['profile']; hasPassword: boolean; passkeys: number }, adminsRequired: boolean): MfaState {
  if (!a.hasPassword) return 'none';
  if (a.passkeys > 0) return 'on';
  return a.profile === 'admin' && adminsRequired ? 'missing' : 'off';
}
