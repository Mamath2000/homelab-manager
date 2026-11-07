import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { insecureOrigin, onHttps } from '../lib/transport';

const DISMISS_KEY = 'hm:hopClearDismissed';

function dismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

// Connection in clear (homelab#315):
//   - page in http from another machine: for everyone, not dismissable (their password and session go in clear);
//   - https up to a reverse proxy, then in clear to the hub: admins only (an infrastructure setting), dismissable.
export function TransportBanner() {
  const me = useMe();
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus, staleTime: Infinity });
  const [hidden, setHidden] = useState(dismissed);

  if (insecureOrigin()) {
    const httpsUrl = auth.data?.httpsUrl;
    return (
      <div role="alert" className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Connexion non chiffrée : votre mot de passe et votre session circulent en clair sur le réseau.{' '}
          {httpsUrl ? (
            <a className="font-medium underline" href={onHttps(httpsUrl)}>Passer en HTTPS</a>
          ) : (
            'Accédez au hub par un reverse proxy HTTPS ou activez son port HTTPS (HTTPS_PORT).'
          )}
        </p>
      </div>
    );
  }

  if (!me.canSettings || !auth.data?.transport?.hopClear || hidden) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // not remembered: hidden until the next load
    }
    setHidden(true);
  };
  return (
    <div className="mb-4 flex items-start gap-2 rounded-md border border-line bg-raised px-3 py-2 text-sm text-zinc-300">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
      <p className="flex-1">
        Le trajet entre le reverse proxy et le hub n'est pas chiffré. Si le proxy est sur une autre machine, activez le port
        HTTPS du hub (<code>HTTPS_PORT</code>) et faites pointer le proxy en <code>https://</code>.
      </p>
      <button type="button" onClick={dismiss} aria-label="Masquer" title="Masquer" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-zinc-400 hover:bg-bg hover:text-zinc-100">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
