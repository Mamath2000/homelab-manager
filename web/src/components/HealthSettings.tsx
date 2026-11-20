import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, Cpu, HardDrive, HeartPulse, SlidersHorizontal, type LucideIcon } from 'lucide-react';
import { api, type HealthSettings as HealthSettingsValues } from '../lib/api';
import { useToast } from '../lib/toast';
import clsx from 'clsx';
import { Button, Panel, Spinner } from './ui';
import { useSettingsDraft } from './settingsDraft';
import { THRESHOLD_ROWS, invalidThreshold, type ThresholdRow } from '../lib/healthThresholds';
import { RangeSlider, StepSlider, Stepper } from './HealthSliders';

type Form = Omit<HealthSettingsValues, 'retentionHours'>;
const fmtSeconds = (s: number) => (s < 60 ? `${s} s` : s < 3600 ? `${s / 60} min` : s <= 86400 ? `${s / 3600} h` : `${s / 86400} j`);
const intervals: { key: keyof Form; label: string; icon: LucideIcon; role: string; feeds: string; hint: string; values: number[] }[] = [
  { key: 'systemIntervalSeconds', label: 'CPU, mémoire et charge Unix', icon: Cpu, role: 'Utilisation processeur, mémoire utilisée et load 1/5/15 de l’hôte.', feeds: 'graphiques et alertes CPU, mémoire, charge', hint: 'recommandé 30 s', values: [10, 30, 60, 300, 900, 3600] },
  { key: 'diskIntervalSeconds', label: 'Utilisation des volumes', icon: HardDrive, role: 'Espace utilisé par volume. Évolue lentement.', feeds: 'alertes d’espace disque', hint: 'recommandé 5 min', values: [60, 300, 900, 3600, 21600, 86400] },
  { key: 'smartIntervalSeconds', label: 'SMART', icon: HeartPulse, role: 'Santé des disques via smartctl, sur ceux activés dans la fiche hôte.', feeds: 'alertes température et usure NVMe', hint: 'recommandé 24 h, sans disque virtualisé', values: [600, 3600, 21600, 86400, 604800, 2592000] },
];
// Per indicator: usual scale of the slider (widened when a stored value goes outside), step, unit and what it measures.
interface Scale { min: number; max: number; step: number; unit: string; what: string; subject: string; duration: string }
const SCALES: Record<string, Scale> = {
  cpuWarningThreshold: { min: 0, max: 100, step: 1, unit: '%', what: 'Utilisation processeur moyenne de l’hôte', subject: 'le CPU', duration: 'Partagée avec la mémoire.' },
  memoryWarningThreshold: { min: 0, max: 100, step: 1, unit: '%', what: 'Mémoire utilisée sur la mémoire totale de l’hôte', subject: 'la mémoire', duration: 'Partagée avec le CPU.' },
  loadWarningThreshold: { min: 0, max: 2, step: 0.05, unit: '×', what: 'load5 rapporté au nombre de CPU, sans alerte sur les conteneurs', subject: 'la charge', duration: 'Propre à la charge Unix.' },
  diskWarningThreshold: { min: 50, max: 100, step: 1, unit: '%', what: 'Espace utilisé par volume. Les seuils sont immédiats ; la durée est un délai de réactivation après la levée', subject: 'un volume', duration: '0 = aucun délai de réactivation.' },
  smartTemperatureWarningThreshold: { min: 30, max: 90, step: 1, unit: '°C', what: 'Température des disques relevée par SMART', subject: 'la température', duration: 'Partagée avec l’usure NVMe.' },
  smartWearWarningThreshold: { min: 0, max: 100, step: 1, unit: '%', what: 'Usure des disques NVMe relevée par SMART', subject: 'l’usure', duration: 'Partagée avec la température.' },
};
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

const barOf = (r: ThresholdRow, f: Form) => {
  const sc = SCALES[r.warning];
  const lo = Math.min(sc.min, f[r.warning]);
  const hi = Math.max(sc.max, f[r.alert]);
  const p = (v: number) => ((v - lo) / (hi - lo)) * 100;
  return { w: p(f[r.warning]), a: p(f[r.alert]) };
};
const num = (v: number, unit: string) => `${String(v).replace('.', ',')} ${unit}`;

function Measures({ form, set }: { form: Form; set: (key: keyof Form, value: number) => void }) {
  return (
    <div className="space-y-2.5">
      <div>
        <h3 className="text-base font-semibold text-zinc-100">Mesures</h3>
        <p className="text-sm text-muted">À quelle fréquence l’agent relève chaque famille d’indicateurs : plus c’est fréquent, plus les alertes sont réactives, mais plus il y a de points stockés.</p>
      </div>
      {intervals.map(({ key, label, icon: Icon, role, feeds, hint, values }) => (
        <div key={key} className="grid items-center gap-x-6 gap-y-2 rounded-lg border border-line bg-raised/30 px-4 py-3 lg:grid-cols-[1fr_22rem]">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium text-zinc-100"><Icon className="h-4 w-4 text-emerald-400" aria-hidden />{label}</p>
            <p className="mt-0.5 text-sm text-zinc-300">{role}</p>
            <p className="mt-1 text-xs text-muted">Alimente : {feeds} · {hint}</p>
          </div>
          <StepSlider values={values} value={form[key]} format={fmtSeconds} onChange={(v) => set(key, v)} />
        </div>
      ))}
    </div>
  );
}

function Indicator({ row, form, set }: { row: ThresholdRow; form: Form; set: (key: keyof Form, value: number) => void }) {
  const sc = SCALES[row.warning];
  const w = form[row.warning];
  const a = form[row.alert];
  const durKey = row.duration ?? row.rearm!;
  const d = form[durKey];
  const unit = sc.unit;
  const durLabel = row.rearm ? 'Délai de réactivation' : 'Pendant au moins';
  const bad = w >= a;
  const max = row.max;
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-zinc-100">{row.label}</h3>
        <p className="text-sm text-muted">{sc.what}</p>
      </div>
      <div>
        <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">Seuils</p>
        <RangeSlider min={sc.min} max={sc.max} step={sc.step} warning={w} alert={a} format={(v) => num(v, unit)}
          onChange={(nw, na) => { set(row.warning, nw); set(row.alert, na); }} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-line border-l-2 border-l-amber-400 bg-raised/30 px-3 py-2.5">
          <p className="mb-1.5 text-xs text-muted">Warning à partir de</p>
          <Stepper label="Warning" value={w} min={row.min ?? 1} max={max} step={sc.step} unit={unit} onChange={(v) => set(row.warning, v)} />
        </div>
        <div className="rounded-lg border border-line border-l-2 border-l-red-500 bg-raised/30 px-3 py-2.5">
          <p className="mb-1.5 text-xs text-muted">Alerte à partir de</p>
          <Stepper label="Alerte" value={a} min={row.min ?? 1} max={max} step={sc.step} unit={unit} onChange={(v) => set(row.alert, v)} />
        </div>
        <div className="rounded-lg border border-line bg-raised/30 px-3 py-2.5">
          <p className="mb-1.5 text-xs text-muted">{durLabel}</p>
          <Stepper label={durLabel} value={d} min={0} max={row.durationMax ?? 2880} unit="min" onChange={(v) => set(durKey, v)} />
        </div>
      </div>
      {bad && <p className="text-xs text-red-300">Le seuil Warning doit rester inférieur au seuil Alerte.</p>}
      <div>
        <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">Ce que ça donne</p>
        <div className="space-y-1 rounded-lg border border-line bg-raised/30 px-4 py-3 text-sm text-zinc-300">
          {row.rearm ? (
            <>
              <p><span className="mr-2 inline-block h-2 w-2 rounded-full bg-amber-400" />Dès que {sc.subject} dépasse <b className="text-zinc-100">{num(w, unit)}</b> → <b className="text-amber-300">warning</b>, immédiatement.</p>
              <p><span className="mr-2 inline-block h-2 w-2 rounded-full bg-red-500" />Au-dessus de <b className="text-zinc-100">{num(a, unit)}</b> → <b className="text-red-300">alerte</b>, immédiatement.</p>
              <p className="text-muted">{d ? `Après la levée, pas de nouvelle alerte au même niveau (ou inférieur) pendant ${d} min.` : 'Aucun délai de réactivation après la levée.'}</p>
            </>
          ) : (
            <>
              <p><span className="mr-2 inline-block h-2 w-2 rounded-full bg-amber-400" />Si {sc.subject} reste <b className="text-zinc-100">au-dessus de {num(w, unit)}</b>{d ? ` pendant ${d} min` : ''} → <b className="text-amber-300">warning</b>.</p>
              <p><span className="mr-2 inline-block h-2 w-2 rounded-full bg-red-500" />Au-dessus de <b className="text-zinc-100">{num(a, unit)}</b>{d ? ` pendant ${d} min` : ''} → <b className="text-red-300">alerte</b>.</p>
              <p className="text-muted">Retour sous le seuil → l’alerte se lève immédiatement. {sc.duration}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function HealthSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error } = useQuery({ queryKey: ['settings', 'health'], queryFn: api.healthSettings });
  const [draft, setDraft] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<'measures' | number>('measures');
  const form = draft ?? (data ? formOf(data) : null);
  const dirty = !!data && !!draft && JSON.stringify(draft) !== JSON.stringify(formOf(data));

  const discard = () => setDraft(null);
  const invalid = form ? invalidThreshold(form) : undefined;
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
  const set = (key: keyof Form, value: number) => setDraft({ ...form, [key]: value });
  const row = selected === 'measures' ? null : THRESHOLD_ROWS[selected];
  const item = (on: boolean) => clsx('w-full rounded-lg px-3 py-2 text-left transition', on ? 'bg-emerald-500/10 ring-1 ring-emerald-500/30' : 'hover:bg-raised/60');
  return (
    <Panel title="Collecte et alertes Santé" icon={Activity}>
      <div className="-mx-5 -my-4 flex h-[min(36rem,calc(100vh-9rem))] flex-col">
        <div className="grid min-h-0 flex-1 md:grid-cols-[17rem_1fr]">
          <nav className="min-h-0 space-y-1 overflow-y-auto border-b border-line p-3 md:border-b-0 md:border-r" aria-label="Réglages Santé">
            <p className="px-3 pb-1 text-[11px] uppercase tracking-wide text-muted">Fréquences</p>
            <button type="button" className={item(selected === 'measures')} onClick={() => setSelected('measures')}>
              <span className={clsx('flex items-center gap-2 text-sm font-medium', selected === 'measures' ? 'text-emerald-300' : 'text-zinc-200')}><SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />Mesures</span>
              <span className="block text-xs text-muted">CPU · volumes · SMART</span>
            </button>
            <p className="px-3 pb-1 pt-3 text-[11px] uppercase tracking-wide text-muted">Indicateurs</p>
            {THRESHOLD_ROWS.map((r, i) => {
              const sc = SCALES[r.warning];
              const bar = barOf(r, form);
              const on = selected === i;
              const bad = form[r.warning] >= form[r.alert];
              return (
                <button key={r.label} type="button" className={item(on)} onClick={() => setSelected(i)}>
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={clsx('truncate text-sm', on ? 'text-emerald-300' : 'text-zinc-200')}>{r.label.replace(' (load5 / CPU)', '').replace(' SMART', '')}</span>
                    <span className={clsx('shrink-0 text-xs tabular-nums', bad ? 'text-red-300' : 'text-muted')}>{num(form[r.warning], '').trim()} / {num(form[r.alert], sc.unit)}</span>
                  </span>
                  <span className="mt-1.5 flex h-1 overflow-hidden rounded-full">
                    <span className="bg-emerald-900" style={{ width: `${Math.max(0, bar.w)}%` }} />
                    <span className="bg-amber-700" style={{ width: `${Math.max(0, bar.a - bar.w)}%` }} />
                    <span className="flex-1 bg-red-800" />
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="min-h-0 overflow-y-auto p-5">
            {row ? <Indicator row={row} form={form} set={set} /> : <Measures form={form} set={set} />}
          </div>
        </div>
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-5 py-3">
          <p className={clsx('text-xs', invalid ? 'text-red-300' : 'text-muted')}>{invalid ? `${invalid} : le seuil Warning doit rester inférieur au seuil Alerte.` : 'Le seuil Warning reste inférieur au seuil Alerte.'}</p>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={!dirty || saving} onClick={discard}>Annuler</Button>
            <Button loading={saving} disabled={!dirty || !!invalid} onClick={() => void save()}>Enregistrer</Button>
          </div>
        </footer>
      </div>
    </Panel>
  );
}
