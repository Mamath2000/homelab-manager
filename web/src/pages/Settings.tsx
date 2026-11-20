import { useCallback, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { Activity, MapPin, Server, Settings as SettingsIcon, Shield, Tags, Terminal, Wand2 } from 'lucide-react';
import { AgentAutoUpdate, AgentHubSettings, AgentManualCommands, AgentTlsInfo } from '../components/AgentSettings';
import { SettingsDraftProvider, type SettingsDraft } from '../components/settingsDraft';
import { SitesSettings } from '../components/SitesSettings';
import { TagsSettings } from '../components/TagsSettings';
import { SetupSettings } from '../components/SetupSettings';
import { HealthSettings } from '../components/HealthSettings';
import { SecurityHealthPanel } from '../components/SecurityHealth';
import { HeaderTitle } from '../components/HeaderSlot';
import { Button, Modal, Panel, VerticalTabs } from '../components/ui';
import { useMe } from '../lib/auth';
import { ROLE_PAGES } from '../lib/roleSettings';

const tabs = [
  { id: 'hub', label: 'Hub', icon: Server },
  { id: 'sites', label: 'Sites', icon: MapPin },
  { id: 'tags', label: 'Tags', icon: Tags },
  { id: 'agents', label: 'Agents', icon: Terminal },
  { id: 'setup', label: 'Standardisation', icon: Wand2 },
  { id: 'health', label: 'Santé', icon: Activity },
  { id: 'security', label: 'Sécurité', icon: Shield },
] as const;

type TabId = (typeof tabs)[number]['id'];

export function Settings() {
  const [params, setParams] = useSearchParams();
  const { features } = useMe();
  const shown = tabs.filter((item) => item.id !== 'setup' || features.standardisation);
  // the roles and the settings of their types have their own screen now (Rôles): old links lead there
  const asked = params.get('tab');
  const moved = asked === 'roles' || asked === 'backups' ? '/roles' : ROLE_PAGES.some((p) => p.id === asked) ? `/roles/${asked}` : null;
  const tab: TabId = shown.find((item) => item.id === asked)?.id ?? 'hub';
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [pendingTab, setPendingTab] = useState<TabId | null>(null);
  const [savingBeforeLeave, setSavingBeforeLeave] = useState(false);
  const register = useCallback((value: SettingsDraft | null) => setDraft(value), []);

  const navigateTo = useCallback((next: TabId) => {
    setPendingTab(null);
    setParams(next === 'hub' ? {} : { tab: next }, { replace: true });
  }, [setParams]);
  const onDraftSaved = useCallback(() => {
    if (pendingTab) navigateTo(pendingTab);
  }, [navigateTo, pendingTab]);
  const selectTab = (next: TabId) => {
    if (next === tab) return;
    if (draft?.dirty) setPendingTab(next);
    else navigateTo(next);
  };
  const saveThenLeave = async () => {
    if (!draft || await draft.save()) navigateTo(pendingTab!);
  };
  const discardThenLeave = () => {
    draft?.discard();
    if (pendingTab) navigateTo(pendingTab);
  };

  if (moved) return <Navigate to={moved} replace />;

  const content = {
    sites: <SitesSettings />,
    tags: <TagsSettings />,
    hub: (
      <Panel title="Hub" icon={Server}>
        <AgentHubSettings />
      </Panel>
    ),
    agents: (
      <div className="space-y-4">
        <Panel title="Agents" icon={Terminal}>
          <div className="space-y-4 text-sm">
            <AgentAutoUpdate>
              {(actions) => (
                <>
                  <div className="grid items-start gap-4 lg:grid-cols-2">
                    <div className="space-y-4">
                      <AgentManualCommands />
                      <p className="text-xs text-muted">
                        Fichiers installés : <code>/usr/local/bin/homelab-agent</code>, <code>/etc/homelab-agent/</code> (configuration, certificat et clé privée de
                        l'agent), service systemd <code>homelab-agent</code>.
                      </p>
                    </div>
                    <Panel title="Sécurité et connexion des agents" icon={Shield}>
                      <AgentTlsInfo />
                    </Panel>
                  </div>
                  {actions}
                </>
              )}
            </AgentAutoUpdate>
          </div>
        </Panel>
      </div>
    ),
    setup: <SetupSettings />,
    security: <SecurityHealthPanel />,
    health: <HealthSettings />,
  } satisfies Record<TabId, React.ReactNode>;

  return (
    <>
      <HeaderTitle icon={SettingsIcon} title="Paramètres" />
      <p className="mb-5 text-sm text-muted">Modifie une rubrique puis enregistre ses changements en bas du formulaire.</p>
      <div className="panel">
        <VerticalTabs
          tabs={shown}
          value={tab}
          onChange={selectTab}
          bodyClassName="min-w-0 flex-1 p-4 md:p-6"
        >
          <SettingsDraftProvider key={tab} register={register} onSaved={onDraftSaved}>
            {content[tab]}
          </SettingsDraftProvider>
        </VerticalTabs>
      </div>
      <Modal
        open={pendingTab !== null}
        onClose={() => { if (!savingBeforeLeave) setPendingTab(null); }}
        wide
        title="Modifications non enregistrées"
        footer={
          <>
            <Button className="whitespace-nowrap" variant="ghost" disabled={savingBeforeLeave} onClick={() => setPendingTab(null)}>Rester ici</Button>
            <Button className="whitespace-nowrap" variant="danger" disabled={savingBeforeLeave} onClick={discardThenLeave}>Abandonner</Button>
            <Button className="whitespace-nowrap" variant="primary" loading={savingBeforeLeave} onClick={async () => {
              setSavingBeforeLeave(true);
              try {
                await saveThenLeave();
              } finally {
                setSavingBeforeLeave(false);
              }
            }}>
              Enregistrer et continuer
            </Button>
          </>
        }
      >
        <p className="text-sm text-zinc-300">
          Cette rubrique contient des changements qui ne sont pas encore enregistrés. Que veux-tu faire avant de continuer ?
        </p>
      </Modal>
    </>
  );
}
