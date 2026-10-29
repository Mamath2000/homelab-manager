import clsx from 'clsx';
import type { HealthEnabled, HealthEnabledKey } from '../lib/api';
import { THRESHOLD_ROWS, type ThresholdForm, type ThresholdKey, type ThresholdRow } from '../lib/healthThresholds';

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={checked ? 'Alertes actives' : 'Alertes désactivées'}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-emerald-500 bg-emerald-500' : 'border-line bg-raised',
      )}
    >
      <span className={clsx('inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

// A number with its unit inside the field; amber when it differs from the reference (the global value).
function Field({ title, unit, value, onChange, min, max, step, disabled, dim, reference }: {
  title: string; unit: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; disabled?: boolean; dim?: boolean; reference?: number;
}) {
  const changed = reference !== undefined && value !== reference;
  return (
    <label className={clsx('block min-w-0', dim && 'opacity-50')}>
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-muted md:hidden">{title}</span>
      <span className="relative block">
        <input
          className={clsx('input w-full pr-10 text-right tabular-nums', changed && 'border-amber-400/70')}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={title}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted">{unit}</span>
      </span>
    </label>
  );
}

const differs = (r: ThresholdRow, f: ThresholdForm, ref: ThresholdForm) =>
  [r.warning, r.alert, ...(r.duration ? [r.duration] : []), ...(r.rearm ? [r.rearm] : [])].some((k) => f[k] !== ref[k]);
const defaultsOf = (r: ThresholdRow, ref: ThresholdForm, unit: string) =>
  `${ref[r.warning]} / ${ref[r.alert]} ${unit}${r.duration ? ` · ${ref[r.duration] ? `${ref[r.duration]} min` : 'immédiat'}` : ''}${r.rearm ? ` · réactivation ${ref[r.rearm] ? `${ref[r.rearm]} min` : 'aucune'}` : ''}`;
const unitOf = (suffix: string) => (suffix === '× CPU' ? '×' : suffix);
const HINTS: Partial<Record<ThresholdRow['warning'], string>> = {
  loadWarningThreshold: 'load5 ÷ nombre de CPU',
  diskWarningThreshold: 'immédiat · dernier champ : délai de réactivation après la levée',
};

// The threshold rows, shared by the global settings and the per-host dialog. With `enabled`, each row has an on/off
// switch; with `reference` (global values), a value that differs from it is flagged.
export function ThresholdFields({ form, onChange, enabled, onEnabledChange, reference, hide, disabled }: {
  form: ThresholdForm;
  onChange: (key: ThresholdKey, value: number) => void;
  enabled?: HealthEnabled;
  onEnabledChange?: (key: HealthEnabledKey, value: boolean) => void;
  reference?: ThresholdForm;
  hide?: { disks?: boolean; smart?: boolean };
  disabled?: boolean;
}) {
  // label | warning | alerte | durée | [défaut global] | [actif]
  const cols = clsx(
    'md:[grid-template-columns:minmax(11rem,1.4fr)_repeat(3,minmax(7rem,9rem))]',
    reference && enabled ? 'md:[grid-template-columns:minmax(11rem,1.4fr)_repeat(3,minmax(7rem,9rem))_minmax(8rem,1fr)_4rem]'
      : enabled ? 'md:[grid-template-columns:minmax(11rem,1.4fr)_repeat(3,minmax(7rem,9rem))_4rem]' : '',
  );
  const rows = THRESHOLD_ROWS.filter((r) => !(r.group && hide?.[r.group]));
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <div className={clsx('hidden gap-3 border-b border-line bg-raised/40 px-4 py-2 text-[11px] uppercase tracking-wide text-muted md:grid', cols)}>
        <span>Indicateur</span><span className="text-right">Warning</span><span className="text-right">Alerte</span><span className="text-right" title="Volumes : délai de réactivation">Durée</span>
        {reference && <span>Défaut global</span>}
        {enabled && <span className="text-center">Actif</span>}
      </div>
      <ul className="divide-y divide-line">
        {rows.map((r) => {
          const on = enabled ? enabled[r.enabled] : true;
          const unit = unitOf(r.suffix);
          const field = (key: ThresholdKey, title: string, u: string, min: number, max: number, step?: number) => (
            <Field title={title} unit={u} value={form[key]} onChange={(v) => onChange(key, v)} min={min} max={max} step={step} disabled={disabled || !on} dim={!on} reference={reference?.[key]} />
          );
          return (
            <li key={r.label} className={clsx('grid grid-cols-2 items-center gap-x-3 sm:grid-cols-3 gap-y-2 px-4 py-3 md:items-center', cols)}>
              <div className="min-w-0 sm:col-span-2 md:col-span-1">
                <p className={clsx('text-sm font-medium', on ? 'text-zinc-100' : 'text-muted')}>{r.label}</p>
                {HINTS[r.warning] && <p className="text-xs text-muted">{HINTS[r.warning]}</p>}
              </div>
              {enabled && (
                <div className="flex justify-end md:order-last md:justify-center">
                  <Switch checked={on} disabled={disabled} label={`Alertes ${r.label}`} onChange={(v) => onEnabledChange?.(r.enabled, v)} />
                </div>
              )}
              <div className="contents">
                {field(r.warning, 'Warning', unit, r.min ?? 1, r.max, r.step)}
                {field(r.alert, 'Alerte', unit, r.min ?? 1, r.max, r.step)}
                {r.duration ? field(r.duration, 'Durée', 'min', 0, r.durationMax ?? 2880) : r.rearm ? field(r.rearm, 'Réactivation', 'min', 0, r.durationMax ?? 2880) : <span className="self-center text-right text-xs text-muted">immédiat</span>}
              </div>
              {reference && (
                <p className={clsx('col-span-2 text-xs sm:col-span-3 md:col-span-1', differs(r, form, reference) ? 'text-amber-300' : 'text-muted')}>
                  <span className="md:hidden">Défaut : </span>{defaultsOf(r, reference, unit)}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
