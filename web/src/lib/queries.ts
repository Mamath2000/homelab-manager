import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Host, type Job, type JobAction, type SetupOption } from './api';
import { useToast } from './toast';

export const keys = {
  hosts: ['hosts'] as const,
  jobs: ['jobs'] as const,
  hostJobs: (id: string) => ['jobs', 'host', id] as const,
  job: (id: string) => ['job', id] as const,
  backups: ['backups'] as const,
  hostAlerts: (id: string) => ['host-alerts', id] as const,
  alerts: ['alerts'] as const,
  sites: ['sites'] as const,
  tags: ['tags'] as const,
};

export function useBackups() {
  return useQuery({ queryKey: keys.backups, queryFn: api.backups });
}

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

export function useHostAlerts(id: string) {
  return useQuery({ queryKey: keys.hostAlerts(id), queryFn: () => api.hostAlerts(id) });
}

// Alerts of every host (dashboard): the days change slowly, refreshed every 5 minutes and on the
// events that record an alert at once (failed job, backups).
export function useAllAlerts() {
  return useQuery({ queryKey: keys.alerts, queryFn: api.alerts, refetchInterval: 5 * 60_000 });
}

export function useSites() {
  return useQuery({ queryKey: keys.sites, queryFn: api.sites, select: (d) => d.sites });
}

export function useTags() {
  return useQuery({ queryKey: keys.tags, queryFn: api.tags, select: (d) => d.tags });
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
    mutationFn: (v: { hostIds: string[]; action: JobAction; options?: SetupOption[]; securityOnly?: boolean }) =>
      api.runBulk(v.hostIds, v.action, v.options, v.securityOnly),
    onSuccess: (jobs) => bulkToast(toast, jobs),
    onError: (e) => toast.error(e.message),
  });
}

function bulkToast(toast: ReturnType<typeof useToast>, jobs: Job[]) {
  const failed = jobs.filter((j) => j.status === 'failed');
  const started = jobs.length - failed.length;
  if (started) toast.success(`${started} tâche${started > 1 ? 's' : ''} lancée${started > 1 ? 's' : ''}`);
  if (failed.length) toast.error(`Hors ligne : ${[...new Set(failed.map((j) => j.hostName))].join(', ')}`);
  if (!jobs.length) toast.error('Plus rien à lancer : la liste a changé entre-temps');
}

// docker_update of several stacks, on several hosts (dashboard)
export function useDockerUpdate() {
  const toast = useToast();
  return useMutation({
    mutationFn: (targets: { hostId: string; stack: string }[]) => api.dockerUpdate(targets),
    onSuccess: (jobs) => bulkToast(toast, jobs),
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
