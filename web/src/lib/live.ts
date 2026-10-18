import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Host, Job } from './api';
import { keys, useUpdateHostCache } from './queries';

// Subscribes to the hub's SSE stream and patches the React Query cache in place.
export function useLiveEvents(enabled: boolean) {
  const qc = useQueryClient();
  const upsertHost = useUpdateHostCache();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource('/api/events');
    es.onopen = () => {
      setConnected(true);
      // catch up on anything missed while disconnected
      qc.invalidateQueries();
    };
    es.onerror = () => setConnected(false);

    es.addEventListener('host', (e) => {
      const host = JSON.parse((e as MessageEvent).data) as Host;
      upsertHost(host);
      qc.invalidateQueries({ queryKey: keys.status });
      // its alerts of the day may have changed (timeline of the host page)
      qc.invalidateQueries({ queryKey: keys.hostAlerts(host.id) });
      // capabilities (PBS client installed...) shown by the backups window
      qc.invalidateQueries({ queryKey: ['backup-jobs', host.id] });
    });
    es.addEventListener('host.deleted', (e) => {
      const { id } = JSON.parse((e as MessageEvent).data) as { id: string };
      qc.setQueryData<Host[]>(keys.hosts, (old) => old?.filter((h) => h.id !== id));
    });
    es.addEventListener('job', (e) => {
      const job = JSON.parse((e as MessageEvent).data) as Job;
      qc.invalidateQueries({ queryKey: keys.jobs });
      qc.invalidateQueries({ queryKey: keys.hostJobs(job.hostId) });
      if (job.status !== 'running') qc.invalidateQueries({ queryKey: keys.status });
      if (job.status === 'failed') {
        qc.invalidateQueries({ queryKey: keys.hostAlerts(job.hostId) });
        qc.invalidateQueries({ queryKey: keys.alerts });
      }
      qc.setQueryData<Job>(keys.job(job.id), (old) => (old ? { ...old, ...job, log: old.log } : old));
      if (job.status !== 'running') qc.invalidateQueries({ queryKey: keys.job(job.id) });
    });
    es.addEventListener('backups', () => {
      qc.invalidateQueries({ queryKey: keys.backups });
      qc.invalidateQueries({ queryKey: keys.status });
      qc.invalidateQueries({ queryKey: ['host-alerts'] });
      qc.invalidateQueries({ queryKey: keys.alerts });
      qc.invalidateQueries({ queryKey: ['backup-jobs'] });
      // state of the last poll of the PBS and of the secondary PBS (Paramètres › Sauvegardes)
      qc.invalidateQueries({ queryKey: ['settings', 'pbs'] });
      qc.invalidateQueries({ queryKey: ['settings', 'pbs-remote'] });
    });
    // sites or tags changed in the settings
    es.addEventListener('catalog', () => {
      qc.invalidateQueries({ queryKey: keys.sites });
      qc.invalidateQueries({ queryKey: keys.tags });
    });
    es.addEventListener('job.log', (e) => {
      const { jobId, data } = JSON.parse((e as MessageEvent).data) as { jobId: string; data: string };
      qc.setQueryData<Job>(keys.job(jobId), (old) => (old ? { ...old, log: (old.log ?? '') + data } : old));
    });

    return () => {
      es.close();
      setConnected(false);
    };
  }, [enabled, qc]); // eslint-disable-line react-hooks/exhaustive-deps

  return connected;
}
