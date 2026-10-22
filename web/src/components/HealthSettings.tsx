import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle } from 'lucide-react';
import { api, type HealthSettings as HealthSettingsValues } from '../lib/api';
import { useToast } from '../lib/toast';
import { Button, Panel, Spinner } from './ui';
import { useSettingsDraft } from './settingsDraft';

type Form = Omit<HealthSettingsValues, 'retentionHours'>;
const intervals: { key: keyof Form; label: string; min: number; max: number; suffix: string; help: string }[] = [
  { key: 'systemIntervalSeconds', label: 'CPU, mémoire et charge Unix', min: 10, max: 3600, suffix: 'secondes', help: 'Fréquence des mesures CPU/RAM et load 1/5/15.' },
  { key: 'diskIntervalSeconds', label: 'Utilisation des volumes', min: 60, max: 86400, suffix: 'secondes', help: 'Fréquence de vérification de l’espace utilisé par volume.' },
  { key: 'smartIntervalSeconds', label: 'SMART', min: 600, max: 2592000, suffix: 'secondes', help: 'Fréquence des requêtes smartctl sur les disques explicitement activés dans chaque fiche hôte.' },
];
const thresholds: {
  label: string;
  warning: keyof Form;
  alert: keyof Form;
  duration: keyof Form;
  max: number;
  suffix: string;
  durationMax: number;
}[] = [
  { label: 'CPU', warning: 'cpuWarningThreshold', alert: 'cpuAlertThreshold', duration: 'systemSustainedMinutes', max: 100, suffix: '%', durationMax: 60 },
  { label: 'Mémoire', warning: 'memoryWarningThreshold', alert: 'memoryAlertThreshold', duration: 'systemSustainedMinutes', max: 100, suffix: '%', durationMax: 60 },
  { label: 'Volumes', warning: 'diskWarningThreshold', alert: 'diskAlertThreshold', duration: 'diskSustainedMinutes', max: 100, suffix: '%', durationMax: 1440 },
  { label: 'Température SMART', warning: 'smartTemperatureWarningThreshold', alert: 'smartTemperatureAlertThreshold', duration: 'smartSustainedMinutes', max: 150, suffix: '°C', durationMax: 2880 },
  { label: 'Usure NVMe SMART', warning: 'smartWearWarningThreshold', alert: 'smartWearAlertThreshold', duration: 'smartSustainedMinutes', max: 1000, suffix: '%', durationMax: 2880 },
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
    diskSustainedMinutes: s.diskSustainedMinutes,
    smartSustainedMinutes: s.smartSustainedMinutes,
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
        <p className="max-w-3xl text-sm leading-relaxed text-muted">Chaque indicateur déclenche un warning ou une alerte après être resté au-dessus du seuil pendant la durée définie. Une durée de 0 déclenche immédiatement. Les disques SMART sont activés hôte par hôte et ne doivent pas inclure de disques virtualisés.</p>
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
            {thresholds.map(({ label, warning, alert, duration, max, suffix, durationMax }) => (
              <div key={label} className="grid gap-3 rounded-md border border-line bg-raised/30 p-3 sm:grid-cols-[minmax(8rem,1fr)_repeat(3,minmax(6rem,auto))] sm:items-end">
                <span className="text-sm font-medium text-zinc-100">{label}</span>
                {([
                  [warning, 'Warning', max, suffix],
                  [alert, 'Alerte', max, suffix],
                  [duration, 'Durée', durationMax, 'minutes'],
                ] as const).map(([key, title, maxValue, unit]) => (
                  <label key={`${label}-${key}`} className="text-xs text-muted">
                    <span className="mb-1 block">{title}</span>
                    <span className="flex items-center gap-1.5">
                      <input
                        className="input w-24"
                        type="number"
                        min={title === 'Durée' ? 0 : 1}
                        max={maxValue}
                        value={form[key]}
                        onChange={(event) => setDraft({ ...form, [key]: Number(event.target.value) })}
                      />
                      <span>{unit}</span>
                    </span>
                  </label>
                ))}
              </div>
            ))}
            <p className="text-xs text-muted">Le seuil Warning doit rester inférieur au seuil Alerte. Une durée de zéro signifie un déclenchement immédiat. La période est partagée entre CPU et mémoire, entre les volumes, et entre les mesures SMART.</p>
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
