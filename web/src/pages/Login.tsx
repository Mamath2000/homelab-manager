import { useState } from 'react';
import { api } from '../lib/api';
import { Button } from '../components/ui';

export function Login({ setup, onDone }: { setup: boolean; onDone: (username: string) => void }) {
  const [username, setUsername] = useState(setup ? 'admin' : '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (setup && password !== confirm) return setError('Les mots de passe ne correspondent pas');
    setBusy(true);
    try {
      if (setup) await api.setup(username, password);
      else await api.login(username, password);
      onDone(username);
    } catch (err) {
      setError((err as Error).message === 'invalid credentials' ? 'Identifiants invalides' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,rgba(34,197,94,0.08),transparent_60%)] p-4">
      <form onSubmit={submit} className="panel w-full max-w-sm space-y-5 p-7 shadow-2xl shadow-black/50">
        <div className="flex flex-col items-center gap-3 pb-1">
          <svg viewBox="0 0 32 32" className="h-11 w-11">
            <circle cx="16" cy="16" r="11" fill="none" stroke="#22c55e" strokeWidth="3.5" />
            <circle cx="16" cy="16" r="3.5" fill="#22c55e" />
          </svg>
          <div className="text-center">
            <h1 className="text-lg font-semibold tracking-[0.18em] text-zinc-100">HOMELAB</h1>
            <p className="mt-1 text-sm text-muted">{setup ? 'Création du compte administrateur' : 'Connexion'}</p>
          </div>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Utilisateur</span>
          <input className="input" autoFocus={!setup} required value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Mot de passe</span>
          <input className="input" type="password" required minLength={setup ? 8 : 1} autoFocus={setup} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setup ? 'new-password' : 'current-password'} />
        </label>
        {setup && (
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Confirmation</span>
            <input className="input" type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </label>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          {setup ? 'Créer le compte' : 'Se connecter'}
        </Button>
      </form>
    </div>
  );
}
