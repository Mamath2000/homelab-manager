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

    es.addEventListener('host', (e) => upsertHost(JSON.parse((e as MessageEvent).data) as Host));
    es.addEventListener('host.deleted', (e) => {
      const { id } = JSON.parse((e as MessageEvent).data) as { id: string };
      qc.setQueryData<Host[]>(keys.hosts, (old) => old?.filter((h) => h.id !== id));
    });
    es.addEventListener('job', (e) => {
      const job = JSON.parse((e as MessageEvent).data) as Job;
      qc.invalidateQueries({ queryKey: keys.jobs });
      qc.setQueryData<Job>(keys.job(job.id), (old) => (old ? { ...old, ...job, log: old.log } : old));
      if (job.status !== 'running') qc.invalidateQueries({ queryKey: keys.job(job.id) });
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
