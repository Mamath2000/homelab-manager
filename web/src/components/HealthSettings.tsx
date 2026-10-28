import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle } from 'lucide-react';
import { api, type HealthSettings as HealthSettingsValues } from '../lib/api';
import { useToast } from '../lib/toast';
import { Button, Panel, Spinner } from './ui';
import { useSettingsDraft } from './settingsDraft';
import { ThresholdFields } from './HealthThresholdsForm';

type Form = Omit<HealthSettingsValues, 'retentionHours'>;
const intervals: { key: keyof Form; label: string; min: number; max: number; suffix: string; help: string }[] = [
  { key: 'systemIntervalSeconds', label: 'CPU, mémoire et charge Unix', min: 10, max: 3600, suffix: 'secondes', help: 'Fréquence des mesures CPU/RAM et load 1/5/15.' },
  { key: 'diskIntervalSeconds', label: 'Utilisation des volumes', min: 60, max: 86400, suffix: 'secondes', help: 'Fréquence de vérification de l’espace utilisé par volume.' },
  { key: 'smartIntervalSeconds', label: 'SMART', min: 600, max: 2592000, suffix: 'secondes', help: 'Fréquence des requêtes smartctl sur les disques explicitement activés dans chaque fiche hôte.' },
];
function formOf(s: HealthSettingsValues): Form {
  return {
    systemIntervalSeconds: s.systemIntervalSeconds,
    diskIntervalSeconds: s.diskIntervalSeconds,
    smartIntervalSeconds: s.smartIntervalSeconds,
    cpuWarningThreshold: s.cpuWarningThreshold,
    cpuAlertThreshold: s.cpuAlertThreshold,
    memoryWarningThreshold: s.memoryWarningThreshold,
    memoryAlertThreshold: s.memoryAlertThreshold,
    diskWarningThreshold: s.diskWarningThreshold,
    diskAlertThreshold: s.diskAlertThreshold,
    smartTemperatureWarningThreshold: s.smartTemperatureWarningThreshold,
    smartTemperatureAlertThreshold: s.smartTemperatureAlertThreshold,
    smartWearWarningThreshold: s.smartWearWarningThreshold,
    smartWearAlertThreshold: s.smartWearAlertThreshold,
    systemSustainedMinutes: s.systemSustainedMinutes,
    smartSustainedMinutes: s.smartSustainedMinutes,
    loadWarningThreshold: s.loadWarningThreshold,
    loadAlertThreshold: s.loadAlertThreshold,
    loadSustainedMinutes: s.loadSustainedMinutes,
    diskRearmMinutes: s.diskRearmMinutes,
  };
}

export function HealthSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error } = useQuery({ queryKey: ['settings', 'health'], queryFn: api.healthSettings });
  const [draft, setDraft] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const form = draft ?? (data ? formOf(data) : null);
  const dirty = !!data && !!draft && JSON.stringify(draft) !== JSON.stringify(formOf(data));

  const discard = () => setDraft(null);
  const save = async () => {
    if (!form) return false;
    setSaving(true);
    try {
      qc.setQueryData(['settings', 'health'], await api.saveHealthSettings(form));
      await qc.invalidateQueries({ queryKey: ['hosts'] });
      setDraft(null);
      toast.success('Réglages Santé enregistrés');
      return true;
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };
  useSettingsDraft(dirty, save, discard);
  if (isLoading) return <div className="flex justify-center p-12"><Spinner /></div>;
  if (error) return <Panel title="Réglages Santé indisponibles" icon={AlertTriangle}><p className="p-4 text-sm text-red-300">{error.message}</p></Panel>;
  if (!form) return null;
  return (
    <Panel title="Collecte et alertes Santé" icon={Activity}>
      <div className="space-y-4 p-4">
        <p className="max-w-3xl text-sm leading-relaxed text-muted">Les seuils de volume déclenchent immédiatement, puis ne ré-alertent pas pendant le délai de réactivation qui suit la levée. Les autres indicateurs peuvent demander une durée au-dessus du seuil. Les disques SMART sont activés hôte par hôte et ne doivent pas inclure de disques virtualisés.</p>
        <div className="grid gap-3 lg:grid-cols-2">
          {intervals.map(({ key, label, min, max, suffix, help }) => (
            <label key={key} className="rounded-md border border-line bg-raised/30 p-3">
              <span className="mb-1 block text-sm font-medium text-zinc-100">{label}</span>
              <span className="flex items-center gap-2">
                <input
                  className="input w-32"
                  type="number"
                  min={min}
                  max={max}
                  value={form[key]}
                  onChange={(event) => setDraft({ ...form, [key]: Number(event.target.value) })}
                />
                <span className="text-xs text-muted">{suffix}</span>
              </span>
              <span className="mt-2 block text-xs text-muted">{help}</span>
            </label>
          ))}
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium text-zinc-100">Seuils et temporisations</h3>
          <div className="space-y-2">
            <ThresholdFields form={form} onChange={(key, value) => setDraft({ ...form, [key]: value })} />
            <p className="text-xs text-muted">Le seuil Warning doit rester inférieur au seuil Alerte. La durée est partagée entre CPU et mémoire, ainsi qu’entre les mesures SMART ; la charge Unix (load5 rapporté au nombre de CPU, sans alerte sur les conteneurs) a la sienne. Les alertes sont levées dès que la valeur repasse sous le seuil. Les seuils de volume sont toujours immédiats ; leur délai de réactivation (0 = aucun) empêche de ré-alerter au même niveau, ou à un niveau inférieur, juste après la levée.</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={!dirty || saving} onClick={discard}>Annuler</Button>
          <Button loading={saving} disabled={!dirty} onClick={() => void save()}>Enregistrer</Button>
        </div>
      </div>
    </Panel>
  );
}
