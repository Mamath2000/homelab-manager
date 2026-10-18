import { useState, type ReactNode } from 'react';
import { KeyRound, ScanSearch } from 'lucide-react';
import { api, type PbsAgentLink, type PbsDetected, type PbsTokenOutcome } from '../lib/api';
import { useHosts } from '../lib/queries';
import { useToast } from '../lib/toast';
import { field } from './ProxmoxServer';
import { Button } from './ui';

// Text of what the agent did on the server for a token (toast).
function tokenOutcomeText(tokenId: string, o: PbsTokenOutcome) {
  const parts = [
    o.rotated
      ? `Jeton ${tokenId} recréé : le hub ne connaissait pas son secret`
      : o.created
        ? `Jeton ${tokenId} créé`
        : `Jeton ${tokenId} existant : droits mis à jour`,
  ];
  if (o.removed.length) parts.push(`droits retirés : ${o.removed.join(', ')}`);
  return parts.join(' · ');
}

// Host whose agent administers a Proxmox server (PBS, node of a PVE cluster): chosen among the agents
// with the capability, then "Détecter" asks its agent what runs there. The admin validates what was
// found (onDetected). linked: what the initial host is linked to, shown until a new detection.
// primary: the next thing to do in the window (first step not done).
export function AgentPicker<T extends { found: boolean }>({ capability, exclude, initialHostId, linked, primary, detect, onDetected, detectTitle, foundText, notFoundText, noAgentText }: {
  capability: string;
  exclude?: (h: { id: string; capabilities: string[] }) => boolean; // hosts not offered (the initial one stays)
  initialHostId?: string;
  linked?: ReactNode;
  primary?: boolean;
  detect: (hostId: string) => Promise<T>;
  onDetected: (hostId: string, found: T) => void;
  detectTitle: string;
  foundText: (found: T) => ReactNode;
  notFoundText: string;
  noAgentText: string;
}) {
  const toast = useToast();
  const { data: hosts } = useHosts();
  const [hostId, setHostId] = useState(initialHostId ?? '');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<T | null>(null);
  const candidates = (hosts ?? []).filter((h) => h.id === initialHostId || (h.capabilities.includes(capability) && !exclude?.(h))).sort((a, b) => a.name.localeCompare(b.name));
  const host = candidates.find((h) => h.id === hostId);

  const run = async () => {
    setBusy(true);
    setFound(null);
    try {
      const r = await detect(hostId);
      setFound(r);
      if (r.found) onDetected(hostId, r);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const current = linked && hostId === initialHostId ? linked : null;
  return (
    <div className="space-y-2">
      <label className="block">
        <span className={field}>Hôte</span>
        <select className="input" value={hostId} onChange={(e) => (setHostId(e.target.value), setFound(null))}>
          <option value="">— choisir l'hôte —</option>
          {candidates.map((h) => (
            <option key={h.id} value={h.id}>{h.name}{h.online ? '' : ' (hors ligne)'}</option>
          ))}
        </select>
      </label>
      <Button className="w-full" variant={primary ? 'primary' : 'secondary'} icon={ScanSearch} loading={busy} disabled={!host?.online} onClick={run} title={detectTitle}>
        {current ? 'Détecter à nouveau' : 'Détecter'}
      </Button>
      {found ? (
        found.found ? <div className="text-emerald-400">{foundText(found)}</div> : <p className="text-amber-400">{notFoundText}</p>
      ) : current ? (
        current
      ) : (
        candidates.length === 0 && <p className="text-amber-400">{noAgentText}</p>
      )}
    </div>
  );
}

// Host of a PBS: its agent finds the PBS, installed or in a running container.
export function PbsAgentPicker({ link, primary, onDetected }: { link?: PbsAgentLink; primary?: boolean; onDetected: (link: PbsAgentLink, found: PbsDetected) => void }) {
  return (
    <AgentPicker<PbsDetected>
      capability="pbs"
      initialHostId={link?.hostId}
      linked={link && <p>Relié : {link.mode === 'container' ? <>conteneur <code>{link.container}</code></> : 'PBS installé sur l’hôte'}.</p>}
      primary={primary}
      detect={api.detectPbs}
      onDetected={(hostId, r) => r.mode && onDetected({ hostId, mode: r.mode, ...(r.container ? { container: r.container } : {}) }, r)}
      detectTitle="L'agent cherche le PBS sur l'hôte : installé, ou dans un conteneur lancé"
      foundText={(r) => (
        <p>
          PBS {r.version} · {r.mode === 'container' ? <>conteneur <code>{r.container}</code></> : 'installé sur l’hôte'} · datastores : {r.datastores?.join(', ') || 'aucun'}
          {!r.port && <span className="block text-amber-400">Le conteneur ne publie pas le port 8007 : le PBS n'est pas joignable depuis le réseau, publier le port puis relancer Détecter.</span>}
        </p>
      )}
      notFoundText="Aucun PBS trouvé sur cet hôte (ni installé, ni dans un conteneur lancé)."
      noAgentText="Aucun agent ne sait administrer un PBS : installer ou mettre à jour l'agent de l'hôte du PBS."
    />
  );
}

// Token id (editable) and the button that has the agent create it (primary: the next thing to do in the
// window). An existing token whose secret the hub does not hold is created again by the agent.
export function TokenButton({ tokenId, onTokenIdChange, disabled, primary, create }: {
  tokenId: string;
  onTokenIdChange: (t: string) => void;
  disabled?: boolean;
  primary?: boolean;
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
    <div className="space-y-2">
      <label className="block" title="Un jeton existant dont le hub ne connaît pas le secret est recréé (nouveau secret)">
        <span className={field}>Identifiant du jeton</span>
        <input className="input h-8 py-1 font-mono text-xs" value={tokenId} onChange={(e) => onTokenIdChange(e.target.value.trim())} spellCheck={false} />
      </label>
      <Button className="w-full" size="sm" variant={primary ? 'primary' : 'secondary'} icon={KeyRound} loading={busy} disabled={disabled || !tokenId} onClick={run}>Créer le jeton</Button>
    </div>
  );
}
