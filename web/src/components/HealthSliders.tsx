import clsx from 'clsx';

const THUMB = 18;
// Position of a value on the rail: the native thumb centre travels from THUMB/2 to width − THUMB/2.
const at = (p: number) => `calc(${p}% + ${((0.5 - p / 100) * THUMB).toFixed(2)}px)`;

// Two handles on one rail split into normal / warning / alert zones. Warning stays under alert (one step apart at least).
export function RangeSlider({ min, max, step, warning, alert, format, current, onChange, disabled }: {
  min: number; max: number; step: number; warning: number; alert: number;
  format: (v: number) => string;
  // current value of the fleet, drawn as a tick
  current?: number;
  onChange: (warning: number, alert: number) => void;
  disabled?: boolean;
}) {
  // a stored value outside the usual scale widens it instead of being clipped
  const lo = Math.min(min, warning);
  const hi = Math.max(max, alert);
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const pw = pct(warning);
  const pa = pct(alert);
  const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
  const common = { min: lo, max: hi, step, disabled, className: 'range-thumb absolute inset-0 h-full w-full' };
  return (
    <div className="relative h-14 select-none">
      <div className="absolute inset-x-0 top-8 h-1.5 overflow-hidden rounded-full">
        <span className="absolute inset-y-0 left-0 bg-emerald-900" style={{ width: at(pw) }} />
        <span className="absolute inset-y-0 bg-amber-700" style={{ left: at(pw), width: `calc(${at(pa)} - ${at(pw)})` }} />
        <span className="absolute inset-y-0 right-0 bg-red-800" style={{ left: at(pa) }} />
      </div>
      {current !== undefined && current >= lo && current <= hi && (
        <span className="absolute top-[26px] h-3.5 w-0.5 -translate-x-1/2 rounded bg-zinc-400" style={{ left: at(pct(current)) }} title={`Valeur actuelle : ${format(current)}`} />
      )}
      <span className="absolute top-0 -translate-x-1/2 rounded bg-amber-400 px-1.5 text-[11px] font-semibold text-zinc-950" style={{ left: at(pw) }}>{format(warning)}</span>
      <span className="absolute top-0 -translate-x-1/2 rounded bg-red-500 px-1.5 text-[11px] font-semibold text-zinc-950" style={{ left: at(pa), marginTop: pa - pw < 9 ? 18 : 0 }}>{format(alert)}</span>
      <div className="absolute inset-x-0 top-[26px] h-[18px]">
        <input {...common} type="range" aria-label="Seuil Warning" value={warning} style={{ '--thumb': '#fbbf24', zIndex: pw > 50 ? 30 : 10 } as React.CSSProperties}
          onChange={(e) => onChange(Math.min(Number(e.target.value), alert - step), alert)} />
        <input {...common} type="range" aria-label="Seuil Alerte" value={alert} style={{ '--thumb': '#ef4444', zIndex: 20 } as React.CSSProperties}
          onChange={(e) => onChange(warning, Math.max(Number(e.target.value), warning + step))} />
      </div>
      <div className="absolute inset-x-0 top-12 text-[10px] text-zinc-600">
        {ticks.map((t, i) => <span key={i} className="absolute -translate-x-1/2" style={{ left: at(pct(t)) }}>{Number.isInteger(t) ? t : t.toFixed(1)}</span>)}
      </div>
    </div>
  );
}

// One handle over a list of allowed values (seconds). A stored value that is not in the list is kept as an extra stop.
export function StepSlider({ values, value, format, onChange }: { values: number[]; value: number; format: (v: number) => string; onChange: (v: number) => void }) {
  const stops = [...new Set([...values, value])].sort((a, b) => a - b);
  const index = stops.indexOf(value);
  const p = (index / (stops.length - 1)) * 100;
  return (
    <div>
      <div className="relative h-10">
        <div className="absolute inset-x-0 top-5 h-1.5 overflow-hidden rounded-full bg-line"><span className="absolute inset-y-0 left-0 bg-emerald-400" style={{ width: at(p) }} /></div>
        <span className="absolute top-0 -translate-x-1/2 rounded bg-emerald-300 px-1.5 text-[11px] font-semibold text-zinc-950" style={{ left: at(p) }}>{format(value)}</span>
        <div className="absolute inset-x-0 top-[17px] h-[18px]">
          <input type="range" className="range-thumb absolute inset-0 h-full w-full" min={0} max={stops.length - 1} step={1} value={index} aria-label="Fréquence"
            onChange={(e) => onChange(stops[Number(e.target.value)])} />
        </div>
      </div>
      <div className="relative flex justify-between text-[11px] text-muted">{stops.map((s) => <span key={s} className={clsx(s === value && 'text-zinc-200')}>{format(s)}</span>)}</div>
    </div>
  );
}

export function Stepper({ value, onChange, min, max, step = 1, unit, label, disabled }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number; unit: string; label: string; disabled?: boolean }) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, Number((Math.round(v / step) * step).toFixed(4)))));
  const btn = 'inline-flex h-8 w-8 items-center justify-center bg-raised text-zinc-300 hover:text-white disabled:opacity-40';
  return (
    <span className="inline-flex items-center overflow-hidden rounded-md border border-line">
      <button type="button" className={btn} aria-label={`${label} : moins`} disabled={disabled || value <= min} onClick={() => set(value - step)}>−</button>
      <input disabled={disabled} className="h-8 w-16 border-x border-line bg-bg text-center text-sm tabular-nums text-zinc-100 outline-none" type="number" aria-label={label} min={min} max={max} step={step} value={value}
        onChange={(e) => set(Number(e.target.value))} />
      <span className="px-2 text-xs text-muted">{unit}</span>
      <button type="button" className={btn} aria-label={`${label} : plus`} disabled={disabled || value >= max} onClick={() => set(value + step)}>+</button>
    </span>
  );
}
