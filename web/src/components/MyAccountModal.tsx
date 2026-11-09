import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, KeyRound, LogOut, MonitorSmartphone, Plus, Trash2 } from 'lucide-react';
import { api, PASSWORD_MIN_LENGTH, passwordErrorMessage, type AccountSession, type Passkey } from '../lib/api';
import { useMe } from '../lib/auth';
import { passkeyErrorMessage, registerPasskey } from '../lib/passkeys';
import { dateTime, timeAgo } from '../lib/format';
import { useToast } from '../lib/toast';
import { Badge, Button, CopyField, Modal, Spinner, Tabs } from './ui';

const TABS = [
  { id: 'password' as const, label: 'Mot de passe', icon: KeyRound },
  { id: 'passkeys' as const, label: 'Passkeys', icon: Fingerprint },
  { id: 'sessions' as const, label: 'Sessions', icon: MonitorSmartphone },
];
type Tab = (typeof TABS)[number]['id'];

// "Firefox · Linux" out of a user agent, enough to tell one's browsers apart
function browserLabel(ua: string | null) {
  if (!ua) return 'Navigateur inconnu';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return [browser, os].filter(Boolean).join(' · ') || ua.slice(0, 40);
}

function PasswordForm({ onDone }: { onDone: () => void }) {
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
      onDone();
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
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={busy}>Enregistrer</Button>
      </div>
    </form>
  );
}

function SessionRow({ s }: { s: AccountSession }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => api.revokeMySession(s.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-sessions'] });
      toast.success('Session fermée');
    },
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

function SessionList() {
  const { data, isLoading } = useQuery({ queryKey: ['my-sessions'], queryFn: api.mySessions });
  if (isLoading) return <Spinner />;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">
        Navigateurs où votre compte est connecté. Une session se ferme après une période sans utilisation, et dans tous les cas
        quelques jours après la connexion. Les clés d'API ne sont pas listées ici.
      </p>
      <ul className="divide-y divide-line">
        {data?.map((s) => <SessionRow key={s.id} s={s} />)}
      </ul>
    </div>
  );
}

function PasskeyRow({ p }: { p: Passkey }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.removePasskey(p.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-passkeys'] });
      toast.success('Passkey supprimée');
    },
    onError: (err) => {
      setConfirming(false);
      toast.error(passkeyErrorMessage(err));
    },
  });

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
          {confirming ? (
            <>
              <Button size="sm" variant="danger" icon={Trash2} loading={remove.isPending} onClick={() => remove.mutate()}>Confirmer</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Annuler</Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirming(true)}>Supprimer</Button>
          )}
        </div>
      </div>
      {/* public: what the access manifest hands to the agents, for the signatures of homelab#306 */}
      {showKey && p.publicKeyPem && <CopyField value={p.publicKeyPem} multiline />}
    </li>
  );
}

function PasskeyList() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['my-passkeys'], queryFn: api.myPasskeys });
  const [name, setName] = useState('');
  const add = useMutation({
    mutationFn: () => registerPasskey(name.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-passkeys'] });
      setName('');
      toast.success('Passkey enregistrée');
    },
    onError: (err) => toast.error(passkeyErrorMessage(err)),
  });

  if (isLoading) return <Spinner />;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Une passkey est demandée après le mot de passe à chaque connexion. Créez-la avec votre navigateur ou votre gestionnaire de
        mots de passe (Bitwarden…), et gardez-en une deuxième en secours.
        {me.mfa.required && ' Obligatoire pour les admins sur ce hub : la dernière ne peut pas être supprimée.'}
      </p>
      {data?.length ? (
        <ul className="divide-y divide-line">{data.map((p) => <PasskeyRow key={p.id} p={p} />)}</ul>
      ) : (
        <p className="text-sm text-zinc-400">Aucune passkey : la connexion se fait avec le seul mot de passe.</p>
      )}
      <form
        className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="mb-1.5 block text-xs font-medium text-muted">Nom de la nouvelle passkey</span>
          <input className="input" required maxLength={64} placeholder="Bitwarden" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <Button type="submit" icon={Plus} loading={add.isPending}>Ajouter</Button>
      </form>
    </div>
  );
}

// The account of the logged-in user: password, passkeys (when the hub offers them) and sessions.
export function MyAccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useMe();
  const [tab, setTab] = useState<Tab>('password');
  const tabs = TABS.filter((t) => t.id !== 'passkeys' || me.mfa.available);
  return (
    <Modal open={open} onClose={onClose} title="Mon compte">
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'password' ? <PasswordForm onDone={onClose} /> : tab === 'passkeys' ? <PasskeyList /> : <SessionList />}
    </Modal>
  );
}
