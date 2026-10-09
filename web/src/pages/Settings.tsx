import { useSearchParams } from 'react-router';
import { Home, Lock, Server, Settings as SettingsIcon, Terminal } from 'lucide-react';
import { AgentAutoUpdate, AgentHubSettings, AgentManualCommands, AgentTlsInfo } from '../components/AgentSettings';
import { HomeAssistantPanel } from '../components/HomeAssistantPanel';
import { PageHeader, Panel, Tabs } from '../components/ui';

const tabs = [
  { id: 'hub', label: 'Hub', icon: Server },
  { id: 'agents', label: 'Agents', icon: Terminal },
  { id: 'security', label: 'Sécurité', icon: Lock },
  { id: 'homeassistant', label: 'Home Assistant', icon: Home },
] as const;

type TabId = (typeof tabs)[number]['id'];

export function Settings() {
  // active tab kept in the URL (?tab=...) so it survives a reload and can be linked
  const [params, setParams] = useSearchParams();
  const tab: TabId = tabs.find((t) => t.id === params.get('tab'))?.id ?? 'hub';

  return (
    <>
      <PageHeader icon={SettingsIcon} title="Paramètres" />
      <Tabs tabs={[...tabs]} value={tab} onChange={(id) => setParams({ tab: id }, { replace: true })} />
      {tab === 'hub' && (
        <Panel title="Hub" icon={Server} className="max-w-3xl">
          <div className="text-sm">
            <AgentHubSettings />
          </div>
        </Panel>
      )}
      {tab === 'agents' && (
        <Panel title="Agents" icon={Terminal} className="max-w-3xl">
          <div className="space-y-4 text-sm">
            <AgentAutoUpdate />
            <AgentManualCommands />
            <p className="text-xs text-muted">
              Fichiers installés : <code>/usr/local/bin/homelab-agent</code>, <code>/etc/homelab-agent/</code> (configuration, certificat et clé privée de
              l'agent), service systemd <code>homelab-agent</code>.
            </p>
          </div>
        </Panel>
      )}
      {tab === 'security' && (
        <Panel title="Sécurité" icon={Lock} className="max-w-3xl">
          <div className="text-sm">
            <AgentTlsInfo />
          </div>
        </Panel>
      )}
      {tab === 'homeassistant' && <HomeAssistantPanel />}
    </>
  );
}
