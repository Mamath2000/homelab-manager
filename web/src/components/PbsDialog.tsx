import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Check } from 'lucide-react';
import type { StepState } from '../lib/steps';

// Building blocks of the two PBS windows (main and secondary): 16:9, four steps from left to right
// (host of the PBS and Détecter, what its agent found, tokens, test). The first step not done is the
// one to do now (stepStates); the ones after it are dimmed. What the agent detected is shown as text,
// never as a field to type in.

// fill: the steps take the whole height of a fixed window (Modal fixed), their lists scroll inside
// threeCols: three steps, the last one wider (add host)
export function Steps({ children, fill, threeCols }: { children: ReactNode; fill?: boolean; threeCols?: boolean }) {
  return (
    <div className={clsx('grid gap-3 sm:grid-cols-2', threeCols ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.7fr)]' : 'lg:grid-cols-4', fill ? 'lg:h-full lg:grid-rows-[minmax(0,1fr)]' : 'lg:min-h-full')}>{children}</div>
  );
}

// One step: number (a check once done), title, short explanation, content; footer: its action, at the bottom.
export function Step({ n, title, state, intro, children, footer }: {
  n: number;
  title: string;
  state: StepState;
  intro?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section
      className={clsx(
        'flex min-h-0 min-w-0 flex-col gap-3 rounded-lg border p-4 text-sm',
        state === 'active' ? 'border-emerald-500/50 bg-raised/60' : 'border-line bg-raised/20',
        state === 'todo' && 'opacity-50',
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={clsx(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
            state === 'done' ? 'bg-emerald-600 text-white' : state === 'active' ? 'border border-emerald-400 text-emerald-400' : 'border border-zinc-600 text-muted',
          )}
        >
          {state === 'done' ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : n}
        </span>
        <h4 className="font-medium text-zinc-100">{title}</h4>
      </div>
      {intro && <p className="text-xs text-muted">{intro}</p>}
      {/* in a fixed window (Steps fill) the content scrolls between the intro and the footer; a list inside may scroll itself (flex-1 min-h-0) */}
      {children && <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1">{children}</div>}
      {footer && <div className="mt-auto space-y-2 pt-1">{footer}</div>}
    </section>
  );
}

// Values given by the agent of the PBS (Détecter): read, not typed.
export function DetectedRows({ rows }: { rows: { label: string; value?: string; empty?: string }[] }) {
  return (
    <dl className="space-y-2.5">
      {rows.map(({ label, value, empty }) => (
        <div key={label}>
          <dt className="text-xs text-muted">{label}</dt>
          <dd className="mt-0.5 font-mono text-xs break-all text-zinc-200">{value || <span className="font-sans text-zinc-500">{empty ?? '—'}</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export type CheckState = { level: 'ok' | 'info' | 'warn' | 'error'; title: string; detail?: string } | null;

// One line of the result of a test: what was tried (label) and what came of it; null: not tried yet
// (idle says what will be). info: not tried on purpose, shown dashed, never as an error.
export function CheckLine({ label, check, idle }: { label: string; check: CheckState; idle?: string }) {
  const tone = check
    ? { ok: 'border-emerald-500/40 bg-emerald-500/5 text-emerald-400', info: 'border-dashed border-zinc-700 text-zinc-300', warn: 'border-amber-500/40 bg-amber-500/5 text-amber-400', error: 'border-red-500/40 bg-red-500/5 text-red-400' }[check.level]
    : 'border-line text-zinc-400';
  return (
    <div className={clsx('space-y-0.5 rounded-md border px-3 py-2', tone)}>
      <p className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</p>
      <p className="font-medium">{check ? check.title : 'Pas encore testé'}</p>
      {(check ? check.detail : idle) && <p className="text-xs break-all text-muted">{check ? check.detail : idle}</p>}
    </div>
  );
}
