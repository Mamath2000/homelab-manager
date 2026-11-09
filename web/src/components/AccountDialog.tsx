import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, Key, KeyRound, LogOut, MonitorSmartphone, Plus, ShieldOff, Trash2, TriangleAlert, UserRound } from 'lucide-react';
import {
  accountErrorMessage,
  api,
  PASSWORD_MIN_LENGTH,
  passwordErrorMessage,
  type Account,
  type AccountSecret,
  type AccountSession,
  type ApiKey,
  type Passkey,
  type Profile,
} from '../lib/api';
import { mfaState, PROFILE_LABELS, useMe } from '../lib/auth';
import { dateTime, timeAgo } from '../lib/format';
import { passkeyErrorMessage, registerPasskey } from '../lib/passkeys';
import { useToast } from '../lib/toast';
import { MfaBadge, MfaPolicy } from './MfaStatus';
import { Badge, Button, ConfirmModal, CopyField, Modal, ResponsiveList, Spinner, Tabs } from './ui';

// One dialog for an account, whoever opens it (homelab#291): « Mon compte » in the menu, or an admin on the accounts
// page. Same tabs both ways, each acting on its own (its button applies at once); what the viewer may not change is
// shown read only.
//   self   the logged-in account
//   other  another account, for an admin
//   new    creation: identity, profile and password only
export type AccountTarget = { kind: 'self' } | { kind: 'other'; id: string } | { kind: 'new' };

const TABS = [
  { id: 'account' as const, label: 'Compte', icon: UserRound },
  { id: 'password' as const, label: 'Mot de passe', icon: KeyRound },
  { id: 'mfa' as const, label: 'Double authentification', icon: Fingerprint },
  { id: 'sessions' as const, label: 'Sessions', icon: MonitorSmartphone },
  { id: 'apiKeys' as const, label: "Clés d'API", icon: Key },
];
type Tab = (typeof TABS)[number]['id'];

const PROFILES: { value: Profile; hint: string }[] = [
  { value: 'admin', hint: 'tout : hôtes, paramètres, comptes' },
  { value: 'operator', hint: 'lance les vérifications, mises à jour, nettoyages et redémarrages' },
  { value: 'viewer', hint: 'lecture seule' },
];

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-sm text-zinc-100">{children}</div>
    </div>
  );
}

function ProfilePicker({ value, onChange }: { value: Profile; onChange: (p: Profile) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {PROFILES.map((r) => (
        <label
          key={r.value}
          className={`cursor-pointer rounded-md border p-3 text-sm transition-colors ${value === r.value ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-line hover:border-zinc-600'}`}
        >
          <input type="radio" name="profile" className="sr-only" checked={value === r.value} onChange={() => onChange(r.value)} />
          <div className="font-medium text-zinc-100">{PROFILE_LABELS[r.value]}</div>
          <div className="mt-0.5 text-xs text-muted">{r.hint}</div>
        </label>
      ))}
    </div>
  );
}

// "Firefox · Linux" out of a user agent, enough to tell one's browsers apart
function browserLabel(ua: string | null) {
  if (!ua) return 'Navigateur inconnu';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return [browser, os].filter(Boolean).join(' · ') || ua.slice(0, 40);
}

// --- Compte -----------------------------------------------------------------------------------------------------

function AccountTab({ account, editable, onCreated }: { account: Account | null; editable: boolean; onCreated: (r: AccountSecret) => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [username, setUsername] = useState(account?.username ?? '');
  const [displayName, setDisplayName] = useState(account?.displayName ?? '');
  const [profile, setProfile] = useState<Profile>(account?.profile ?? 'viewer');
  const [noPassword, setNoPassword] = useState(false);
  const save = useMutation({
    mutationFn: async () =>
      account ? (await api.updateUser(account.id, { username, displayName, profile }), null) : api.createUser(username, displayName, profile, noPassword),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      // own username / name may have changed
      if (account) qc.invalidateQueries({ queryKey: ['auth'] });
      toast.success(
        account ? 'Compte modifié' : noPassword ? `Compte ${username} créé : ajoutez-lui une clé d'API en le modifiant` : `Compte ${username} créé : mot de passe temporaire dans le tableau`,
      );
      if (created) onCreated(created);
    },
    onError: (err) => toast.error(accountErrorMessage(err)),
  });

  if (!editable) {
    return (
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Nom">{me.displayName || '—'}</Field>
        <Field label="Identifiant de connexion"><span className="font-mono">{me.username}</span></Field>
        <Field label="Profil">{PROFILE_LABELS[me.profile]}</Field>
        <p className="text-xs text-muted sm:col-span-3">Le nom, l’identifiant et le profil se modifient par un admin, depuis la page Comptes.</p>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-6">
      <Section title="Identité">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Nom (facultatif)</span>
            <input className="input" autoFocus maxLength={64} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Prénom Nom" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Identifiant de connexion</span>
            <input className="input" required maxLength={64} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </label>
        </div>
      </Section>
      <Section title="Profil">
        <ProfilePicker value={profile} onChange={setProfile} />
      </Section>
      {!account && (
        <Section title="Mot de passe">
          <div className="space-y-2">
            <label className="flex cursor-pointer items-start gap-2.5 text-sm text-zinc-200">
              <input type="radio" name="password" className="mt-1 accent-emerald-500" checked={!noPassword} onChange={() => setNoPassword(false)} />
              <span>
                Mot de passe temporaire
                <span className="block text-xs text-muted">Généré et affiché une fois ; l'utilisateur le remplace à sa première connexion.</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 text-sm text-zinc-200">
              <input type="radio" name="password" className="mt-1 accent-emerald-500" checked={noPassword} onChange={() => setNoPassword(true)} />
              <span>
                Aucun mot de passe
                <span className="block text-xs text-muted">Compte réservé aux services : accès par clé d'API, à ajouter ensuite en modifiant le compte.</span>
              </span>
            </label>
          </div>
          {noPassword && (
            <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-300">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              Cet utilisateur ne pourra pas se connecter à l'interface.
            </p>
          )}
        </Section>
      )}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={save.isPending}>{account ? 'Enregistrer' : 'Créer'}</Button>
      </div>
    </form>
  );
}

// --- Mot de passe -----------------------------------------------------------------------------------------------

function OwnPasswordTab() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.changePassword(current, next);
      toast.success('Mot de passe modifié, vos autres sessions sont fermées');
      setCurrent('');
      setNext('');
    } catch (err) {
      toast.error(passwordErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Mot de passe actuel</span>
        <input className="input" type="password" autoFocus required value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Nouveau mot de passe ({PASSWORD_MIN_LENGTH} caractères min.)</span>
        <input className="input" type="password" required minLength={PASSWORD_MIN_LENGTH} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </label>
      <p className="text-xs text-muted">Changer son mot de passe ferme ses autres sessions.</p>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={busy}>Enregistrer</Button>
      </div>
    </form>
  );
}

function PasswordTab({ account, onIssued }: { account: Account; onIssued: (r: AccountSecret) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const reset = useMutation({
    mutationFn: () => api.resetPassword(account.id),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setConfirming(false);
      setIssued(r.temporaryPassword ?? null);
      onIssued(r);
    },
    onError: (err) => toast.error(accountErrorMessage(err)),
  });

  if (!account.hasPassword) {
    return <p className="text-sm text-zinc-400">Aucun mot de passe : compte réservé aux services, qui ne se connecte pas à l’interface (clés d’API seulement).</p>;
  }
  return (
    <div className="space-y-4">
      <Field label="État">
        {account.mustChangePassword ? <span className="text-amber-300">temporaire, à changer à la prochaine connexion</span> : 'défini par l’utilisateur'}
      </Field>
      {issued && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <div className="text-sm text-zinc-200">Mot de passe temporaire</div>
          <CopyField value={issued} />
          <p className="text-xs text-amber-300">Affiché une seule fois, à transmettre à l’utilisateur.</p>
        </div>
      )}
      <p className="text-xs text-muted">Réinitialiser génère un mot de passe temporaire, à changer à la connexion, et ferme les sessions du compte.</p>
      <div className="flex justify-end gap-2">
        {confirming ? (
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Annuler</Button>
            <Button variant="danger" icon={KeyRound} loading={reset.isPending} onClick={() => reset.mutate()}>Confirmer la réinitialisation</Button>
          </>
        ) : (
          <Button icon={KeyRound} onClick={() => setConfirming(true)}>Réinitialiser</Button>
        )}
      </div>
    </div>
  );
}

// --- Double authentification ------------------------------------------------------------------------------------

function PasskeyRow({ p, onRemove, removing }: { p: Passkey; onRemove?: () => void; removing?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [showKey, setShowKey] = useState(false);
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm">
          <div className="flex items-center gap-2 text-zinc-100">
            {p.name}
            {p.backedUp && <Badge tone="info">synchronisée</Badge>}
          </div>
          <div className="text-xs text-muted">
            enregistrée le {dateTime(p.createdAt)} · {p.lastUsedAt ? `utilisée ${timeAgo(p.lastUsedAt)}` : 'jamais utilisée'}
          </div>
        </div>
        <div className="flex gap-2">
          {p.publicKeyPem && (
            <Button size="sm" variant="ghost" onClick={() => setShowKey(!showKey)}>{showKey ? 'Masquer la clé' : 'Clé publique'}</Button>
          )}
          {onRemove &&
            (confirming ? (
              <>
                <Button size="sm" variant="danger" icon={Trash2} loading={removing} onClick={onRemove}>Confirmer</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Annuler</Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirming(true)}>Supprimer</Button>
            ))}
        </div>
      </div>
      {/* public: what the access manifest hands to the agents, for the signatures of homelab#306 */}
      {showKey && p.publicKeyPem && <CopyField value={p.publicKeyPem} multiline />}
    </li>
  );
}

function MfaTab({ target, account }: { target: AccountTarget; account: Account | null }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const self = target.kind === 'self';
  const id = target.kind === 'other' ? target.id : null;
  const { data, isLoading } = useQuery({
    queryKey: self ? ['my-passkeys'] : ['user-passkeys', id],
    queryFn: () => (self ? api.myPasskeys() : api.userPasskeys(id!)),
    enabled: me.mfa.available,
  });
  const [name, setName] = useState('');
  const [disabling, setDisabling] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: self ? ['my-passkeys'] : ['user-passkeys', id] });
    qc.invalidateQueries({ queryKey: ['users'] });
  };
  const add = useMutation({
    mutationFn: () => registerPasskey(name.trim()),
    onSuccess: () => {
      refresh();
      setName('');
      toast.success('Passkey enregistrée');
    },
    onError: (err) => toast.error(passkeyErrorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (p: Passkey) => api.removePasskey(p.id),
    onSuccess: () => {
      refresh();
      toast.success('Passkey supprimée');
    },
    onError: (err) => toast.error(passkeyErrorMessage(err)),
  });
  const disable = useMutation({
    mutationFn: () => (self ? api.disableMyMfa() : api.resetUserPasskeys(id!)),
    onSuccess: () => {
      refresh();
      setDisabling(false);
      toast.success(self ? 'Double authentification désactivée' : `Double authentification de ${account?.username} désactivée, ses sessions sont fermées`);
    },
    onError: (err) => {
      setDisabling(false);
      toast.error(passkeyErrorMessage(err));
    },
  });

  const subject = self ? { profile: me.profile, hasPassword: true } : { profile: account?.profile ?? 'viewer', hasPassword: !!account?.hasPassword };
  const count = data?.length ?? 0;
  const state = mfaState({ ...subject, passkeys: count }, me.mfa.adminsRequired);
  // the last passkey of an admin stays while they are required (the hub refuses it too)
  const locked = subject.profile === 'admin' && me.mfa.adminsRequired;

  if (!me.mfa.available) return <MfaPolicy />;
  if (state === 'none') {
    return (
      <div className="space-y-3">
        <MfaPolicy />
        <p className="text-sm text-zinc-400">Compte sans mot de passe : il ne se connecte pas à l’interface, la double authentification ne s’applique pas.</p>
      </div>
    );
  }
  if (isLoading) return <Spinner />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Field label="État"><MfaBadge state={state} count={count} /></Field>
        {count > 0 && (self ? !locked : true) && (
          <Button size="sm" variant="ghost" icon={ShieldOff} onClick={() => setDisabling(true)}>Désactiver</Button>
        )}
      </div>
      <MfaPolicy />
      <p className="text-xs text-muted">
        {self
          ? 'Une passkey est demandée après le mot de passe à chaque connexion, et avant les actions sensibles. Créez-la avec votre navigateur ou votre gestionnaire de mots de passe (Bitwarden…), et gardez-en une deuxième en secours.'
          : 'Seul l’utilisateur ajoute ses passkeys, depuis « Mon compte ». Désactiver supprime toutes ses passkeys (passkey perdue) et ferme ses sessions.'}
      </p>
      {count > 0 ? (
        <ul className="divide-y divide-line">
          {data!.map((p) => (
            <PasskeyRow
              key={p.id}
              p={p}
              removing={remove.isPending}
              onRemove={self && !(locked && count === 1) ? () => remove.mutate(p) : undefined}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-400">Aucune passkey : la connexion se fait avec le seul mot de passe.</p>
      )}
      {self && (
        <form
          className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <label className="min-w-0 flex-1">
            <span className="mb-1.5 block text-xs font-medium text-muted">{count ? 'Nom de la nouvelle passkey' : 'Activer : nom de la première passkey'}</span>
            <input className="input" required maxLength={64} placeholder="Bitwarden" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <Button type="submit" icon={Plus} loading={add.isPending}>{count ? 'Ajouter' : 'Activer'}</Button>
        </form>
      )}
      <ConfirmModal
        open={disabling}
        onClose={() => setDisabling(false)}
        onConfirm={() => disable.mutate()}
        title="Désactiver la double authentification"
        confirmLabel="Désactiver"
        danger
        loading={disable.isPending}
      >
        {self ? (
          <>Supprimer vos {count} passkey(s) ? La connexion se fera avec le seul mot de passe.</>
        ) : (
          <>
            Supprimer les {count} passkey(s) de <strong>{account?.username}</strong> et fermer ses sessions ?
            {locked ? ' Elle est obligatoire pour les admins : il en enregistrera une nouvelle à sa prochaine connexion.' : ' Il se connectera avec son seul mot de passe.'}
          </>
        )}
      </ConfirmModal>
    </div>
  );
}

// --- Sessions ---------------------------------------------------------------------------------------------------

function SessionRow({ s, onRevoke }: { s: AccountSession; onRevoke: () => Promise<unknown> }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: onRevoke,
    onSuccess: () => toast.success('Session fermée'),
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0 text-sm">
        <div className="flex items-center gap-2 text-zinc-100">
          {browserLabel(s.userAgent)}
          {s.current && <Badge tone="ok">cette session</Badge>}
        </div>
        <div className="text-xs text-muted">
          {s.ip ?? 'adresse inconnue'} · {s.lastSeenAt ? `utilisée ${timeAgo(s.lastSeenAt)}` : 'ouverte avant le suivi des sessions'}
          {s.createdAt && ` · ouverte le ${dateTime(s.createdAt)}`} · expire le {dateTime(s.expiresAt)}
        </div>
      </div>
      {!s.current &&
        (confirming ? (
          <div className="flex gap-2">
            <Button size="sm" variant="danger" icon={LogOut} loading={revoke.isPending} onClick={() => revoke.mutate()}>Confirmer</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Annuler</Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" icon={LogOut} onClick={() => setConfirming(true)}>Fermer</Button>
        ))}
    </li>
  );
}

function SessionsTab({ target, account }: { target: AccountTarget; account: Account | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const self = target.kind === 'self';
  const id = target.kind === 'other' ? target.id : null;
  const key = self ? ['my-sessions'] : ['user-sessions', id];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => (self ? api.mySessions() : api.userSessions(id!)) });
  const [closingAll, setClosingAll] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['users'] });
  };
  const closeAll = useMutation({
    mutationFn: () => api.revokeSessions(id!),
    onSuccess: () => {
      refresh();
      setClosingAll(false);
      toast.success(`Sessions de ${account?.username} fermées`);
    },
    onError: (err) => toast.error(accountErrorMessage(err)),
  });

  if (isLoading) return <Spinner />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 flex-1 text-xs text-muted">
          Navigateurs où {self ? 'votre compte est connecté' : 'le compte est connecté'}. Une session se ferme après une période sans
          utilisation, et dans tous les cas quelques jours après la connexion. Les clés d'API ne sont pas concernées.
        </p>
        {!self && !!data?.length && (
          <Button size="sm" variant="ghost" icon={LogOut} onClick={() => setClosingAll(true)}>Tout fermer</Button>
        )}
      </div>
      {data?.length ? (
        <ul className="divide-y divide-line">
          {data.map((s) => (
            <SessionRow
              key={s.id}
              s={s}
              onRevoke={() => (self ? api.revokeMySession(s.id) : api.revokeUserSession(id!, s.id)).then(refresh)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-400">Aucune session ouverte.</p>
      )}
      <ConfirmModal
        open={closingAll}
        onClose={() => setClosingAll(false)}
        onConfirm={() => closeAll.mutate()}
        title="Fermer les sessions"
        confirmLabel="Fermer les sessions"
        danger
        loading={closeAll.isPending}
      >
        Fermer les {data?.length} session(s) ouverte(s) du compte <strong>{account?.username}</strong> ? Ses clés d'API restent valides.
      </ConfirmModal>
    </div>
  );
}

// --- Clés d'API -------------------------------------------------------------------------------------------------

// One per consumer (Homepage, a script…), each revoked on its own; they carry the rights of the account's profile.
// A new key is shown once, here.
function ApiKeysTab({ account }: { account: Account }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<{ name: string; value: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const create = useMutation({
    mutationFn: () => api.createApiKey(account.id, name.trim()),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setIssued({ name: name.trim(), value: r.apiKey! });
      setName('');
    },
    onError: (err) => toast.error(accountErrorMessage(err)),
  });
  const revoke = useMutation({
    mutationFn: (k: ApiKey) => api.revokeApiKey(account.id, k.id),
    onSuccess: (_, k) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(`Clé « ${k.name} » révoquée`);
      setRevoking(null);
    },
    onError: (err) => toast.error(accountErrorMessage(err)),
  });

  return (
    <Section title="Clés d'API" hint="Accès sans mot de passe, en-tête « Authorization: Bearer <clé> », avec les droits du profil. Une clé par service.">
      {issued && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <div className="text-sm text-zinc-200">Clé « {issued.name} » créée</div>
          <CopyField value={issued.value} />
          <p className="text-xs text-amber-300">
            Affichée une seule fois, copiez-la maintenant.{' '}
            <button type="button" className="text-muted underline hover:text-zinc-200" onClick={() => setIssued(null)}>Masquer</button>
          </p>
        </div>
      )}
      {account.apiKeys.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-line">
          <ResponsiveList mode="mobile">
            {account.apiKeys.map((k) => (
              <article key={k.id} className="space-y-2 p-4">
                <div className="font-medium text-zinc-100">{k.name}</div>
                <div className="grid grid-cols-2 gap-2 text-xs text-zinc-400">
                  <div><span className="text-muted">Créée le · </span>{dateTime(k.createdAt)}</div>
                  <div><span className="text-muted">Dernière utilisation · </span>{k.lastUsedAt ? dateTime(k.lastUsedAt) : 'jamais'}</div>
                </div>
                <Button size="sm" variant="ghost" icon={Trash2} className="min-h-10 md:min-h-0" title="Révoquer cette clé" onClick={() => setRevoking(k)}>Révoquer</Button>
              </article>
            ))}
          </ResponsiveList>
          <ResponsiveList mode="desktop">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-white/[0.02]">
              <tr className="text-left">
                <th className="th">Nom</th>
                <th className="th">Créée le</th>
                <th className="th">Dernière utilisation</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {account.apiKeys.map((k) => (
                <tr key={k.id} className="border-b border-line/60 last:border-0">
                  <td className="td font-medium text-zinc-100">{k.name}</td>
                  <td className="td text-xs text-zinc-400">{dateTime(k.createdAt)}</td>
                  <td className="td text-xs text-zinc-400">{k.lastUsedAt ? dateTime(k.lastUsedAt) : 'jamais'}</td>
                  <td className="td text-right">
                    <Button size="sm" variant="ghost" icon={Trash2} title="Révoquer cette clé" onClick={() => setRevoking(k)}>Révoquer</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </ResponsiveList>
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-sm text-muted">Aucune clé d'API.</p>
      )}
      <div className="flex items-end gap-2">
        <label className="block flex-1">
          <span className="mb-1.5 block text-xs font-medium text-muted">Nouvelle clé</span>
          <input
            className="input"
            maxLength={64}
            value={name}
            placeholder="Nom du service (Homepage, script de sauvegarde…)"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (name.trim()) create.mutate();
              }
            }}
          />
        </label>
        <Button type="button" icon={KeyRound} loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>Générer</Button>
      </div>
      <ConfirmModal
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking)}
        title="Révoquer la clé d'API"
        confirmLabel="Révoquer"
        danger
        loading={revoke.isPending}
      >
        Révoquer la clé <strong>{revoking?.name}</strong> ? Le service qui l'utilise sera refusé immédiatement.
      </ConfirmModal>
    </Section>
  );
}

// --- the dialog -------------------------------------------------------------------------------------------------

export function AccountDialog({ target, onClose, onSecret = () => {} }: {
  target: AccountTarget;
  onClose: () => void;
  // temporary password issued (creation, reset): also shown in the accounts table
  onSecret?: (r: AccountSecret) => void;
}) {
  const me = useMe();
  // the admins read the accounts (API keys, password state), also their own
  const { data } = useQuery({ queryKey: ['users'], queryFn: api.users, enabled: me.canManage && target.kind !== 'new' });
  const account =
    target.kind === 'other' ? data?.find((a) => a.id === target.id) ?? null : target.kind === 'self' ? data?.find((a) => a.username === me.username) ?? null : null;
  const [tab, setTab] = useState<Tab>('account');

  // the account went away (deleted elsewhere): nothing left to show
  const gone = target.kind === 'other' && data && !account;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);

  const tabs = TABS.filter((t) => {
    if (target.kind === 'new') return t.id === 'account';
    // API keys: managed by the admins (the hub refuses the others)
    if (t.id === 'apiKeys') return me.canManage && !!account;
    if (t.id === 'password' && target.kind === 'other') return !!account;
    return true;
  });
  const title =
    target.kind === 'self' ? 'Mon compte' : target.kind === 'new' ? 'Nouveau compte' : `Compte ${account ? account.displayName || account.username : ''}`;

  let body: React.ReactNode;
  // an admin edits their own account too: wait for it rather than showing the creation form
  if ((target.kind === 'other' || (target.kind === 'self' && me.canManage)) && !account) body = <Spinner />;
  else if (tab === 'account') body = <AccountTab key={account?.id ?? 'new'} account={account} editable={target.kind === 'new' || me.canManage} onCreated={(r) => { onSecret(r); onClose(); }} />;
  else if (tab === 'password') body = target.kind === 'self' ? <OwnPasswordTab /> : <PasswordTab account={account!} onIssued={onSecret} />;
  else if (tab === 'mfa') body = <MfaTab target={target} account={account} />;
  else if (tab === 'sessions') body = <SessionsTab target={target} account={account} />;
  else body = account && <ApiKeysTab account={account} />;

  return (
    <Modal open wide="xl" scroll onClose={onClose} title={title} footer={<Button variant="ghost" onClick={onClose}>Fermer</Button>}>
      {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={setTab} />}
      {body}
    </Modal>
  );
}
