import { Link, useParams } from 'react-router';
import { ArrowLeft, Terminal } from 'lucide-react';
import { JobConsole } from '../components/JobConsole';
import { PageHeader } from '../components/ui';
import { useJob } from '../lib/queries';
import { jobTitle } from '../lib/format';

export function JobDetail() {
  const { id = '' } = useParams();
  const { data: job } = useJob(id);
  return (
    <>
      <Link to="/activity" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-zinc-200">
        <ArrowLeft className="h-4 w-4" /> Activité
      </Link>
      <PageHeader icon={Terminal} title={job ? `${jobTitle(job)} · ${job.hostName}` : 'Tâche'}>
        {job && <Link to={`/hosts/${job.hostId}`} className="text-sm text-emerald-400 hover:underline">Voir l'hôte</Link>}
      </PageHeader>
      <JobConsole jobId={id} height="h-[65vh]" />
    </>
  );
}
