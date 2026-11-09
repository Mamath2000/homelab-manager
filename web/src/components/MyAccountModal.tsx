import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, MonitorSmartphone } from 'lucide-react';
import { api, PASSWORD_MIN_LENGTH, passwordErrorMessage, type AccountSession } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';
import { useToast } from '../lib/toast';
import { Badge, Button, Modal, Spinner, Tabs } from './ui';

const TABS = [
  { id: 'password' as const, label: 'Mot de passe', icon: KeyRound },
  { id: 'sessions' as const, label: 'Sessions', icon: MonitorSmartphone },
];

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

// The account of the logged-in user: password and sessions.
export function MyAccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'password' | 'sessions'>('password');
  return (
    <Modal open={open} onClose={onClose} title="Mon compte">
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'password' ? <PasswordForm onDone={onClose} /> : <SessionList />}
    </Modal>
  );
}
