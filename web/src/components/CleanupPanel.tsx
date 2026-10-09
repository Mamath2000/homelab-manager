import { useState } from 'react';
import { Brush } from 'lucide-react';
import type { Host } from '../lib/api';
import { useRunJob } from '../lib/queries';
import { Button, ConfirmModal, Modal, Panel, Tag } from './ui';
import { JobConsole } from './JobConsole';
import { useMe } from '../lib/auth';

// Packages `apt-get autoremove` would remove: dependencies no longer needed, old kernels.
export function CleanupPanel({ host, running, onStarted }: { host: Host; running: boolean; onStarted: (jobId: string) => void }) {
  const run = useRunJob();
  const { canWrite } = useMe();
  const [confirm, setConfirm] = useState(false);
  const pkgs = host.apt?.autoremovable;
  if (!host.apt) return null;

  return (
    <Panel
      title={<>Nettoyage{pkgs && <span className="text-muted"> ({pkgs.length})</span>}</>}
      icon={Brush}
      actions={
        canWrite && pkgs && pkgs.length > 0 && (
          <Button size="sm" icon={Brush} disabled={!host.online || running} onClick={() => setConfirm(true)}>
            Nettoyer
          </Button>
        )
      }
    >
      {!pkgs ? (
        <p className="text-sm text-muted">Disponible après la mise à jour de l'agent de cet hôte.</p>
      ) : pkgs.length === 0 ? (
        <p className="text-sm text-muted">Aucun paquet inutile.</p>
      ) : (
        <>
          <p className="mb-3 text-sm text-zinc-300">
            {pkgs.length} paquet(s) installé(s) automatiquement et devenu(s) inutile(s), supprimables avec <code className="text-zinc-100">apt autoremove</code> :
          </p>
          <div className="flex max-h-40 flex-wrap gap-1.5 overflow-auto">
            {pkgs.map((p) => <Tag key={p}>{p}</Tag>)}
          </div>
        </>
      )}
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Nettoyer ${host.name}`}
        confirmLabel="Lancer apt-get autoremove"
        loading={run.isPending}
        onConfirm={() =>
          run.mutate({ hostId: host.id, action: 'apt_autoremove' }, {
            onSuccess: (j) => {
              setConfirm(false);
              onStarted(j.id);
            },
          })
        }
      >
        <p className="mb-3">{pkgs?.length} paquet(s) vont être supprimés :</p>
        <div className="flex max-h-48 flex-wrap gap-1.5 overflow-auto">{pkgs?.map((p) => <Tag key={p}>{p}</Tag>)}</div>
        <p className="mt-3 text-xs text-muted">Le noyau en cours d'utilisation n'est jamais supprimé par apt.</p>
      </ConfirmModal>
    </Panel>
  );
}

// Cleanup started from the host list: confirmation, then the job output in the same dialog.
export function CleanupModal({ host, onClose }: { host: Host | null; onClose: () => void }) {
  const run = useRunJob();
  const [jobId, setJobId] = useState<string | null>(null);
  const pkgs = host?.apt?.autoremovable ?? [];
  const close = () => {
    setJobId(null);
    onClose();
  };

  return (
    <Modal
      open={!!host}
      onClose={close}
      wide
      title={`Nettoyer ${host?.name ?? ''}`}
      footer={jobId ? <Button variant="ghost" onClick={close}>Fermer</Button> : (
        <>
          <Button variant="ghost" onClick={close}>Annuler</Button>
          <Button variant="primary" icon={Brush} loading={run.isPending} disabled={!host?.online}
            onClick={() => host && run.mutate({ hostId: host.id, action: 'apt_autoremove' }, { onSuccess: (j) => setJobId(j.id) })}>
            Lancer apt-get autoremove
          </Button>
        </>
      )}
    >
      {jobId ? <JobConsole jobId={jobId} /> : (
        <div className="text-sm text-zinc-300">
          <p className="mb-3">{pkgs.length} paquet(s) vont être supprimés :</p>
          <div className="flex max-h-48 flex-wrap gap-1.5 overflow-auto">{pkgs.map((p) => <Tag key={p}>{p}</Tag>)}</div>
          <p className="mt-3 text-xs text-muted">Le noyau en cours d'utilisation n'est jamais supprimé par apt.</p>
        </div>
      )}
    </Modal>
  );
}
