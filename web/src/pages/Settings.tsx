import { useState } from 'react';
import { KeyRound, Settings as SettingsIcon, Terminal } from 'lucide-react';
import { AgentAutoUpdate, AgentHubSettings } from '../components/AgentSettings';
import { useHubUrl } from '../lib/hubUrl';
import { HomeAssistantPanel } from '../components/HomeAssistantPanel';
import { useToast } from '../lib/toast';
import { Button, CopyField, PageHeader, Panel } from '../components/ui';
import { api } from '../lib/api';

export function Settings() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const origin = useHubUrl();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.changePassword(current, next);
      toast.success('Mot de passe modifié');
      setCurrent('');
      setNext('');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader icon={SettingsIcon} title="Paramètres" />
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Mot de passe" icon={KeyRound}>
          <form onSubmit={submit} className="max-w-sm space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Mot de passe actuel</span>
              <input className="input" type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Nouveau mot de passe (8 caractères min.)</span>
              <input className="input" type="password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            </label>
            <Button type="submit" variant="primary" loading={busy}>Enregistrer</Button>
          </form>
        </Panel>
        <Panel title="Agent" icon={Terminal}>
          <div className="space-y-4 text-sm">
            <AgentHubSettings />
            <AgentAutoUpdate />
            <div>
              <p className="mb-2 text-zinc-300">Mise à jour manuelle, nécessaire une fois pour les agents antérieurs à la mise à jour automatique (le token est conservé) :</p>
              <CopyField value={`curl -fsSL ${origin}/install.sh | sh`} />
            </div>
            <div>
              <p className="mb-2 text-zinc-300">Désinstaller l'agent :</p>
              <CopyField value={`curl -fsSL ${origin}/install.sh | sh -s -- --uninstall`} />
            </div>
            <p className="text-xs text-muted">
              Fichiers installés : <code>/usr/local/bin/homelab-agent</code>, <code>/etc/homelab-agent.env</code>, service systemd <code>homelab-agent</code>.
            </p>
          </div>
        </Panel>
        <HomeAssistantPanel />
      </div>
    </>
  );
}
