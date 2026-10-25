import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Plus } from 'lucide-react';
import { api, type AccessNetwork, type InstallInfo } from '../lib/api';
import { useHost, useUpdateHostCache } from '../lib/queries';
import { stepStates } from '../lib/steps';
import { InstallInstructions } from './InstallInstructions';
import { HaExcludedField } from './HaExcludedField';
import { SiteSelect, TagPicker } from './HostTags';
import { Step, Steps } from './PbsDialog';
import { RoamingField } from './RoamingField';
import { Button, Modal, Spinner } from './ui';

// Three steps from left to right: name and site, tags and options, system and install script. The host
// is only created when the script is generated; cancelling before its agent connects deletes it again.
export function AddHostModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [siteId, setSiteId] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [roaming, setRoaming] = useState(false);
  const [haExcluded, setHaExcluded] = useState(false);
  const [network, setNetwork] = useState<AccessNetwork>('lan');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ hostId: string; install: InstallInfo } | null>(null);
  const upsert = useUpdateHostCache();
  const { data: created } = useHost(result?.hostId);
  const connected = !!created?.enrolledAt;
  // the Tailscale network is offered once the hub address on the tailnet is set
  const { data: agents } = useQuery({ queryKey: ['settings', 'agents'], queryFn: api.agentSettings, enabled: open });
  const tailscale = !!agents?.tailscaleHub;

  // Tailscale hosts start outside Home Assistant (and unmanaged, on the hub side); both stay editable
  const pickNetwork = (n: AccessNetwork) => {
    setNetwork(n);
    setHaExcluded(n === 'tailscale');
  };

  const reset = () => {
    setName('');
    setSiteId('');
    setTags([]);
    setRoaming(false);
    setHaExcluded(false);
    setNetwork('lan');
    setError('');
    setResult(null);
    onClose();
  };

  // not connected yet: the host is only a ghost, it goes away with the dialog
  const close = () => {
    if (result && !connected) void api.deleteHost(result.hostId).catch(() => undefined);
    reset();
  };

  const generate = async () => {
    setBusy(true);
    setError('');
    try {
      const { host, ...install } = await api.createHost({ name, siteId, tags, roaming, haExcluded, accessNetwork: network });
      upsert(host);
      setResult({ hostId: host.id, install });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const locked = !!result;
  const nameOk = name.trim().length > 0;
  const [identified, generated, online] = stepStates([nameOk, locked, connected]);

  return (
    <Modal
      open={open}
      onClose={close}
      wide="screen"
      fixed
      dismissable={false}
      title={result ? `Ajouter ${name}` : 'Ajouter un hôte'}
      footer={
        <>
          {result && !connected && (
            <span className="mr-auto flex items-center gap-2 text-sm text-muted">
              <Spinner className="h-4 w-4" /> En attente de la connexion de l'agent…
            </span>
          )}
          <Button onClick={close}>Annuler</Button>
          <Button variant="primary" icon={CheckCircle2} disabled={!connected} onClick={reset}>
            Terminé
          </Button>
        </>
      }
    >
      <Steps fill threeCols>
        <Step n={1} title="Nom et site" state={identified} intro="Comment l'hôte s'appelle dans le hub, et où il se trouve.">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Nom</span>
            <input
              className="input"
              autoFocus
              required
              maxLength={64}
              disabled={locked}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="pihole, docker-01, pve…"
            />
          </label>
          <fieldset disabled={locked} className="space-y-4">
            <SiteSelect value={siteId} onChange={setSiteId} />
          </fieldset>
        </Step>
        <Step
          n={2}
          title="Tags et options"
          state={nameOk ? (locked ? 'done' : 'active') : 'todo'}
          intro="Facultatif, modifiable ensuite depuis la fiche de l'hôte."
          footer={
            <>
              {error && <p className="text-sm text-red-400">{error}</p>}
              {!locked && (
                <Button variant="primary" icon={Plus} loading={busy} disabled={!nameOk} onClick={() => void generate()}>
                  Créer et générer le script
                </Button>
              )}
            </>
          }
        >
          <fieldset disabled={locked || !nameOk} className="space-y-4">
            <TagPicker value={tags} onChange={setTags} />
            {tailscale && (
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted">Réseau d'accès</span>
                <select className="input" value={network} onChange={(e) => pickNetwork(e.target.value as AccessNetwork)}>
                  <option value="lan">LAN</option>
                  <option value="tailscale">Tailscale</option>
                </select>
                <span className="mt-1 block text-xs text-zinc-500">
                  {network === 'tailscale'
                    ? "L'agent joint le hub (et le PBS) par Tailscale. Hôte créé non géré (aucune option de standardisation) et exclu de Home Assistant ; modifiable ensuite. Le réseau ne se change pas : il faut réinstaller l'agent."
                    : 'Adresse du hub telle que réglée dans Paramètres > Agent.'}
                </span>
              </label>
            )}
            <RoamingField checked={roaming} onChange={setRoaming} />
            <HaExcludedField checked={haExcluded} onChange={setHaExcluded} />
          </fieldset>
        </Step>
        <Step
          n={3}
          title="Système et installation"
          state={online === 'done' ? 'done' : generated === 'done' ? 'active' : 'todo'}
          intro="Choisis le système de l'hôte, puis lance le script dessus : l'hôte n'est conservé qu'une fois l'agent connecté."
        >
          {result && <InstallInstructions install={result.install} />}
          {connected && (
            <p className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">
              <CheckCircle2 className="h-4 w-4 shrink-0" /> Agent connecté : l'hôte est prêt.
            </p>
          )}
        </Step>
      </Steps>
    </Modal>
  );
}
