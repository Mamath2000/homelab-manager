import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { api, ApiError, PASSWORD_MIN_LENGTH, passwordErrorMessage, tooManyAttemptsMessage, type Me, type PasskeyChallenge } from '../lib/api';
import { answerPasskey, passkeyErrorMessage, registerPasskey } from '../lib/passkeys';
import { insecureOrigin, onHttps } from '../lib/transport';
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

export function Login({ noAccounts, cookieSecure, httpsUrl, onDone }: { noAccounts: boolean; cookieSecure: boolean; httpsUrl: string | null; onDone: (me: Me) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // password accepted, the account has a passkey: the browser answers this challenge
  const [challenge, setChallenge] = useState<PasskeyChallenge['passkey'] | null>(null);

  const confirmPasskey = async (c: PasskeyChallenge['passkey']) => {
    setError('');
    setBusy(true);
    try {
      onDone(await answerPasskey(c.ticket, c.options));
    } catch (err) {
      const message = passkeyErrorMessage(err);
      // the ticket is single use once the hub has seen it: back to the password
      if (err instanceof ApiError) setChallenge(null);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (challenge) return confirmPasskey(challenge);
    setError('');
    setBusy(true);
    try {
      const r = await api.login(username, password);
      if ('passkey' in r) {
        setChallenge(r.passkey);
        setBusy(false);
        return confirmPasskey(r.passkey);
      }
      onDone(r);
    } catch (err) {
      const message = (err as Error).message;
      setError(
        tooManyAttemptsMessage(err) ??
        (message === 'invalid credentials'
          ? 'Identifiants invalides'
          : message === 'https_required'
            ? 'Connexion refusée en HTTP : le hub est aussi servi en HTTPS, utilisez cette adresse.'
            : message),
      );
    } finally {
      setBusy(false);
    }
  };

  if (challenge) {
    return (
      <Shell subtitle="Connexion" onSubmit={submit}>
        <p className="text-sm text-zinc-300">
          Mot de passe accepté. Confirmez la connexion de <strong className="text-zinc-100">{username}</strong> avec votre passkey
          (navigateur ou gestionnaire de mots de passe).
        </p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button type="submit" variant="primary" icon={KeyRound} className="w-full" loading={busy}>Utiliser ma passkey</Button>
        <button type="button" onClick={() => { setChallenge(null); setError(''); }} className="w-full text-center text-xs text-muted hover:text-zinc-300">Annuler</button>
      </Shell>
    );
  }

  return (
    <Shell subtitle="Connexion" onSubmit={submit}>
      {cookieSecure && insecureOrigin() && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Le hub est réglé en <code>COOKIE_SECURE=true</code> mais cette page est servie en HTTP : le navigateur refusera la session
          et la connexion échouera. Accédez au hub en HTTPS (reverse proxy), ou retirez <code>COOKIE_SECURE</code> du compose.
        </p>
      )}
      {!cookieSecure && insecureOrigin() && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Cette page est servie en HTTP : le mot de passe et la session circuleront en clair sur le réseau.
          {httpsUrl && (
            <>
              {' '}
              <a className="font-medium underline" href={onHttps(httpsUrl)}>Passer en HTTPS</a>
            </>
          )}
        </p>
      )}
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
      setError(passwordErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell subtitle={`Bonjour ${me.username}, choisissez votre mot de passe`} onSubmit={submit}>
      <p className="text-xs text-muted">Vous êtes connecté avec un mot de passe temporaire : remplacez-le pour accéder au hub.</p>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Nouveau mot de passe ({PASSWORD_MIN_LENGTH} caractères min.)</span>
        <input className="input" type="password" autoFocus required minLength={PASSWORD_MIN_LENGTH} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Confirmation</span>
        <input className="input" type="password" required minLength={PASSWORD_MIN_LENGTH} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <Button type="submit" variant="primary" className="w-full" loading={busy}>Enregistrer</Button>
      <button type="button" onClick={onLogout} className="w-full text-center text-xs text-muted hover:text-zinc-300">Se déconnecter</button>
    </Shell>
  );
}

// MFA_REQUIRED, admin whose session was not proven with a passkey: one is registered before entering the app.
export function ForcePasskey({ me, onDone, onLogout }: { me: Me; onDone: () => void; onLogout: () => void }) {
  const existing = useQuery({ queryKey: ['my-passkeys'], queryFn: api.myPasskeys });
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await registerPasskey(name.trim());
      onDone();
    } catch (err) {
      setError(passkeyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // the account has a passkey but this session was opened without it (before the obligation): log in again
  if (existing.data?.length) {
    return (
      <Shell subtitle={`Bonjour ${me.username}`} onSubmit={(e) => { e.preventDefault(); onLogout(); }}>
        <p className="text-sm text-zinc-300">La connexion par passkey est obligatoire pour les admins. Reconnectez-vous : votre passkey vous sera demandée.</p>
        <Button type="submit" variant="primary" className="w-full">Se reconnecter</Button>
      </Shell>
    );
  }

  return (
    <Shell subtitle={`Bonjour ${me.username}, enregistrez une passkey`} onSubmit={submit}>
      <p className="text-xs text-muted">
        La connexion des admins demande une passkey en plus du mot de passe. Créez-la avec votre navigateur ou votre gestionnaire de
        mots de passe (Bitwarden…) ; enregistrez-en une deuxième plus tard depuis <strong>Mon compte</strong>, en secours.
      </p>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Nom de la passkey</span>
        <input className="input" autoFocus required maxLength={64} placeholder="Bitwarden" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <Button type="submit" variant="primary" icon={KeyRound} className="w-full" loading={busy || existing.isLoading}>Enregistrer une passkey</Button>
      <button type="button" onClick={onLogout} className="w-full text-center text-xs text-muted hover:text-zinc-300">Se déconnecter</button>
    </Shell>
  );
}

