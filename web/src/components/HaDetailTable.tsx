import type { ReactNode } from 'react';
import { Check, Minus } from 'lucide-react';
import type { HaSection } from '../lib/api';
import { HA_SECTIONS } from '../lib/haDetail';

// One choice of level: the sections it publishes; null: nothing at all (host set to « Aucun »).
export interface HaColumn {
  id: string;
  label: string;
  hint?: string;
  sections: HaSection[] | null;
}

const CUSTOM = { id: 'custom', label: 'Personnalisé', hint: 'Catégories au choix' };

// Levels × categories of the entities published to Home Assistant (Paramètres > Home Assistant, host options,
// group edit): a selector on top, the table below; the last column, « Personnalisé », is ticked by hand.
// onChange: the column picked, with the sections of the custom column (those of the current column when switching to it).
export function HaDetailTable({ title, columns, rows, value, custom, disabled, onChange, children }: {
  title: string;
  columns: HaColumn[];
  rows: HaSection[];
  value: string;
  custom: HaSection[];
  disabled?: Partial<Record<HaSection, string>>; // rows that do not apply: reason, shown greyed with the custom box locked
  onChange: (id: string, custom: HaSection[]) => void;
  children?: ReactNode; // below the table: preview of the count
}) {
  const all = [...columns, { ...CUSTOM, sections: custom }];
  const current = all.find((c) => c.id === value)?.sections ?? [];
  const pick = (id: string) => onChange(id, id === 'custom' && value !== 'custom' ? rows.filter((s) => current.includes(s)) : custom);
  const toggle = (id: HaSection, on: boolean) => onChange('custom', rows.filter((s) => (s === id ? on : current.includes(s))));
  const shade = (id: string) => (value === id ? 'bg-emerald-500/5' : '');
  const sections = HA_SECTIONS.filter((s) => rows.includes(s.id));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-zinc-100">{title}</span>
        <div role="radiogroup" aria-label={title} className="inline-flex flex-wrap overflow-hidden rounded-md border border-line">
          {all.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={value === c.id}
              title={c.hint}
              onClick={() => pick(c.id)}
              className={`px-3 py-1.5 text-sm transition ${value === c.id ? 'bg-emerald-500/15 font-medium text-emerald-300' : 'text-zinc-400 hover:bg-raised/60 hover:text-zinc-100'}`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line">
              <th className="px-3 py-2 text-left text-xs font-medium text-muted">Catégorie</th>
              {all.map((c) => (
                <th key={c.id} className={`px-3 py-2 text-center ${shade(c.id)}`}>
                  <label className="flex cursor-pointer flex-col items-center gap-1" title={c.hint}>
                    <input type="radio" name={`ha-level-${title}`} className="accent-emerald-500" checked={value === c.id} onChange={() => pick(c.id)} />
                    <span className={`text-xs font-medium ${value === c.id ? 'text-emerald-300' : 'text-zinc-300'}`}>{c.label}</span>
                  </label>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-line/60">
              <td className="px-3 py-2">
                <span className="block text-zinc-200">État et alertes des hôtes</span>
                <span className="block text-xs text-muted">Toujours publiés, sauf pour un hôte réglé sur « Aucun »</span>
              </td>
              {all.map((c) => (
                <td key={c.id} className={`px-3 py-2 text-center ${shade(c.id)}`}>
                  {c.sections ? <Check className="mx-auto h-4 w-4 text-zinc-500" /> : <Minus className="mx-auto h-4 w-4 text-zinc-600" />}
                </td>
              ))}
            </tr>
            {sections.map((sec) => (
              <tr key={sec.id} className={`border-b border-line/60 ${disabled?.[sec.id] ? 'opacity-50' : ''}`} title={disabled?.[sec.id]}>
                <td className="px-3 py-2">
                  <span className="block text-zinc-200">{sec.label}</span>
                  <span className="block text-xs text-muted">{sec.hint}</span>
                </td>
                {all.map((c) => (
                  <td key={c.id} className={`px-3 py-2 text-center ${shade(c.id)}`}>
                    {c.id === 'custom' ? (
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-emerald-500"
                        aria-label={`${sec.label} (personnalisé)`}
                        disabled={!!disabled?.[sec.id]}
                        checked={!disabled?.[sec.id] && (value === 'custom' ? custom : current).includes(sec.id)}
                        onChange={(e) => toggle(sec.id, e.target.checked)}
                      />
                    ) : c.sections?.includes(sec.id) ? (
                      <Check className="mx-auto h-4 w-4 text-emerald-400" />
                    ) : (
                      <Minus className="mx-auto h-4 w-4 text-zinc-600" />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {children}
    </div>
  );
}
