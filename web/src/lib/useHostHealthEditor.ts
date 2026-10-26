import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type HealthEnabled, type HealthOverrides } from './api';
import { useToast } from './toast';
import { ENABLED_KEYS, THRESHOLD_KEYS, invalidThreshold, thresholdsOf, type ThresholdForm } from './healthThresholds';

interface Draft { values: ThresholdForm; enabled: HealthEnabled }

// State of the thresholds editor of one host. The dialog that hosts it owns it, so that its footer (Annuler / Enregistrer,
// like the other dialogs) and its body share the draft.
export function useHostHealthEditor(hostId: string, { canManage, enabled = true }: { canManage: boolean; enabled?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error } = useQuery({ queryKey: ['health', 'overrides', hostId], queryFn: () => api.hostHealthOverrides(hostId), enabled });
  const { data: global } = useQuery({ queryKey: ['settings', 'health'], queryFn: api.healthSettings, enabled });
  const [draft, setDraft] = useState<Draft | null>(null);

  const base: Draft | null = data ? { values: thresholdsOf(data.effective), enabled: Object.fromEntries(ENABLED_KEYS.map((k) => [k, data.effective[k]])) as HealthEnabled } : null;
  const current = draft ?? base;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(base);
  const invalid = current ? invalidThreshold(current.values) : undefined;
  const reference = global && thresholdsOf(global);
  const customized = !!data && Object.keys(data.overrides).length > 0;

  const done = async (res: Awaited<ReturnType<typeof api.saveHostHealthOverrides>>) => {
    qc.setQueryData(['health', 'overrides', hostId], res);
    setDraft(null);
    await Promise.all([qc.invalidateQueries({ queryKey: ['health'] }), qc.invalidateQueries({ queryKey: ['hosts'] })]);
  };
  const saveMutation = useMutation({
    mutationFn: () => {
      // only what differs from the global settings is stored: the rest keeps following them
      const overrides: HealthOverrides = {};
      for (const k of THRESHOLD_KEYS) if (reference && current!.values[k] !== reference[k]) overrides[k] = current!.values[k];
      for (const k of ENABLED_KEYS) if (!current!.enabled[k]) overrides[k] = false;
      return api.saveHostHealthOverrides(hostId, overrides);
    },
    onSuccess: async (res) => { await done(res); toast.success('Seuils de l\'hôte enregistrés'); },
    onError: (err: Error) => toast.error(err.message),
  });
  const resetMutation = useMutation({
    mutationFn: () => api.resetHostHealthOverrides(hostId),
    onSuccess: async (res) => { await done(res); toast.success('Seuils par défaut réappliqués'); },
    onError: (err: Error) => toast.error(err.message),
  });

  return {
    isLoading, error, current, reference, customized, dirty, invalid, canManage,
    setValues: (key: keyof ThresholdForm, value: number) => current && setDraft({ ...current, values: { ...current.values, [key]: value } }),
    setEnabled: (key: keyof HealthEnabled, value: boolean) => current && setDraft({ ...current, enabled: { ...current.enabled, [key]: value } }),
    // saves when something changed, then calls onSaved (close); nothing to save = just onSaved
    save: async (onSaved: () => void) => {
      if (dirty) { try { await saveMutation.mutateAsync(); } catch { return; } }
      onSaved();
    },
    reset: () => resetMutation.mutate(),
    saving: saveMutation.isPending,
    resetting: resetMutation.isPending,
  };
}
export type HostHealthEditor = ReturnType<typeof useHostHealthEditor>;
