import { useState } from 'react';
import { KeyRound, Power, ShieldOff, Trash2 } from 'lucide-react';
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</h4>
      {children}
    </section>
  );
}

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
      onClose={onClose}
      title={
        <>
          Options de {host.name}
          <span className="block text-xs font-normal text-muted">{[osLabel(host), host.agentVersion && `agent ${host.agentVersion}`].filter(Boolean).join(' · ')}</span>
        </>
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
          <Button type="submit" form="host-options-form" variant="primary" loading={busy}>Enregistrer</Button>
        </>
      }
    >
      <div className="space-y-6">
        <form id="host-options-form" onSubmit={save} className="space-y-6">
          <Section title="Identité">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Nom</span>
              <input className="input" required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <SiteSelect value={siteId} onChange={setSiteId} />
            <TagPicker value={tags} onChange={setTags} />
          </Section>
          <Section title="Comportement">
            <RoamingField checked={roaming} onChange={setRoaming} />
            <HaExcludedField checked={haExcluded} onChange={setHaExcluded} />
          </Section>
        </form>

        <Section title="Agent">
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
        </Section>

        {danger && (
          <section className="space-y-3 rounded-md border border-red-500/40 p-3">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-red-300">Danger</h4>
            <div className="flex flex-wrap gap-2">
              {danger.onReboot && (
                <Button variant="danger" icon={Power} disabled={danger.rebootDisabled} onClick={danger.onReboot}>Redémarrer</Button>
              )}
              {host.agentAuth !== 'none' && <Button variant="danger" icon={ShieldOff} onClick={danger.onRevoke}>Révoquer l'agent</Button>}
              <Button variant="danger" icon={Trash2} onClick={danger.onDelete}>Supprimer l'hôte</Button>
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}
