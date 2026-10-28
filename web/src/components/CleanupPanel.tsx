import { useState } from 'react';
import { Brush } from 'lucide-react';
import type { Host } from '../lib/api';
import { useRunJob } from '../lib/queries';
import { Button, ConfirmModal, Modal, Tag } from './ui';
import { JobConsole } from './JobConsole';
import { useMe } from '../lib/auth';

// Packages `apt-get autoremove` would remove (dependencies no longer needed, old kernels), as a badge
// of the host page like on the host list; nothing when there is none.
export function CleanupButton({ host, running, onStarted }: { host: Host; running: boolean; onStarted: (jobId: string) => void }) {
  const run = useRunJob();
  const { canWrite } = useMe();
  const [confirm, setConfirm] = useState(false);
  const pkgs = host.apt?.autoremovable ?? [];
  if (pkgs.length === 0) return null;
  const why = !canWrite ? 'lecture seule' : !host.online ? 'hôte hors ligne' : running ? 'une tâche est en cours' : null;

  return (
    <>
      <Button
        size="sm"
        icon={Brush}
        title={`${pkgs.join(', ')}\n\n${why ? `Nettoyer : impossible, ${why}` : 'Nettoyer (apt autoremove)'}`}
        disabled={!!why}
        onClick={() => setConfirm(true)}
      >
        {pkgs.length} à nettoyer
      </Button>
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Nettoyer ${host.name}`}
        confirmLabel="Lancer apt-get autoremove"
        danger
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
        <p className="mb-3">{pkgs.length} paquet(s) vont être supprimés :</p>
        <div className="flex max-h-48 flex-wrap gap-1.5 overflow-auto">{pkgs.map((p) => <Tag key={p}>{p}</Tag>)}</div>
        <p className="mt-3 text-xs text-muted">Le noyau en cours d'utilisation n'est jamais supprimé par apt.</p>
      </ConfirmModal>
    </>
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
