import { useState, type ReactNode } from 'react';
import { api, type Me } from '../lib/api';
import { Button } from '../components/ui';

function Shell({ subtitle, children, onSubmit }: { subtitle: string; children: ReactNode; onSubmit: (e: React.FormEvent) => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,rgba(34,197,94,0.08),transparent_60%)] p-4">
      <form onSubmit={onSubmit} className="panel w-full max-w-sm space-y-5 p-7 shadow-2xl shadow-black/50">
        <div className="flex flex-col items-center gap-3 pb-1">
          <svg viewBox="0 0 32 32" className="h-11 w-11">
            <circle cx="16" cy="16" r="11" fill="none" stroke="#22c55e" strokeWidth="3.5" />
            <circle cx="16" cy="16" r="3.5" fill="#22c55e" />
          </svg>
          <div className="text-center">
            <h1 className="text-lg font-semibold tracking-[0.18em] text-zinc-100">HOMELAB</h1>
            <p className="mt-1 text-sm text-muted">{subtitle}</p>
          </div>
        </div>
        {children}
      </form>
    </div>
  );
}

export function Login({ noAccounts, onDone }: { noAccounts: boolean; onDone: (me: Me) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      onDone(await api.login(username, password));
    } catch (err) {
      setError((err as Error).message === 'invalid credentials' ? 'Identifiants invalides' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell subtitle="Connexion" onSubmit={submit}>
      {noAccounts && (
        <p className="rounded-md border border-line bg-raised px-3 py-2 text-xs text-zinc-300">
          Premier démarrage : connectez-vous avec <code className="text-zinc-100">superadmin</code> et le mot de passe à usage
          unique affiché dans les logs du hub (<code className="text-zinc-100">docker compose logs hub</code>), puis créez les comptes.
        </p>
      )}
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Utilisateur</span>
        <input className="input" autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Mot de passe</span>
        <input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <Button type="submit" variant="primary" className="w-full" loading={busy}>Se connecter</Button>
    </Shell>
  );
}

// Temporary password (new account or reset): replaced before entering the app.
export function ForcePasswordChange({ me, onDone, onLogout }: { me: Me; onDone: () => void; onLogout: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) return setError('Les mots de passe ne correspondent pas');
    setBusy(true);
    try {
      await api.changePassword(undefined, password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell subtitle={`Bonjour ${me.username}, choisissez votre mot de passe`} onSubmit={submit}>
      <p className="text-xs text-muted">Vous êtes connecté avec un mot de passe temporaire : remplacez-le pour accéder au hub.</p>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Nouveau mot de passe (8 caractères min.)</span>
        <input className="input" type="password" autoFocus required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Confirmation</span>
        <input className="input" type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <Button type="submit" variant="primary" className="w-full" loading={busy}>Enregistrer</Button>
      <button type="button" onClick={onLogout} className="w-full text-center text-xs text-muted hover:text-zinc-300">Se déconnecter</button>
    </Shell>
  );
}
