import { useState } from 'react';
import { api, type Me } from '../lib/api';
import { Button } from '../components/ui';

export function Login({ noAccounts, onDone }: { noAccounts: boolean; onDone: (me: Me) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // the account has no password (new or reset): the user chooses one
  const [choosing, setChoosing] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (choosing && password !== confirm) return setError('Les mots de passe ne correspondent pas');
    setBusy(true);
    try {
      if (choosing) return onDone(await api.setPassword(username, password));
      const r = await api.login(username, password);
      if ('passwordSetupRequired' in r) {
        setChoosing(true);
        setPassword('');
      } else {
        onDone(r);
      }
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
            <p className="mt-1 text-sm text-muted">{choosing ? 'Choisissez un nouveau mot de passe' : 'Connexion'}</p>
          </div>
        </div>
        {noAccounts && !choosing && (
          <p className="rounded-md border border-line bg-raised px-3 py-2 text-xs text-zinc-300">
            Aucun compte. Créez le premier administrateur depuis le serveur :
            <code className="mt-1 block text-zinc-100">docker compose exec hub hm-admin create-admin &lt;nom&gt;</code>
          </p>
        )}
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Utilisateur</span>
          <input className="input" autoFocus required disabled={choosing} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">{choosing ? 'Nouveau mot de passe (8 caractères min.)' : 'Mot de passe'}</span>
          <input
            key={choosing ? 'new' : 'current'}
            className="input"
            type="password"
            required={choosing}
            minLength={choosing ? 8 : undefined}
            autoFocus={choosing}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={choosing ? 'new-password' : 'current-password'}
          />
        </label>
        {choosing && (
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Confirmation</span>
            <input className="input" type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </label>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          {choosing ? 'Enregistrer et se connecter' : 'Se connecter'}
        </Button>
        {!choosing && <p className="text-center text-xs text-muted">Mot de passe réinitialisé ? Laissez-le vide.</p>}
      </form>
    </div>
  );
}
