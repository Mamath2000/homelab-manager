import { Settings as SettingsIcon, Terminal } from 'lucide-react';
import { AgentAutoUpdate, AgentHubSettings, AgentTlsInfo } from '../components/AgentSettings';
import { HomeAssistantPanel } from '../components/HomeAssistantPanel';
import { PageHeader, Panel } from '../components/ui';

export function Settings() {
  return (
    <>
      <PageHeader icon={SettingsIcon} title="Paramètres" />
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Agent" icon={Terminal}>
          <div className="space-y-4 text-sm">
            <AgentHubSettings />
            <AgentAutoUpdate />
            <AgentTlsInfo />
            <p className="text-xs text-muted">
              Fichiers installés : <code>/usr/local/bin/homelab-agent</code>, <code>/etc/homelab-agent/</code> (configuration, certificat et clé privée de
              l'agent), service systemd <code>homelab-agent</code>.
            </p>
          </div>
        </Panel>
        <HomeAssistantPanel />
      </div>
    </>
  );
}
