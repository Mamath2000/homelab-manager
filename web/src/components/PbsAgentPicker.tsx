import { useState } from 'react';
import { KeyRound, ScanSearch } from 'lucide-react';
import { api, type PbsAgentLink, type PbsDetected, type PbsTokenOutcome } from '../lib/api';
import { useHosts } from '../lib/queries';
import { useToast } from '../lib/toast';
import { field } from './ProxmoxServer';
import { Button } from './ui';

// Text of what the agent did on the PBS for a token (toast).
function tokenOutcomeText(tokenId: string, o: PbsTokenOutcome) {
  const parts = [o.created ? `Jeton ${tokenId} créé` : `Jeton ${tokenId} existant : droits mis à jour`];
  if (o.removed.length) parts.push(`droits retirés : ${o.removed.join(', ')}`);
  return parts.join(' · ');
}

// Host of the PBS: chosen among the agents able to administer one, then "Détecter" asks its agent what
// runs there (native or in a container). The admin validates what was found (onDetected).
export function PbsAgentPicker({ link, onDetected }: { link?: PbsAgentLink; onDetected: (link: PbsAgentLink, found: PbsDetected) => void }) {
  const toast = useToast();
  const { data: hosts } = useHosts();
  const [hostId, setHostId] = useState(link?.hostId ?? '');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<PbsDetected | null>(null);
  const candidates = (hosts ?? []).filter((h) => h.capabilities.includes('pbs') || h.id === link?.hostId).sort((a, b) => a.name.localeCompare(b.name));
  const host = candidates.find((h) => h.id === hostId);

  const detect = async () => {
    setBusy(true);
    setFound(null);
    try {
      const r = await api.detectPbs(hostId);
      setFound(r);
      if (r.found && r.mode) onDetected({ hostId, mode: r.mode, ...(r.container ? { container: r.container } : {}) }, r);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const current = link && link.hostId === hostId ? link : null;
  return (
    <div className="space-y-2">
      <span className={field}>Hôte du PBS (son agent crée les jetons)</span>
      <div className="flex gap-2">
        <select className="input flex-1" value={hostId} onChange={(e) => (setHostId(e.target.value), setFound(null))}>
          <option value="">— choisir l'hôte —</option>
          {candidates.map((h) => (
            <option key={h.id} value={h.id}>{h.name}{h.online ? '' : ' (hors ligne)'}</option>
          ))}
        </select>
        <Button icon={ScanSearch} loading={busy} disabled={!host?.online} onClick={detect} title="L'agent cherche le PBS sur l'hôte : installé, ou dans un conteneur lancé">Détecter</Button>
      </div>
      {found ? (
        found.found ? (
          <p className="text-emerald-400">
            PBS {found.version} · {found.mode === 'container' ? <>conteneur <code>{found.container}</code></> : 'installé sur l’hôte'} · datastores : {found.datastores?.join(', ') || 'aucun'}
            {!found.port && <span className="block text-amber-400">Le conteneur ne publie pas le port 8007 : le PBS n'est pas joignable depuis le réseau, publier le port puis relancer Détecter.</span>}
          </p>
        ) : (
          <p className="text-amber-400">Aucun PBS trouvé sur cet hôte (ni installé, ni dans un conteneur lancé).</p>
        )
      ) : current ? (
        <p>Relié : {current.mode === 'container' ? <>conteneur <code>{current.container}</code></> : 'PBS installé sur l’hôte'}.</p>
      ) : (
        candidates.length === 0 && <p className="text-amber-400">Aucun agent ne sait administrer un PBS : installer ou mettre à jour l'agent de l'hôte du PBS.</p>
      )}
    </div>
  );
}

// Token id (editable: another name when that token exists on the PBS without the hub holding its
// secret) and the button that has the agent create it.
export function PbsTokenButton({ tokenId, onTokenIdChange, disabled, create }: {
  tokenId: string;
  onTokenIdChange: (t: string) => void;
  disabled?: boolean;
  create: () => Promise<PbsTokenOutcome>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      toast.success(tokenOutcomeText(tokenId, await create()));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="block min-w-0 flex-1" title="Si ce jeton existe déjà sur le PBS sans que le hub connaisse son secret, choisir un autre nom">
        <span className={field}>Identifiant du jeton</span>
        <input className="input h-8 py-1 font-mono text-xs" value={tokenId} onChange={(e) => onTokenIdChange(e.target.value.trim())} spellCheck={false} />
      </label>
      <Button size="sm" icon={KeyRound} loading={busy} disabled={disabled || !tokenId} onClick={run}>Créer le jeton</Button>
    </div>
  );
}
