import clsx from 'clsx';
import { type ThresholdForm, type ThresholdKey, type ThresholdRow } from '../lib/healthThresholds';
import { SCALES, num } from '../lib/healthScales';
import { RangeSlider, Stepper } from './HealthSliders';
import { Switch } from './HealthThresholdsForm';

// With `host`: the alerts of the indicator can be switched off and the global default is shown (amber when this host differs).
export function Indicator({ row, form, set, host }: {
  row: ThresholdRow;
  form: ThresholdForm;
  set: (key: ThresholdKey, value: number) => void;
  host?: { enabled: boolean; onEnabled: (v: boolean) => void; reference?: ThresholdForm; disabled?: boolean };
}) {
  const sc = SCALES[row.warning];
  const w = form[row.warning];
  const a = form[row.alert];
  const durKey = row.duration ?? row.rearm!;
  const d = form[durKey];
  const unit = sc.unit;
  const durLabel = row.rearm ? 'Délai de réactivation' : 'Pendant au moins';
  const bad = w >= a;
  const max = row.max;
  const ref = host?.reference;
  const off = !!host && !host.enabled;
  const frozen = !!host?.disabled || off;
  const keys: ThresholdKey[] = [row.warning, row.alert, durKey];
  const differs = !!ref && keys.some((k) => form[k] !== ref[k]);
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-zinc-100">{row.label}</h3>
          <p className="text-sm text-muted">{sc.what}</p>
        </div>
        {host && (
          <label className="flex shrink-0 items-center gap-2 text-xs text-muted">
            Alertes {host.enabled ? 'actives' : 'désactivées'}
            <Switch checked={host.enabled} disabled={host.disabled} label={`Alertes ${row.label}`} onChange={host.onEnabled} />
          </label>
        )}
      </div>
      <div className={clsx('space-y-4', frozen && 'opacity-60')}>
      <div>
        <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">Seuils</p>
        <RangeSlider min={sc.min} max={sc.max} step={sc.step} warning={w} alert={a} format={(v) => num(v, unit)} disabled={frozen}
          onChange={(nw, na) => { set(row.warning, nw); set(row.alert, na); }} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-line border-l-2 border-l-amber-400 bg-raised/30 px-3 py-2.5">
          <p className="mb-1.5 text-xs text-muted">Warning à partir de</p>
          <Stepper label="Warning" value={w} min={row.min ?? 1} max={max} step={sc.step} unit={unit} onChange={(v) => set(row.warning, v)} disabled={frozen} />
        </div>
        <div className="rounded-lg border border-line border-l-2 border-l-red-500 bg-raised/30 px-3 py-2.5">
          <p className="mb-1.5 text-xs text-muted">Alerte à partir de</p>
          <Stepper label="Alerte" value={a} min={row.min ?? 1} max={max} step={sc.step} unit={unit} onChange={(v) => set(row.alert, v)} disabled={frozen} />
        </div>
        <div className="rounded-lg border border-line bg-raised/30 px-3 py-2.5">
          <p className="mb-1.5 text-xs text-muted">{durLabel}</p>
          <Stepper label={durLabel} value={d} min={0} max={row.durationMax ?? 2880} unit="min" onChange={(v) => set(durKey, v)} disabled={frozen} />
        </div>
      </div>
      {bad && <p className="text-xs text-red-300">Le seuil Warning doit rester inférieur au seuil Alerte.</p>}
      {ref && (
        <p className={clsx('flex items-center gap-2 text-xs', differs ? 'text-amber-300' : 'text-muted')}>
          Défaut global : {num(ref[row.warning], unit)} / {num(ref[row.alert], unit)} · {ref[durKey] ? `${ref[durKey]} min` : row.rearm ? 'aucune réactivation' : 'immédiat'}
          {differs && !frozen && <button type="button" className="underline hover:text-amber-200" onClick={() => keys.forEach((k) => set(k, ref[k]))}>Revenir au défaut</button>}
        </p>
      )}
      </div>
      {!host && <div>
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
      </div>}
    </div>
  );
}
