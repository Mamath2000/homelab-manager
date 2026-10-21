import { useState } from 'react';
import clsx from 'clsx';
import { Archive, Cpu, KeyRound, Network, Power, Save, Server, ShieldAlert, ShieldOff, Tag, Trash2, type LucideIcon } from 'lucide-react';
import { api, type Host, type InstallInfo } from '../lib/api';
import { useUpdateHostCache } from '../lib/queries';
import { agentRevoked, hasApt, isWindows, needsReinstall, osLabel } from '../lib/status';
import { backupClient } from '../lib/backups';
import { BackupAgentSection } from './ManagedBackups';
import { useToast } from '../lib/toast';
import { HaExcludedField } from './HaExcludedField';
import { SiteSelect, TagPicker } from './HostTags';
import { InstallInstructions } from './InstallInstructions';
import { RoamingField } from './RoamingField';
import { Badge, Button, Checkbox, Modal } from './ui';

// Actions of the « Danger » zone, owned by the caller (its confirmations); no zone without them (host list).
export interface HostDangerActions {
  onReboot?: () => void;
  // admins only
  onShutdown?: () => void;
  rebootDisabled: boolean;
  onRevoke: () => void;
  onDelete: () => void;
}

type SectionId = 'settings' | 'host' | 'agent' | 'backup' | 'danger';

// Identity and behavior are saved together; agent, backup and danger actions apply immediately.
const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: 'settings', label: 'Identité et comportement', icon: Tag },
  { id: 'host', label: 'Éléments de l’hôte', icon: Server },
  { id: 'agent', label: 'Agent', icon: Cpu },
  // agents able to back up (the HAOS add-on is not): client, PBS token; Windows: path of the CLI
  { id: 'backup', label: 'Sauvegardes', icon: Archive },
  { id: 'danger', label: 'Danger', icon: ShieldAlert },
];

const authLabel = (host: Host) =>
  host.agentAuth === 'cert' ? 'Certificat' : host.agentAuth === 'legacy' ? 'Ancien jeton' : agentRevoked(host) ? 'Révoqué' : 'Jamais enrôlé';

function Capability({ label, enabled, detail }: { label: string; enabled: boolean; detail: string }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 rounded-md border border-line bg-black/15 px-3.5 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-200">{label}</p>
        <p className="mt-0.5 text-xs text-muted">{detail}</p>
      </div>
      <Badge tone={enabled ? 'ok' : 'neutral'}>{enabled ? 'Oui' : 'Non'}</Badge>
    </div>
  );
}

// Windows: path of the backup CLI (Nimbus Backup, installed by hand). The agent checks it once saved and reports it
// in its capabilities (backup:cli): only then does the host page show its backups.
function BackupClientSection({ host }: { host: Host }) {
  const upsert = useUpdateHostCache();
  const toast = useToast();
  const [path, setPath] = useState(host.backupClientPath ?? '');
  const [busy, setBusy] = useState(false);
  const saved = host.backupClientPath;
  const found = host.capabilities.includes('backup:cli');
  const save = async () => {
    setBusy(true);
    try {
      upsert(await api.setBackupClientPath(host.id, path.trim()));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const [tone, state] = !host.capabilities.includes('backup_setup')
    ? (['warn', 'agent à mettre à jour'] as const)
    : !saved
      ? (['neutral', 'non renseigné'] as const)
      : found
        ? (['ok', 'trouvé par l’agent'] as const)
        : host.online
          ? (['warn', 'introuvable à ce chemin'] as const)
          : (['neutral', 'à vérifier : hôte hors ligne'] as const);
  return (
    <div className="space-y-4">
      <div className="border-t border-line pt-4">
        <h4 className="text-sm font-semibold text-zinc-100">Client de sauvegarde</h4>
        <p className="mt-1 text-xs text-muted">
          CLI{' '}
          <a className="text-emerald-400 hover:underline" href="https://github.com/rdemsystems/NimbusBackupClient/releases" target="_blank" rel="noreferrer">Nimbus Backup</a>{' '}
          v0.4.2 ou plus récente, installée à la main (zip <code>nimbus-backup-cli-…-windows.zip</code>). L’agent vérifie l’exécutable ; les sauvegardes de l’hôte
          apparaissent une fois le client trouvé.
        </p>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Chemin de proxmoxbackup-directory.exe</span>
        <div className="flex gap-2">
          <input className="input flex-1 font-mono text-xs" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Program Files\NimbusCLI\proxmoxbackup-directory.exe" />
          <Button icon={Save} loading={busy} disabled={path.trim() === (saved ?? '')} onClick={save}>Enregistrer</Button>
        </div>
      </label>
      <dl className="flex justify-between gap-3 border-t border-line pt-4 text-sm">
        <dt className="text-muted">État</dt>
        <dd><Badge tone={tone}>{state}</Badge></dd>
      </dl>
    </div>
  );
}

// mounted only while open: its state starts from the current host
export function HostOptionsModal({ host, onClose, danger }: { host: Host; onClose: () => void; danger?: HostDangerActions }) {
  const [name, setName] = useState(host.name);
  const [siteId, setSiteId] = useState(host.siteId ?? '');
  const [tags, setTags] = useState(host.tags);
  const [roaming, setRoaming] = useState(host.roaming);
  const [critical, setCritical] = useState(host.critical);
  const [haExcluded, setHaExcluded] = useState(host.haExcluded);
  const [busy, setBusy] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [install, setInstall] = useState<InstallInfo | null>(null);
  const [section, setSection] = useState<SectionId>('settings');
  const upsert = useUpdateHostCache();
  const toast = useToast();

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      upsert(await api.updateHost(host.id, { name, siteId, tags, roaming, critical, haExcluded }));
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // new single-use code; the current agent keeps working until the new installation enrolls.
  // The command is shown once: it replaces the options instead of stacking on them.
  const newInstall = async () => {
    setEnrolling(true);
    try {
      setInstall(await api.enrollHost(host.id));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setEnrolling(false);
    }
  };

  const sections = SECTIONS.filter((x) => (x.id !== 'danger' || danger) && (x.id !== 'backup' || isWindows(host) || backupClient(host.capabilities).supported));
  const isForm = section === 'settings';

  if (install) {
    return (
      <Modal open onClose={onClose} title={`Installer l'agent sur ${host.name}`} wide>
        <InstallInstructions install={install} />
      </Modal>
    );
  }

  return (
    <Modal
      open
      scroll
      wide="xl"
      onClose={onClose}
      title={
        <>
          Options de {host.name}
          <span className="block text-xs font-normal text-muted">{[osLabel(host), host.agentVersion && `agent ${host.agentVersion}`].filter(Boolean).join(' · ')}</span>
        </>
      }
      footer={
        isForm ? (
          <>
            <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
            <Button type="submit" form="host-options-form" variant="primary" loading={busy}>Enregistrer</Button>
          </>
        ) : (
          <Button type="button" variant="ghost" onClick={onClose}>Fermer</Button>
        )
      }
    >
      <div className="flex min-h-[26rem] min-w-0 flex-col gap-4 sm:flex-row sm:gap-7">
        <nav aria-label="Sections" className="flex min-w-0 shrink-0 gap-1 overflow-x-auto sm:w-52 sm:flex-col sm:overflow-visible">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id}
              onClick={() => setSection(id)}
              className={clsx(
                'flex items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-2 text-left text-sm transition',
                section === id ? 'bg-raised text-zinc-100' : 'text-muted hover:bg-raised/60 hover:text-zinc-200',
                id === 'danger' && (section === id ? 'text-red-300' : 'hover:text-red-300'),
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          {/* One form keeps all editable options together. */}
          <form id="host-options-form" onSubmit={save} className={clsx(!isForm && 'hidden')}>
            <div className="space-y-5">
              <section className="grid gap-5 md:grid-cols-2">
                <div className="space-y-4 rounded-lg border border-line bg-black/10 p-4">
                  <div>
                    <h4 className="text-sm font-semibold text-zinc-100">Identité</h4>
                    <p className="mt-1 text-xs text-muted">Nom et site de rattachement.</p>
                  </div>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-muted">Nom</span>
                    <input className="input" required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
                  </label>
                  <SiteSelect value={siteId} onChange={setSiteId} />
                </div>
                <div className="min-w-0 rounded-lg border border-line bg-black/10 p-4">
                  <TagPicker value={tags} onChange={setTags} />
                </div>
              </section>
              <section className="space-y-4 border-t border-line pt-5">
                <div>
                  <h4 className="text-sm font-semibold text-zinc-100">Comportement</h4>
                  <p className="mt-1 text-xs text-muted">Présence de l’hôte et intégration avec Home Assistant.</p>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <RoamingField checked={roaming} onChange={setRoaming} />
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <span className="mt-0.5"><Checkbox checked={critical} onChange={setCritical} /></span>
                    <span>
                      <span className="block text-sm text-zinc-200">Hôte critique</span>
                      <span className="block text-xs text-muted">Hors ligne, il déclenche une alerte rouge, sauf s’il est aussi itinérant.</span>
                    </span>
                  </label>
                  <HaExcludedField checked={haExcluded} onChange={setHaExcluded} />
                </div>
              </section>
            </div>
          </form>

          {section === 'agent' && (
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-semibold text-zinc-100">État de l’agent</h4>
                <p className="mt-1 text-xs text-muted">Informations de connexion et de version remontées par l’hôte.</p>
              </div>
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Version</dt>
                  <dd className="text-zinc-200">
                    {host.agentVersion ?? '—'}{' '}
                    {host.agentVersion && (host.agentOutdated ? <Badge tone="warn">à mettre à jour</Badge> : <Badge tone="ok">à jour</Badge>)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Authentification</dt>
                  <dd className={needsReinstall(host) || agentRevoked(host) ? 'text-red-300' : 'text-zinc-200'}>{authLabel(host)}</dd>
                </div>
              </dl>
              <div className="border-t border-line pt-4">
                <p className="mb-2 text-xs text-muted">Génère une nouvelle commande d’installation. L’agent actuel reste actif jusqu’au nouvel enrôlement.</p>
                <Button icon={KeyRound} loading={enrolling} onClick={newInstall}>Nouvelle commande d’installation</Button>
              </div>
            </div>
          )}

          {section === 'backup' && <BackupAgentSection host={host} windowsClient={<BackupClientSection host={host} />} />}

          {section === 'host' && (
            <div className="space-y-5">
              <div>
                <h4 className="text-sm font-semibold text-zinc-100">Éléments détectés</h4>
                <p className="mt-1 text-xs text-muted">Capacités et services signalés par l’agent lors de son dernier rapport.</p>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2">
                <Capability label="Mises à jour APT" enabled={hasApt(host)} detail="Gestion des paquets système" />
                <Capability label="Docker" enabled={!!host.docker} detail={host.docker ? `${host.docker.engine} · Compose ${host.docker.compose}` : 'Aucun moteur Docker détecté'} />
                <Capability label="Redémarrage" enabled={host.capabilities.includes('reboot')} detail="Redémarrage à distance de l’hôte" />
                <Capability label="Extinction" enabled={host.capabilities.includes('shutdown')} detail="Extinction à distance de l’hôte" />
                {isWindows(host) && <Capability label="Verrouillage" enabled={host.capabilities.includes('lock')} detail="Verrouillage d’une session utilisateur" />}
                <Capability label="Mise à jour de l’agent" enabled={host.capabilities.includes('agent_update')} detail="L’agent peut se mettre à jour lui-même" />
                <Capability label="Standardisation" enabled={host.capabilities.includes('setup')} detail="Application de la configuration standard" />
                <Capability label="Sauvegardes Home Assistant" enabled={host.capabilities.includes('ha_backups')} detail="Remontée des sauvegardes Home Assistant" />
              </div>
              {host.info && (
                <dl className="grid gap-x-6 gap-y-2 border-t border-line pt-4 text-sm sm:grid-cols-2">
                  <div className="flex justify-between gap-3"><dt className="text-muted">Système</dt><dd className="text-right text-zinc-200">{osLabel(host) ?? '—'}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted">Architecture</dt><dd className="font-mono text-xs text-zinc-200">{host.info.arch}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted">Virtualisation</dt><dd className="text-zinc-200">{host.info.virt}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted">Réseau agent</dt><dd className="inline-flex items-center gap-1.5 text-zinc-200"><Network className="h-3.5 w-3.5 text-muted" />{host.accessNetwork === 'tailscale' ? 'Tailscale' : 'Réseau local'}</dd></div>
                </dl>
              )}
            </div>
          )}

          {section === 'danger' && danger && (
            <section className="overflow-hidden rounded-lg border border-red-500/40 bg-red-500/[0.025]">
              <header className="border-b border-red-500/30 px-4 py-3.5">
                <h4 className="flex items-center gap-2 text-sm font-semibold text-red-200">
                  <ShieldAlert className="h-4 w-4" />
                  Zone de danger
                </h4>
                <p className="mt-1 text-xs text-zinc-400">Ces opérations peuvent interrompre le service ou supprimer des données. Chacune demande une confirmation.</p>
              </header>
              <div className="divide-y divide-red-500/15">
                {danger.onReboot && (
                  <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-3">
                      <Power className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                      <div>
                        <p className="text-sm font-medium text-zinc-100">Redémarrer cet hôte</p>
                        <p className="mt-0.5 text-xs text-muted">Interrompt temporairement les services de cet hôte.</p>
                        {danger.rebootDisabled && <p className="mt-1 text-xs text-amber-300">Disponible lorsque l’hôte est en ligne et sans tâche en cours.</p>}
                      </div>
                    </div>
                    <Button variant="danger" icon={Power} disabled={danger.rebootDisabled} onClick={danger.onReboot}>Redémarrer</Button>
                  </div>
                )}
                {danger.onShutdown && (
                  <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-3">
                      <Power className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                      <div>
                        <p className="text-sm font-medium text-zinc-100">Éteindre cet hôte</p>
                        <p className="mt-0.5 text-xs text-muted">L’hôte ne repart pas seul : il faut le rallumer sur place ou par Wake-on-LAN.</p>
                        {danger.rebootDisabled && <p className="mt-1 text-xs text-amber-300">Disponible lorsque l’hôte est en ligne et sans tâche en cours.</p>}
                      </div>
                    </div>
                    <Button variant="danger" icon={Power} disabled={danger.rebootDisabled} onClick={danger.onShutdown}>Éteindre</Button>
                  </div>
                )}
                {host.agentAuth !== 'none' && (
                  <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-3">
                      <ShieldOff className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                      <div>
                        <p className="text-sm font-medium text-zinc-100">Révoquer l’agent</p>
                        <p className="mt-0.5 text-xs text-muted">Coupe sa connexion au hub. Une nouvelle installation sera nécessaire pour le reconnecter.</p>
                      </div>
                    </div>
                    <Button variant="danger" icon={ShieldOff} onClick={danger.onRevoke}>Révoquer</Button>
                  </div>
                )}
                <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3">
                    <Trash2 className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                    <div>
                      <p className="text-sm font-medium text-zinc-100">Supprimer cet hôte</p>
                      <p className="mt-0.5 text-xs text-muted">Supprime l’hôte et son historique, puis déconnecte son agent. Cette action est irréversible.</p>
                    </div>
                  </div>
                  <Button variant="danger" icon={Trash2} onClick={danger.onDelete}>Supprimer</Button>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </Modal>
  );
}
