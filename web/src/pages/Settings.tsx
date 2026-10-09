import { Settings as SettingsIcon, Terminal } from 'lucide-react';
import { AgentAutoUpdate, AgentHubSettings } from '../components/AgentSettings';
import { useHubUrl } from '../lib/hubUrl';
import { HomeAssistantPanel } from '../components/HomeAssistantPanel';
import { CopyField, PageHeader, Panel } from '../components/ui';

export function Settings() {
  const origin = useHubUrl();

  return (
    <>
      <PageHeader icon={SettingsIcon} title="Paramètres" />
      <div className="grid gap-5 xl:grid-cols-2">
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
