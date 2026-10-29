import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Host, type Job, type JobAction, type ProbeDay, type ProbeMeasure, type ProbeSubjectKind, type SetupOption } from './api';
import { useToast } from './toast';

export const keys = {
  hosts: ['hosts'] as const,
  jobs: ['jobs'] as const,
  hostJobs: (id: string) => ['jobs', 'host', id] as const,
  job: (id: string) => ['job', id] as const,
  backups: ['backups'] as const,
  hostAlerts: (id: string) => ['host-alerts', id] as const,
  equipments: ['equipments'] as const,
  equipmentAlerts: (id: string) => ['equipment-alerts', id] as const,
  alerts: ['alerts'] as const,
  status: ['status'] as const,
  sites: ['sites'] as const,
  tags: ['tags'] as const,
  // host or equipment: their ids never meet
  probes: (subjectId: string) => ['probes', subjectId] as const,
  mqttBrokers: ['settings', 'mqtt-brokers'] as const,
  roles: ['roles'] as const,
};

export function useBackups() {
  return useQuery({ queryKey: keys.backups, queryFn: api.backups });
}

export function useBackupUsage() {
  return useQuery({ queryKey: [...keys.backups, 'usage'], queryFn: api.backupUsage });
}

export function useBackupStats(days: 30 | 60 | 90 | 180) {
  // under the key of the backups: refreshed by the same event
  return useQuery({ queryKey: [...keys.backups, 'stats', days], queryFn: () => api.backupStats(days) });
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

// Alert days of a host or an equipment (timeline of its page)
export function useAlertDays(kind: ProbeSubjectKind, id: string) {
  const queryKey = kind === 'host' ? keys.hostAlerts(id) : keys.equipmentAlerts(id);
  return useQuery({ queryKey, queryFn: () => (kind === 'host' ? api.hostAlerts(id) : api.equipmentAlerts(id)) });
}

// Alerts of every host (dashboard): the days change slowly, refreshed every 5 minutes and on the
// events that record an alert at once (failed job, backups).
export function useAllAlerts() {
  return useQuery({ queryKey: keys.alerts, queryFn: api.alerts, refetchInterval: 5 * 60_000 });
}

// Live status by domain of every host, recomputed by the hub (late backups change with time alone).
export function useStatus() {
  return useQuery({ queryKey: keys.status, queryFn: api.status, refetchInterval: 60_000 });
}

export function useProbes(kind: ProbeSubjectKind, id: string) {
  return useQuery({ queryKey: keys.probes(id), queryFn: () => api.probes(kind, id), select: (d) => d.probes });
}

// Every probe (Probes page): states change with the measures of the hub, refreshed every 30 s.
export function useAllProbes() {
  return useQuery({ queryKey: ['probes', 'all'], queryFn: api.allProbes, select: (d) => d.probes, refetchInterval: 30_000 });
}

// Measures by day of every probe (blocks of the last 30 days), grouped by probe.
export function useProbeDays() {
  return useQuery({
    queryKey: ['probes', 'days'],
    queryFn: api.probeDays,
    refetchInterval: 60_000,
    select: (d) => {
      const by = new Map<string, Map<string, ProbeDay>>();
      for (const x of d.days) by.set(x.probeId, (by.get(x.probeId) ?? new Map()).set(x.day, x));
      return by;
    },
  });
}

// Every measure of the last hour, grouped by probe (status lines of the Probes page).
export function useProbeRecent() {
  return useQuery({
    queryKey: ['probes', 'recent'],
    queryFn: api.probeRecent,
    refetchInterval: 30_000,
    select: (d) => {
      const by = new Map<string, ProbeMeasure[]>();
      for (const m of d.measures) by.set(m.probeId, [...(by.get(m.probeId) ?? []), m]);
      return by;
    },
  });
}

export function useEquipments() {
  return useQuery({ queryKey: keys.equipments, queryFn: api.equipments, select: (d) => d.equipments });
}

export function useEquipment(id: string | undefined) {
  const q = useEquipments();
  return { ...q, data: q.data?.find((e) => e.id === id) };
}

export function useEquipmentAlerts(id: string) {
  return useQuery({ queryKey: keys.equipmentAlerts(id), queryFn: () => api.equipmentAlerts(id) });
}

export function useRoles() {
  return useQuery({ queryKey: keys.roles, queryFn: api.roles, select: (d) => d.roles });
}

export function useMqttBrokers(enabled = true) {
  return useQuery({ queryKey: keys.mqttBrokers, queryFn: api.mqttBrokers, select: (d) => d.brokers, enabled });
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
    mutationFn: (v: { hostId: string; action: JobAction; packages?: string[]; target?: { stack: string; service?: string } | { sessionId: number } }) =>
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
