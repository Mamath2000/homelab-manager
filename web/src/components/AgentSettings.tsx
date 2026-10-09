import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { api } from '../lib/api';
import { useAgentTls } from '../lib/agentTls';
import { useToast } from '../lib/toast';
import { Button, CopyField } from './ui';

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
            Dès qu'un agent se connecte avec une version différente de celle du hub, il télécharge la nouvelle, vérifie son empreinte et sa signature, puis redémarre.
            Un nouvel essai a lieu au plus une fois par heure.
          </span>
        </span>
      </label>
      <p className="mt-3 text-xs text-muted">
        Agent distribué par ce hub : <span className="font-mono text-zinc-300">{version ?? 'inconnu'}</span>
        {data.binaries.length > 0 && <> ({data.binaries.map((b) => b.arch).join(', ')})</>}
        {data.binaries.length > 0 &&
          (data.binaries.every((b) => b.signed) ? (
            <span className="text-emerald-400"> · signé</span>
          ) : (
            <span className="text-amber-300"> · non signé (build de développement : les agents de release refuseront cette mise à jour)</span>
          ))}
      </p>
    </div>
  );
}

// Hub address and TLS port given to the agents, interval of the automatic apt-get update.
export function AgentHubSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['settings', 'agents'], queryFn: api.agentSettings });
  // local draft once edited, server values until then
  const [draft, setDraft] = useState<{ hubUrl: string; agentPort: string; checkIntervalHours: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const form = draft ?? { hubUrl: data.hubUrl, agentPort: String(data.agentPort), checkIntervalHours: String(data.checkIntervalHours) };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      qc.setQueryData(['settings', 'agents'], await api.saveAgentSettings({
        hubUrl: form.hubUrl,
        agentPort: Number(form.agentPort),
        checkIntervalHours: Number(form.checkIntervalHours),
      }));
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
        <span className="mb-1.5 block text-xs font-medium text-muted">URL du hub</span>
        <input
          className="input"
          value={form.hubUrl}
          onChange={(e) => setDraft({ ...form, hubUrl: e.target.value })}
          placeholder={window.location.origin}
        />
        <span className="mt-1 block text-xs text-zinc-500">
          Adresse de l'interface telle que les hôtes la joignent (liens Home Assistant) ; les agents utilisent son nom d'hôte avec le port TLS ci-dessous.
          Vide : l'adresse de ce navigateur.
        </span>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Port TLS des agents</span>
        <input
          className="input w-32"
          type="number"
          min={1}
          max={65535}
          required
          value={form.agentPort}
          onChange={(e) => setDraft({ ...form, agentPort: e.target.value })}
        />
        <span className="mt-1 block text-xs text-zinc-500">
          Port publié du hub pour les agents (3443 par défaut). Un agent déjà installé garde l'adresse de son installation : après un changement, relance la commande de mise à jour sur l'hôte.
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

// Pinned keys of the agent server, to check the install command by hand.
export function AgentTlsInfo() {
  const tls = useAgentTls();
  if (!tls) return null;
  return (
    <div className="rounded-md border border-line bg-raised/40 p-4">
      <p className="mb-2 flex items-center gap-2 font-medium text-zinc-100">
        <Lock className="h-4 w-4 text-emerald-400" /> Connexion des agents
      </p>
      <p className="mb-3 text-xs text-muted">
        Chiffrée en TLS, avec un certificat par agent émis par l'autorité interne du hub. La commande d'installation épingle la clé du serveur ; l'agent
        n'accepte ensuite que les certificats de cette autorité.
      </p>
      <dl className="space-y-2 text-xs">
        <div>
          <dt className="text-muted">Adresse des agents</dt>
          <dd className="font-mono text-zinc-200">{tls.agentUrl ?? <span className="text-red-400">URL du hub invalide</span>}</dd>
        </div>
        <div>
          <dt className="text-muted">Clé épinglée du serveur (SHA-256 de la clé publique, base64)</dt>
          <dd className="font-mono break-all text-zinc-200">{tls.serverPin}</dd>
        </div>
        <div>
          <dt className="text-muted">Empreinte de l'autorité de certification (SHA-256)</dt>
          <dd className="font-mono break-all text-zinc-200">{tls.caFingerprint.match(/../g)?.join(':').toUpperCase()}</dd>
        </div>
      </dl>
    </div>
  );
}

// Manual upgrade and uninstall commands, to run as root on a host.
export function AgentManualCommands() {
  const tls = useAgentTls();
  if (!tls) return null;
  return (
    <div className="space-y-4">
      {tls.upgradeCommand && (
        <div>
          <p className="mb-2 text-zinc-300">Mettre à jour un agent à la main, en root sur l'hôte (son certificat est conservé) :</p>
          <CopyField value={tls.upgradeCommand} multiline />
        </div>
      )}
      {tls.uninstallCommand && (
        <div>
          <p className="mb-2 text-zinc-300">Désinstaller l'agent :</p>
          <CopyField value={tls.uninstallCommand} multiline />
        </div>
      )}
    </div>
  );
}
