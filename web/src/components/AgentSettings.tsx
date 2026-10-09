import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { Button } from './ui';

// Automatic agent updates + the agent version the hub distributes.
export function AgentAutoUpdate() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['settings', 'agents'], queryFn: api.agentSettings });
  if (!data) return null;
  const version = data.binaries.find((b) => b.version)?.version;

  const toggle = async (autoUpdate: boolean) => {
    try {
      qc.setQueryData(['settings', 'agents'], await api.saveAgentSettings({ autoUpdate }));
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

// URL given to the agents and interval of the automatic apt-get update.
export function AgentHubSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['settings', 'agents'], queryFn: api.agentSettings });
  // local draft once edited, server values until then
  const [draft, setDraft] = useState<{ hubUrl: string; checkIntervalHours: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const form = draft ?? { hubUrl: data.hubUrl, checkIntervalHours: String(data.checkIntervalHours) };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      qc.setQueryData(['settings', 'agents'], await api.saveAgentSettings({ hubUrl: form.hubUrl, checkIntervalHours: Number(form.checkIntervalHours) }));
      setDraft(null);
      toast.success('Paramètres des agents enregistrés');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">URL du hub (agents)</span>
        <input
          className="input"
          value={form.hubUrl}
          onChange={(e) => setDraft({ ...form, hubUrl: e.target.value })}
          placeholder={window.location.origin}
        />
        <span className="mt-1 block text-xs text-zinc-500">
          Adresse par laquelle les hôtes joignent le hub (commande d'installation, liens Home Assistant). Vide : l'adresse de ce navigateur.
        </span>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Vérification automatique des mises à jour (heures)</span>
        <input
          className="input w-32"
          type="number"
          min={0}
          max={720}
          required
          value={form.checkIntervalHours}
          onChange={(e) => setDraft({ ...form, checkIntervalHours: e.target.value })}
        />
        <span className="mt-1 block text-xs text-zinc-500">Fréquence de l'apt-get update lancé sur chaque hôte. 0 : désactivé.</span>
      </label>
      <Button type="submit" variant="primary" loading={busy} disabled={!draft}>Enregistrer</Button>
    </form>
  );
}
