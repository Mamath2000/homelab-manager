import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';

// Automatic agent updates + the agent version the hub distributes.
export function AgentAutoUpdate() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['settings', 'agents'], queryFn: api.agentSettings });
  if (!data) return null;
  const version = data.binaries.find((b) => b.version)?.version;

  const toggle = async (autoUpdate: boolean) => {
    try {
      qc.setQueryData(['settings', 'agents'], await api.saveAgentSettings(autoUpdate));
      toast.success(autoUpdate ? 'Mise à jour automatique des agents activée' : 'Mise à jour automatique des agents désactivée');
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="rounded-md border border-line bg-raised/40 p-4">
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" checked={data.autoUpdate} onChange={(e) => toggle(e.target.checked)} className="mt-0.5 h-4 w-4 accent-emerald-500" />
        <span>
          <span className="block font-medium text-zinc-100">Mettre à jour les agents automatiquement</span>
          <span className="mt-1 block text-xs text-muted">
            Dès qu'un agent se connecte avec une version différente de celle du hub, il télécharge la nouvelle, vérifie son empreinte et redémarre.
            Un nouvel essai a lieu au plus une fois par heure.
          </span>
        </span>
      </label>
      <p className="mt-3 text-xs text-muted">
        Agent distribué par ce hub : <span className="font-mono text-zinc-300">{version ?? 'inconnu'}</span>
        {data.binaries.length > 0 && <> ({data.binaries.map((b) => b.arch).join(', ')})</>}
      </p>
    </div>
  );
}
