import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type AccessNetwork, type InstallInfo } from '../lib/api';
import { useUpdateHostCache } from '../lib/queries';
import { InstallInstructions } from './InstallInstructions';
import { HaExcludedField } from './HaExcludedField';
import { RoamingField } from './RoamingField';
import { Button, Modal } from './ui';

export function AddHostModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [roaming, setRoaming] = useState(false);
  const [haExcluded, setHaExcluded] = useState(false);
  const [network, setNetwork] = useState<AccessNetwork>('lan');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InstallInfo | null>(null);
  const upsert = useUpdateHostCache();
  // the Tailscale network is offered once the hub address on the tailnet is set
  const { data: agents } = useQuery({ queryKey: ['settings', 'agents'], queryFn: api.agentSettings, enabled: open });
  const tailscale = !!agents?.tailscaleHub;

  // Tailscale hosts start outside Home Assistant (and unmanaged, on the hub side); both stay editable
  const pickNetwork = (n: AccessNetwork) => {
    setNetwork(n);
    setHaExcluded(n === 'tailscale');
  };

  const close = () => {
    setName('');
    setGroup('');
    setRoaming(false);
    setHaExcluded(false);
    setNetwork('lan');
    setError('');
    setResult(null);
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.createHost(name, group, roaming, haExcluded, network);
      upsert(r.host);
      setResult(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title={result ? `Installer l'agent sur ${name}` : 'Ajouter un hôte'} wide={!!result}>
      {result ? (
        <div className="space-y-4">
          <InstallInstructions install={result} />
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>Terminé</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Nom</span>
            <input className="input" autoFocus required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} placeholder="pihole, docker-01, pve…" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Groupe (optionnel)</span>
            <input className="input" maxLength={64} value={group} onChange={(e) => setGroup(e.target.value)} placeholder="infra, media, domotique…" />
          </label>
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
                  : "Adresse du hub telle que réglée dans Paramètres > Agent."}
              </span>
            </label>
          )}
          <RoamingField checked={roaming} onChange={setRoaming} />
          <HaExcludedField checked={haExcluded} onChange={setHaExcluded} />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>Annuler</Button>
            <Button type="submit" variant="primary" loading={busy}>Créer</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
