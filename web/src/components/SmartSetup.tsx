import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Host } from '../lib/api';
import { formatBytes } from '../lib/backups';
import { useToast } from '../lib/toast';
import { Badge, Button, Checkbox } from './ui';

// SMART options of a host, in the health detail dialog: disks to read (detected by the agent or typed) and, without
// smartmontools, how to install it.
export function SmartSetup({ host, canManage }: { host: Host; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [devices, setDevices] = useState(host.smartDevices.join(', '));
  const selected = useMemo(() => new Set(devices.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean)), [devices]);
  const save = useMutation({
    mutationFn: () => api.saveHostSmartDevices(host.id, [...selected]),
    onSuccess: async ({ devices: saved }) => {
      await qc.invalidateQueries({ queryKey: ['hosts'] });
      setDevices(saved.join(', '));
      toast.success('Disques SMART configurés');
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const scan = useMutation({
    mutationFn: () => api.hostSmartCandidates(host.id),
    onError: (err: Error) => toast.error(err.message),
  });
  const toggle = (device: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(device); else next.delete(device);
    setDevices([...next].join(', '));
  };

  if (!host.capabilities.includes('smart')) {
    return (
      <div className="mb-3 rounded-md border border-line bg-raised/20 p-3">
        <p className="mb-2 text-xs text-muted">L'agent ne trouve pas <span className="font-mono">smartctl</span> : installer smartmontools sur l'hôte (en administrateur), puis attendre la prochaine connexion de l'agent ou actualiser l'hôte.</p>
        <pre className="overflow-x-auto rounded-md border border-line bg-black/30 px-3 py-2 font-mono text-xs text-zinc-200">{host.osFamily === 'windows'
          ? "winget install smartmontools\n# ou l'installeur officiel : https://www.smartmontools.org/wiki/Download"
          : 'apt install smartmontools'}</pre>
      </div>
    );
  }
  if (!canManage) return null;
  return (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        <input className="input min-w-48 flex-1" aria-label="Disques physiques SMART" placeholder="/dev/sda, /dev/nvme0" value={devices} onChange={(event) => setDevices(event.target.value)} />
        <Button size="sm" variant="ghost" loading={scan.isPending} disabled={!host.online} onClick={() => scan.mutate()}>Détecter les disques</Button>
        <Button size="sm" loading={save.isPending} disabled={!host.online} onClick={() => save.mutate()}>Enregistrer</Button>
      </div>
      {scan.data && (!scan.data.candidates.length ? <p className="text-xs text-muted">Aucun disque détecté par smartctl.</p> : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {scan.data.candidates.map((c) => (
            <li key={c.device} className="flex items-center gap-3 px-3 py-1.5 text-xs">
              <Checkbox label={c.device} checked={selected.has(c.device)} onChange={(on) => toggle(c.device, on)} />
              <span className="font-mono text-zinc-100">{c.device}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{c.model ?? 'modèle inconnu'}</span>
              {c.protocol && <Badge>{c.protocol}</Badge>}
              {!!c.sizeBytes && <span className="text-muted">{formatBytes(c.sizeBytes)}</span>}
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}
