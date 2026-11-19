import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Terminal, Trash2 } from 'lucide-react';
import { JobConsole } from '../components/JobConsole';
import { HeaderTitle } from '../components/HeaderSlot';
import { useJob } from '../lib/queries';
import { jobTitle } from '../lib/format';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { useToast } from '../lib/toast';
import { Button, ConfirmModal } from '../components/ui';

export function JobDetail() {
  const { id = '' } = useParams();
  const { data: job } = useJob(id);
  const { canManage } = useMe();
  const toast = useToast();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <Link to="/activity" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-zinc-200">
        <ArrowLeft className="h-4 w-4" /> Activité
      </Link>
      <HeaderTitle icon={Terminal} title={job ? `${jobTitle(job)} · ${job.hostName}` : 'Tâche'}>
        {job && <Link to={`/hosts/${job.hostId}`} className="text-sm text-emerald-400 hover:underline">Voir l'hôte</Link>}
        {job && canManage && (
          <Button icon={Trash2} onClick={() => setDeleting(true)}>Supprimer</Button>
        )}
      </HeaderTitle>
      <ConfirmModal
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Supprimer la tâche"
        confirmLabel="Supprimer"
        danger
        onConfirm={async () => {
          try {
            await api.deleteJob(id);
            navigate('/activity');
          } catch (err) {
            toast.error((err as Error).message);
          }
        }}
      >
        {job?.status === 'running'
          ? "La tâche est encore en cours : elle sera oubliée du hub, sans arrêter la commande sur l'hôte. Son résultat éventuel sera ignoré."
          : "La tâche et son journal seront supprimés de l'historique."}
      </ConfirmModal>
      <JobConsole jobId={id} height="h-[50dvh] sm:h-[65vh]" />
    </>
  );
}
