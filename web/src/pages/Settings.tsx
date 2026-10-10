import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Home, Lock, Server, Settings as SettingsIcon, Terminal, Wand2 } from 'lucide-react';
import { AgentAutoUpdate, AgentHubSettings, AgentManualCommands, AgentTlsInfo } from '../components/AgentSettings';
import { HomeAssistantPanel } from '../components/HomeAssistantPanel';
import { SetupSettings } from '../components/SetupSettings';
import { Button, Modal, PageHeader, Panel, Tabs } from '../components/ui';

const tabs = [
  { id: 'hub', label: 'Hub et agents', icon: Server },
  { id: 'setup', label: 'Standardisation', icon: Wand2 },
  { id: 'homeassistant', label: 'Home Assistant', icon: Home },
] as const;

type TabId = (typeof tabs)[number]['id'];

export function Settings() {
  // active tab kept in the URL (?tab=...) so it survives a reload and can be linked
  const [params, setParams] = useSearchParams();
  const tab: TabId = tabs.find((t) => t.id === params.get('tab'))?.id ?? 'hub';
  const [security, setSecurity] = useState(false);

  return (
    <>
      <PageHeader icon={SettingsIcon} title="Paramètres" />
      <Tabs
        tabs={[...tabs]}
        value={tab}
        onChange={(id) => setParams({ tab: id }, { replace: true })}
        actions={<Button size="sm" icon={Lock} onClick={() => setSecurity(true)}>Sécurité</Button>}
      />
      {tab === 'hub' && (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <Panel title="Hub" icon={Server}>
            <div className="text-sm">
              <AgentHubSettings />
            </div>
          </Panel>
          <Panel title="Agents" icon={Terminal}>
            <div className="space-y-4 text-sm">
              <AgentAutoUpdate />
              <AgentManualCommands />
              <p className="text-xs text-muted">
                Fichiers installés : <code>/usr/local/bin/homelab-agent</code>, <code>/etc/homelab-agent/</code> (configuration, certificat et clé privée de
                l'agent), service systemd <code>homelab-agent</code>.
              </p>
            </div>
          </Panel>
        </div>
      )}
      {tab === 'setup' && <SetupSettings />}
      {tab === 'homeassistant' && <HomeAssistantPanel />}
      <Modal open={security} onClose={() => setSecurity(false)} title="Sécurité" wide>
        <div className="text-sm">
          <AgentTlsInfo />
        </div>
      </Modal>
    </>
  );
}
