import { ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import { useMe, type MfaState } from '../lib/auth';
import { Badge } from './ui';

// The double authentication of an account (lib/auth.ts: mfaState), the same badge in the table and the dialogs.
export function MfaBadge({ state, count }: { state: MfaState; count: number }) {
  if (state === 'on') return <Badge tone="ok"><ShieldCheck className="h-3 w-3" />Activée · {count}</Badge>;
  if (state === 'missing') return <Badge tone="warn"><ShieldAlert className="h-3 w-3" />À enregistrer</Badge>;
  if (state === 'off') return <Badge tone="neutral"><ShieldOff className="h-3 w-3" />Désactivée</Badge>;
  return <span className="text-zinc-500" title="Compte sans mot de passe : pas de connexion à l'interface">—</span>;
}

// What this hub asks: from the compose (WEBAUTHN_RP_ID, MFA_REQUIRED), never changed from the UI.
export function MfaPolicy({ className }: { className?: string }) {
  const { mfa } = useMe();
  const text = !mfa.available
    ? 'Double authentification non disponible sur ce hub (WEBAUTHN_RP_ID non réglé).'
    : mfa.adminsRequired
      ? 'Double authentification obligatoire pour les admins (MFA_REQUIRED), facultative pour les autres profils.'
      : 'Double authentification facultative : chaque compte l’active en ajoutant une passkey.';
  const Icon = mfa.available && mfa.adminsRequired ? ShieldCheck : ShieldOff;
  return (
    <p className={`flex items-start gap-2 text-xs text-muted ${className ?? ''}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {text}
    </p>
  );
}
