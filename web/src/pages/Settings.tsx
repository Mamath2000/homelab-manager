import { useCallback, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import clsx from 'clsx';
import { Activity, ChevronRight, MapPin, Radio, Server, Settings as SettingsIcon, Shield, Tags, Terminal, Wand2, type LucideIcon } from 'lucide-react';
import { AgentAutoUpdate, AgentHubSettings, AgentManualCommands, AgentTlsInfo } from '../components/AgentSettings';
import { SettingsDraftProvider, type SettingsDraft } from '../components/settingsDraft';
import { SitesSettings } from '../components/SitesSettings';
import { TagsSettings } from '../components/TagsSettings';
import { SetupSettings } from '../components/SetupSettings';
import { HealthSettings } from '../components/HealthSettings';
import { SecurityHealthPanel } from '../components/SecurityHealth';
import { HeaderTitle } from '../components/HeaderSlot';
import { Button, FlatPanels, Modal, Panel } from '../components/ui';
import { useMe } from '../lib/auth';
import { ROLE_PAGES } from '../lib/roleSettings';

type ModalWidth = true | 'xl' | 'screen';

// Paramètres: one tile per setting, always the same ones (Standardisation greyed when the hub has it off); a click opens
// the setting in a window centred on the page. The tile stays in the address (?tab=…) so that links open it.
const groups = [
  {
    title: 'Hub',
    items: [
      { id: 'hub', label: 'Hub', icon: Server, hint: 'Adresse du hub, port des agents, vérification des mises à jour', width: true },
      { id: 'sites', label: 'Sites', icon: MapPin, hint: 'Sites des hôtes, leur ordre et leur couleur', width: true },
      { id: 'tags', label: 'Tags', icon: Tags, hint: 'Étiquettes posées sur les hôtes', width: true },
      { id: 'agents', label: 'Agents', icon: Terminal, hint: 'Installation, mise à jour automatique et connexion des agents', width: 'xl' },
      { id: 'setup', label: 'Standardisation', icon: Wand2, hint: 'Configuration standard proposée aux hôtes', width: 'xl' },
    ],
  },
  {
    title: 'Surveillance',
    items: [
      { id: 'health', label: 'Santé', icon: Activity, hint: 'Collecte des mesures et seuils d’alerte', width: 'xl' },
      { id: 'security', label: 'Sécurité', icon: Shield, hint: 'Posture de sécurité de l’installation, vue par le hub', width: 'screen' },
    ],
  },
] as const satisfies readonly { title: string; items: readonly { id: string; label: string; icon: LucideIcon; hint: string; width: ModalWidth }[] }[];

type TabId = (typeof groups)[number]['items'][number]['id'];
const items = groups.flatMap((g) => g.items as readonly (typeof groups)[number]['items'][number][]);

const tileClass = 'group flex min-h-24 flex-col gap-1.5 rounded-lg border border-line bg-raised/40 px-4 py-3.5 text-left transition';

function Tile({ icon: Icon, label, hint, onClick, to, off }: { icon: LucideIcon; label: string; hint: string; onClick?: () => void; to?: string; off?: string }) {
  const body = (
    <>
      <span className="flex items-center gap-2 font-medium text-zinc-100">
        <Icon className={clsx('h-4 w-4 shrink-0', off ? 'text-zinc-500' : 'text-emerald-400')} aria-hidden />
        {label}
        {!off && <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-zinc-600 transition group-hover:text-emerald-300" aria-hidden />}
      </span>
      <span className="text-xs text-muted">{off ?? hint}</span>
    </>
  );
  if (off) return <div className={clsx(tileClass, 'cursor-not-allowed border-dashed opacity-60')} title={off}>{body}</div>;
  const active = 'hover:border-emerald-500/40 hover:bg-raised focus-visible:outline-2 focus-visible:outline-emerald-500';
  return to ? <Link to={to} className={clsx(tileClass, active)}>{body}</Link> : <button type="button" onClick={onClick} className={clsx(tileClass, active)}>{body}</button>;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2.5 flex items-center gap-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
        {title}
        <span className="h-px flex-1 bg-line" aria-hidden />
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{children}</div>
    </section>
  );
}

export function Settings() {
  const [params, setParams] = useSearchParams();
  const { features } = useMe();
  const offOf = (id: TabId) => (id === 'setup' && !features.standardisation ? 'Désactivée sur le hub (FEATURE_STANDARDISATION)' : undefined);
  // the roles and the settings of their types have their own screen now (Rôles): old links lead there
  const asked = params.get('tab');
  const moved = asked === 'roles' || asked === 'backups' ? '/roles' : ROLE_PAGES.some((p) => p.id === asked) ? `/roles/${asked}` : null;
  const open = items.find((item) => item.id === asked && !offOf(item.id)) ?? null;
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  // closing a window whose changes are not saved: asked first
  const [leaving, setLeaving] = useState(false);
  const [savingBeforeLeave, setSavingBeforeLeave] = useState(false);
  const register = useCallback((value: SettingsDraft | null) => setDraft(value), []);

  const show = useCallback((id: TabId | null) => {
    setLeaving(false);
    setParams(id ? { tab: id } : {}, { replace: true });
  }, [setParams]);
  const onDraftSaved = useCallback(() => {
    if (leaving) show(null);
  }, [show, leaving]);
  const close = () => (draft?.dirty ? setLeaving(true) : show(null));
  const saveThenLeave = async () => {
    if (!draft || await draft.save()) show(null);
  };
  const discardThenLeave = () => {
    draft?.discard();
    show(null);
  };

  if (moved) return <Navigate to={moved} replace />;

  const content: Record<TabId, React.ReactNode> = {
    sites: <SitesSettings />,
    tags: <TagsSettings />,
    hub: (
      <Panel title="Hub" icon={Server}>
        <AgentHubSettings />
      </Panel>
    ),
    agents: (
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
    ),
    setup: <SetupSettings />,
    security: <SecurityHealthPanel />,
    health: <HealthSettings />,
  };

  return (
    <>
      <HeaderTitle icon={SettingsIcon} title="Paramètres" />
      <p className="mb-5 text-sm text-muted">Choisis un réglage : il s’ouvre dans une fenêtre. Les rôles du hub et leurs intégrations ont leur propre écran.</p>
      {groups.map((g) => (
        <Group key={g.title} title={g.title}>
          {g.items.map((item) => (
            <Tile key={item.id} icon={item.icon} label={item.label} hint={item.hint} off={offOf(item.id)} onClick={() => show(item.id)} />
          ))}
        </Group>
      ))}
      <Group title="Voir aussi">
        <Tile icon={Radio} label="Rôles" hint="Brokers MQTT, Proxmox, PBS, Omada, logs, ESPHome et leurs réglages" to="/roles" />
      </Group>
      {open && (
        <Modal
          open
          onClose={close}
          wide={open.width}
          scroll
          title={<span className="flex items-center gap-2"><open.icon className="h-4 w-4 text-muted" aria-hidden />{open.label}</span>}
        >
          <FlatPanels>
            <SettingsDraftProvider key={open.id} register={register} onSaved={onDraftSaved}>
              {content[open.id]}
            </SettingsDraftProvider>
          </FlatPanels>
        </Modal>
      )}
      <Modal
        open={leaving}
        onClose={() => { if (!savingBeforeLeave) setLeaving(false); }}
        wide
        title="Modifications non enregistrées"
        footer={
          <>
            <Button className="whitespace-nowrap" variant="ghost" disabled={savingBeforeLeave} onClick={() => setLeaving(false)}>Rester ici</Button>
            <Button className="whitespace-nowrap" variant="danger" disabled={savingBeforeLeave} onClick={discardThenLeave}>Abandonner</Button>
            <Button className="whitespace-nowrap" variant="primary" loading={savingBeforeLeave} onClick={async () => {
              setSavingBeforeLeave(true);
              try {
                await saveThenLeave();
              } finally {
                setSavingBeforeLeave(false);
              }
            }}>
              Enregistrer et fermer
            </Button>
          </>
        }
      >
        <p className="text-sm text-zinc-300">
          Ce réglage contient des changements qui ne sont pas encore enregistrés. Que veux-tu faire avant de fermer ?
        </p>
      </Modal>
    </>
  );
}
