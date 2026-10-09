import { useEffect, useRef } from 'react';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import type { Job } from '../lib/api';
import { jobTitle, dateTime, duration } from '../lib/format';
import { useJob } from '../lib/queries';
import { Spinner } from './ui';

export function JobStatusIcon({ status, className = 'h-4 w-4' }: { status: Job['status']; className?: string }) {
  if (status === 'running') return <Loader2 className={`${className} animate-spin text-sky-400`} />;
  if (status === 'success') return <CheckCircle2 className={`${className} text-emerald-400`} />;
  return <XCircle className={`${className} text-red-400`} />;
}

// Live output of a job; follows the tail while the job runs.
export function JobConsole({ jobId, height = 'h-80' }: { jobId: string; height?: string }) {
  const { data: job, isLoading } = useJob(jobId);
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [job?.log]);

  if (isLoading || !job) return <div className="flex justify-center p-8"><Spinner /></div>;

  return (
    <div className="overflow-hidden rounded-md border border-line">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-raised/60 px-3 py-2 text-xs">
        <span className="flex items-center gap-2 text-zinc-200">
          <JobStatusIcon status={job.status} />
          <span className="font-medium">{jobTitle(job)}</span>
          <span className="text-muted">· {job.hostName}</span>
          {job.packages.length > 0 && <span className="text-muted">· {job.packages.length} paquet(s)</span>}
        </span>
        <span className="text-muted">
          {dateTime(job.createdAt)} · {duration(job.createdAt, job.finishedAt)}
          {job.exitCode !== null && job.status !== 'running' && ` · code ${job.exitCode}`}
        </span>
      </div>
      <pre
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className={`${height} overflow-auto bg-black/60 p-3 font-mono text-[12px] leading-relaxed text-zinc-300`}
      >
        {job.log || (job.status === 'running' ? 'En attente de la sortie…\n' : '')}
        {job.error && <span className="text-red-400">{`\n✖ ${job.error}\n`}</span>}
        {job.status === 'success' && <span className="text-emerald-400">{'\n✔ Terminé\n'}</span>}
      </pre>
    </div>
  );
}
