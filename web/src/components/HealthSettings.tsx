import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle } from 'lucide-react';
import { api, type HealthSettings as HealthSettingsValues } from '../lib/api';
import { useToast } from '../lib/toast';
import { Button, Panel, Spinner } from './ui';
import { useSettingsDraft } from './settingsDraft';

type Form = Omit<HealthSettingsValues, 'retentionHours'>;
const fields: { key: keyof Form; label: string; min: number; max: number; step?: number; suffix: string; help: string }[] = [
  { key: 'systemIntervalSeconds', label: 'CPU, mémoire et charge Unix', min: 10, max: 3600, suffix: 'secondes', help: 'Fréquence des mesures CPU/RAM et load 1/5/15.' },
  { key: 'diskIntervalSeconds', label: 'Utilisation des volumes', min: 60, max: 86400, suffix: 'secondes', help: 'Fréquence de vérification de l’espace utilisé par volume.' },
  { key: 'smartIntervalSeconds', label: 'SMART', min: 600, max: 2592000, suffix: 'secondes', help: 'Fréquence des requêtes smartctl sur les disques explicitement activés dans chaque fiche hôte.' },
  { key: 'cpuThreshold', label: 'Seuil CPU', min: 1, max: 100, step: 1, suffix: '%', help: 'Une alerte est déclenchée si ce seuil est dépassé pendant la durée ci-dessous.' },
  { key: 'memoryThreshold', label: 'Seuil mémoire', min: 1, max: 100, step: 1, suffix: '%', help: 'Utilisation mémoire au-delà de laquelle une alerte peut être déclenchée.' },
  { key: 'diskThreshold', label: 'Seuil volume', min: 1, max: 100, step: 1, suffix: '%', help: 'Alerte dès qu’un volume atteint ce pourcentage d’utilisation.' },
  { key: 'smartTemperatureThreshold', label: 'Seuil température SMART', min: 1, max: 150, step: 1, suffix: '°C', help: 'Alerte de température pour un disque sélectionné.' },
  { key: 'smartWearThreshold', label: 'Seuil usure NVMe SMART', min: 1, max: 1000, step: 1, suffix: '%', help: 'Alerte d’usure NVMe ; le pourcentage utilisé peut dépasser 100 %.' },
  { key: 'sustainedMinutes', label: 'Durée CPU / mémoire', min: 1, max: 60, step: 1, suffix: 'minutes', help: 'Durée continue requise avant de lever une alerte CPU ou mémoire.' },
];

function formOf(s: HealthSettingsValues): Form {
  return {
    systemIntervalSeconds: s.systemIntervalSeconds,
    diskIntervalSeconds: s.diskIntervalSeconds,
    smartIntervalSeconds: s.smartIntervalSeconds,
    cpuThreshold: s.cpuThreshold,
    memoryThreshold: s.memoryThreshold,
    diskThreshold: s.diskThreshold,
    smartTemperatureThreshold: s.smartTemperatureThreshold,
    smartWearThreshold: s.smartWearThreshold,
    sustainedMinutes: s.sustainedMinutes,
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
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          Les catégories sont collectées indépendamment. La courbe affichée couvre la dernière heure ; MongoDB conserve les échantillons pendant 48 h puis les purge automatiquement.
          Les disques SMART sont activés hôte par hôte et ne doivent pas inclure de disques virtualisés.
        </p>
        <div className="grid gap-3 lg:grid-cols-2">
          {fields.map(({ key, label, min, max, step, suffix, help }) => (
            <label key={key} className="rounded-md border border-line bg-raised/30 p-3">
              <span className="mb-1 block text-sm font-medium text-zinc-100">{label}</span>
              <span className="flex items-center gap-2">
                <input
                  className="input w-32"
                  type="number"
                  min={min}
                  max={max}
                  step={step ?? 1}
                  value={form[key]}
                  onChange={(event) => setDraft({ ...form, [key]: Number(event.target.value) })}
                />
                <span className="text-xs text-muted">{suffix}</span>
              </span>
              <span className="mt-2 block text-xs text-muted">{help}</span>
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={!dirty || saving} onClick={discard}>Annuler</Button>
          <Button loading={saving} disabled={!dirty} onClick={() => void save()}>Enregistrer</Button>
        </div>
      </div>
    </Panel>
  );
}
