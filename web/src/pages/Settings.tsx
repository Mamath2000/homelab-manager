import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Activity, Boxes, Cloud, Database, DatabaseBackup, ExternalLink, Files, Home, Info, MapPin, Network, Radio, Server, Settings as SettingsIcon, Shield, Tags, Terminal, Wand2 } from 'lucide-react';
import { AgentAutoUpdate, AgentHubSettings, AgentManualCommands, AgentTlsInfo } from '../components/AgentSettings';
import { HomeAssistantPanel } from '../components/HomeAssistantPanel';
import { RolesSettings } from '../components/HubRoles';
import { OmadaInventory } from '../components/OmadaInventory';
import { PveInventory } from '../components/PveInventory';
import { SettingsDraftProvider, type SettingsDraft } from '../components/settingsDraft';
import { SitesSettings } from '../components/SitesSettings';
import { TagsSettings } from '../components/TagsSettings';
import { SetupSettings } from '../components/SetupSettings';
import { HealthSettings } from '../components/HealthSettings';
import { HeaderTitle } from '../components/HeaderSlot';
import { Button, Modal, Panel, VerticalTabs } from '../components/ui';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { useRoles } from '../lib/queries';

const tabs = [
  { id: 'hub', label: 'Hub', icon: Server },
  { id: 'roles', label: 'Rôles', icon: Radio },
  { id: 'sites', label: 'Sites', icon: MapPin },
  { id: 'tags', label: 'Tags', icon: Tags },
  { id: 'agents', label: 'Agents', icon: Terminal },
  { id: 'setup', label: 'Standardisation', icon: Wand2 },
  { id: 'pve', label: 'Proxmox VE', icon: Boxes },
  { id: 'omada', label: 'Omada', icon: Network },
  { id: 'health', label: 'Santé', icon: Activity },
  { id: 'homeassistant', label: 'Home Assistant', icon: Home },
  { id: 'about', label: 'À propos', icon: Info, dividerBefore: true },
] as const;

type TabId = (typeof tabs)[number]['id'];

export function Settings() {
  const [params, setParams] = useSearchParams();
  const { features } = useMe();
  const { data: roles } = useRoles();
  // Standardisation: only with FEATURE_STANDARDISATION on the hub; Proxmox VE: opened by a pve-cluster role
  const hasPve = !!roles?.some((r) => r.type === 'pve-cluster');
  const hasOmada = !!roles?.some((r) => r.type === 'omada-controller');
  const shown = tabs.filter((item) => (item.id !== 'setup' || features.standardisation) && (item.id !== 'pve' || hasPve) && (item.id !== 'omada' || hasOmada));
  // the old tab of the backups: the two PBS are roles now
  const asked = params.get('tab') === 'backups' ? 'roles' : params.get('tab');
  const tab: TabId = shown.find((item) => item.id === asked)?.id ?? 'hub';
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [pendingTab, setPendingTab] = useState<TabId | null>(null);
  const [savingBeforeLeave, setSavingBeforeLeave] = useState(false);
  const register = useCallback((value: SettingsDraft | null) => setDraft(value), []);
  const { data: agentSettings } = useQuery({ queryKey: ['settings', 'agents'], queryFn: api.agentSettings });

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

  const content = {
    sites: <SitesSettings />,
    tags: <TagsSettings />,
    roles: <RolesSettings />,
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
    pve: <PveInventory />,
    omada: <OmadaInventory />,
    health: <HealthSettings />,
    homeassistant: <HomeAssistantPanel />,
    about: (
      <div className="space-y-4">
        <Panel title="Homelab Manager" icon={Info}>
          <div className="space-y-5 text-sm">
            <p className="max-w-3xl leading-relaxed text-zinc-300">
              Un outil simple, pensé pour les makers qui ont quelques machines à la maison et veulent les garder en bon état sans multiplier les interfaces.
              Depuis un hub léger et des agents sur les hôtes, Homelab Manager rassemble la supervision, les mises à jour APT, le suivi des images Docker et les sauvegardes.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <article className="rounded-md border border-line bg-raised/30 p-4">
                <h3 className="mb-1 flex items-center gap-2 font-medium text-zinc-100"><DatabaseBackup className="h-4 w-4 text-emerald-400" />Proxmox Backup Server</h3>
                <p className="text-xs leading-relaxed text-muted">
                  PBS centralise les sauvegardes et leurs snapshots. Sa déduplication par blocs évite de stocker plusieurs fois les données identiques entre sauvegardes,
                  ce qui réduit l’espace utilisé et les transferts. Homelab Manager s’appuie sur PBS pour suivre les sauvegardes de fichiers et de bases.
                </p>
              </article>
              <article className="rounded-md border border-line bg-raised/30 p-4">
                <h3 className="mb-1 flex items-center gap-2 font-medium text-zinc-100"><Server className="h-4 w-4 text-sky-400" />Proxmox VE</h3>
                <p className="text-xs leading-relaxed text-muted">
                  Suivi des sauvegardes planifiées de machines virtuelles et de conteneurs LXC, avec rattachement automatique à l’hôte correspondant lorsqu’il est identifié.
                </p>
              </article>
              <article className="rounded-md border border-line bg-raised/30 p-4">
                <h3 className="mb-1 flex items-center gap-2 font-medium text-zinc-100"><Database className="h-4 w-4 text-cyan-400" />PostgreSQL</h3>
                <p className="text-xs leading-relaxed text-muted">
                  L’agent sauvegarde les bases choisies, ou le cluster PostgreSQL complet, puis envoie les dumps au PBS. Leur format non compressé permet au PBS de dédupliquer efficacement les données d’une sauvegarde à l’autre.
                </p>
              </article>
              <article className="rounded-md border border-line bg-raised/30 p-4">
                <h3 className="mb-1 flex items-center gap-2 font-medium text-zinc-100"><Files className="h-4 w-4 text-green-400" />MongoDB</h3>
                <p className="text-xs leading-relaxed text-muted">
                  L’agent lance `mongodump` dans le conteneur MongoDB pour les bases choisies, puis envoie les archives au PBS, qui en déduplique les blocs communs entre snapshots.
                </p>
              </article>
              <article className="rounded-md border border-line bg-raised/30 p-4">
                <h3 className="mb-1 flex items-center gap-2 font-medium text-zinc-100"><Home className="h-4 w-4 text-amber-400" />Home Assistant OS</h3>
                <p className="text-xs leading-relaxed text-muted">
                  Publication dans Home Assistant des composants système des hôtes (système, noyau, adresse IP et présence), avec leurs alertes et informations APT/Docker.
                  L’intégration suit aussi les sauvegardes natives de Home Assistant OS, leurs destinations, leur planification et leurs éventuels échecs.
                </p>
              </article>
              <article className="rounded-md border border-line bg-raised/30 p-4">
                <h3 className="mb-1 flex items-center gap-2 font-medium text-zinc-100"><Cloud className="h-4 w-4 text-violet-400" />Plugin Nextcloud AIO</h3>
                <p className="text-xs leading-relaxed text-muted">
                  Un plugin dédié permet de sauvegarder une instance Nextcloud All-in-One, notamment sa base de données, sa configuration et les données de ses utilisateurs.
                </p>
              </article>
            </div>
          </div>
        </Panel>
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Versions" icon={Info}>
            <dl className="space-y-4 text-sm">
              <div className="rounded-md border border-line bg-raised/30 p-3">
                <dt className="text-xs text-muted">Hub</dt>
                <dd className="mt-1 font-mono text-zinc-100">v{__APP_VERSION__}</dd>
              </div>
              <div className="rounded-md border border-line bg-raised/30 p-3">
                <dt className="text-xs text-muted">Version de l’agent distribuée</dt>
                <dd className="mt-1 font-mono text-zinc-100">
                  {agentSettings?.binaries.find((binary) => binary.version)?.version ?? 'inconnue'}
                </dd>
              </div>
            </dl>
          </Panel>
          <Panel title="Dépôt et créateur" icon={ExternalLink}>
            <div className="flex h-full flex-col justify-center gap-5 sm:flex-row sm:items-center">
              <a
                href="https://github.com/Mamath2000"
                target="_blank"
                rel="noreferrer"
                className="flex shrink-0 flex-col items-center gap-2 text-zinc-300 transition hover:text-emerald-300"
              >
                <img
                  className="h-20 w-20 rounded-full border-2 border-line object-cover shadow-lg shadow-black/20"
                  src="https://avatars.githubusercontent.com/u/15641879?v=4"
                  alt="Photo de profil de Mamath"
                  loading="lazy"
                />
                <span className="text-sm font-medium">Mamath</span>
              </a>
              <div className="flex flex-col items-center gap-3 text-sm sm:items-start">
                <a className="inline-flex items-center gap-2 text-zinc-300 hover:text-emerald-300" href="https://github.com/Mamath2000/homelab-manager" target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" /> Dépôt homelab-manager
                </a>
                <a className="text-xs text-muted hover:text-emerald-300" href="https://github.com/Mamath2000" target="_blank" rel="noreferrer">
                  Voir le profil GitHub
                </a>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    ),
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
