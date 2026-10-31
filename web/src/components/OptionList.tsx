import { useState } from 'react';
import clsx from 'clsx';
import { field } from './ProxmoxServer';

export interface OptionItem {
  value: string;
  label: string;
  detail?: string;
  off?: boolean;
  warn?: boolean;
}

// Choice among a few items, as rows (a filter above ten of them)
export function OptionList({ label, value, onChange, items, hint, search }: { label: string; value: string; onChange: (v: string) => void; items: OptionItem[]; hint?: string; search?: boolean }) {
  const [q, setQ] = useState('');
  const shown = q.trim() ? items.filter((i) => `${i.label} ${i.detail ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())) : items;
  return (
    <fieldset className="flex min-h-0 flex-col gap-1.5">
      <legend className={field}>{label}</legend>
      {search && items.length > 8 && <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrer…" aria-label="Filtrer" />}
      <div className="flex max-h-72 min-h-0 flex-col gap-1.5 overflow-y-auto lg:max-h-none lg:flex-1" role="radiogroup" aria-label={label}>
        {shown.map((i) => {
          const on = i.value === value;
          return (
            <button
              key={i.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(i.value)}
              className={clsx('flex shrink-0 flex-col rounded-md border px-3 py-2 text-left transition-colors', on ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-line bg-raised/40 hover:border-zinc-600 hover:bg-raised', i.off && !on && 'opacity-60')}
            >
              <span className={clsx('text-sm font-medium', on ? 'text-emerald-300' : i.warn ? 'text-amber-300' : 'text-zinc-200')}>{i.label}</span>
              {i.detail && <span className="font-mono text-xs text-muted">{i.detail}</span>}
            </button>
          );
        })}
        {!shown.length && <p className="text-xs text-muted">Aucun résultat.</p>}
      </div>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </fieldset>
  );
}
