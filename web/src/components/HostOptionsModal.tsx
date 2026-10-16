import { useState } from 'react';
import clsx from 'clsx';
import { Cpu, KeyRound, Power, ShieldAlert, ShieldOff, SlidersHorizontal, Tag, Trash2, type LucideIcon } from 'lucide-react';
import { api, type Host, type InstallInfo } from '../lib/api';
import { useUpdateHostCache } from '../lib/queries';
import { agentRevoked, needsReinstall, osLabel } from '../lib/status';
import { useToast } from '../lib/toast';
import { HaExcludedField } from './HaExcludedField';
import { SiteSelect, TagPicker } from './HostTags';
import { InstallInstructions } from './InstallInstructions';
import { RoamingField } from './RoamingField';
import { Badge, Button, Modal } from './ui';

// Actions of the « Danger » zone, owned by the caller (its confirmations); no zone without them (host list).
export interface HostDangerActions {
  onReboot?: () => void;
  rebootDisabled: boolean;
  onRevoke: () => void;
  onDelete: () => void;
}

type SectionId = 'identity' | 'behavior' | 'agent' | 'danger';

// Identity and behavior are saved together (form); agent and danger actions apply immediately.
const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: 'identity', label: 'Identité', icon: Tag },
  { id: 'behavior', label: 'Comportement', icon: SlidersHorizontal },
  { id: 'agent', label: 'Agent', icon: Cpu },
  { id: 'danger', label: 'Danger', icon: ShieldAlert },
];

const authLabel = (host: Host) =>
  host.agentAuth === 'cert' ? 'Certificat' : host.agentAuth === 'legacy' ? 'Ancien jeton' : agentRevoked(host) ? 'Révoqué' : 'Jamais enrôlé';

// mounted only while open: its state starts from the current host
export function HostOptionsModal({ host, onClose, danger }: { host: Host; onClose: () => void; danger?: HostDangerActions }) {
  const [name, setName] = useState(host.name);
  const [siteId, setSiteId] = useState(host.siteId ?? '');
  const [tags, setTags] = useState(host.tags);
  const [roaming, setRoaming] = useState(host.roaming);
  const [haExcluded, setHaExcluded] = useState(host.haExcluded);
  const [busy, setBusy] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [install, setInstall] = useState<InstallInfo | null>(null);
  const [section, setSection] = useState<SectionId>('identity');
  const upsert = useUpdateHostCache();
  const toast = useToast();

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      upsert(await api.updateHost(host.id, { name, siteId, tags, roaming, haExcluded }));
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

  const sections = SECTIONS.filter((x) => x.id !== 'danger' || danger);
  const isForm = section === 'identity' || section === 'behavior';

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
      wide
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
      <div className="flex min-h-72 flex-col gap-4 sm:flex-row sm:gap-6">
        <nav aria-label="Sections" className="flex shrink-0 gap-1 overflow-x-auto sm:w-40 sm:flex-col">
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
          {/* one form for both tabs: the hidden one keeps its state */}
          <form id="host-options-form" onSubmit={save} className={clsx(!isForm && 'hidden')}>
            <div className={clsx('space-y-4', section !== 'identity' && 'hidden')}>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted">Nom</span>
                <input className="input" required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <SiteSelect value={siteId} onChange={setSiteId} />
              <TagPicker value={tags} onChange={setTags} />
            </div>
            <div className={clsx('space-y-4', section !== 'behavior' && 'hidden')}>
              <RoamingField checked={roaming} onChange={setRoaming} />
              <HaExcludedField checked={haExcluded} onChange={setHaExcluded} />
            </div>
          </form>

          {section === 'agent' && (
            <div className="space-y-4">
              <p className="text-xs text-muted">Ces actions s'appliquent immédiatement, sans passer par Enregistrer.</p>
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
              <Button icon={KeyRound} loading={enrolling} onClick={newInstall}>Nouvelle commande d'installation</Button>
            </div>
          )}

          {section === 'danger' && danger && (
            <div className="space-y-3">
              <p className="text-xs text-muted">Ces actions s'appliquent immédiatement et demandent une confirmation.</p>
              <div className="flex flex-wrap gap-2">
                {danger.onReboot && (
                  <Button variant="danger" icon={Power} disabled={danger.rebootDisabled} onClick={danger.onReboot}>Redémarrer</Button>
                )}
                {host.agentAuth !== 'none' && <Button variant="danger" icon={ShieldOff} onClick={danger.onRevoke}>Révoquer l'agent</Button>}
                <Button variant="danger" icon={Trash2} onClick={danger.onDelete}>Supprimer l'hôte</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
