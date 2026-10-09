import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Host, type JobAction } from './api';
import { useToast } from './toast';

export const keys = {
  hosts: ['hosts'] as const,
  jobs: ['jobs'] as const,
  hostJobs: (id: string) => ['jobs', 'host', id] as const,
  job: (id: string) => ['job', id] as const,
};

export function useHosts() {
  return useQuery({ queryKey: keys.hosts, queryFn: api.hosts });
}

export function useHost(id: string | undefined) {
  const q = useHosts();
  return { ...q, data: q.data?.find((h) => h.id === id) };
}

export function useJobs() {
  return useQuery({ queryKey: keys.jobs, queryFn: () => api.jobs(100) });
}

export function useHostJobs(id: string) {
  return useQuery({ queryKey: keys.hostJobs(id), queryFn: () => api.hostJobs(id) });
}

export function useJob(id: string | null | undefined) {
  return useQuery({ queryKey: keys.job(id ?? ''), queryFn: () => api.job(id!), enabled: !!id });
}

export function useRunJob() {
  const toast = useToast();
  return useMutation({
    mutationFn: (v: { hostId: string; action: JobAction; packages?: string[]; target?: { stack: string; service?: string } }) =>
      api.runJob(v.hostId, v.action, v.packages, v.target),
    onSuccess: (job) => {
      if (job.status === 'failed') toast.error(`${job.hostName} : ${job.error ?? 'échec'}`);
    },
    onError: (e) => toast.error(e.message),
  });
}

export function useRunBulk() {
  const toast = useToast();
  return useMutation({
    mutationFn: (v: { hostIds: string[]; action: JobAction }) => api.runBulk(v.hostIds, v.action),
    onSuccess: (jobs) => {
      const failed = jobs.filter((j) => j.status === 'failed');
      const started = jobs.length - failed.length;
      if (started) toast.success(`${started} tâche${started > 1 ? 's' : ''} lancée${started > 1 ? 's' : ''}`);
      if (failed.length) toast.error(`Hors ligne : ${failed.map((j) => j.hostName).join(', ')}`);
    },
    onError: (e) => toast.error(e.message),
  });
}

export function useUpdateHostCache() {
  const qc = useQueryClient();
  return (host: Host) =>
    qc.setQueryData<Host[]>(keys.hosts, (old) => {
      if (!old) return old;
      const i = old.findIndex((h) => h.id === host.id);
      if (i === -1) return [...old, host];
      const next = old.slice();
      next[i] = host;
      return next;
    });
}
