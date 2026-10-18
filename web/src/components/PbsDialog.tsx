import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { Badge } from './ui';

// Building blocks of the two PBS windows (main and secondary): 16:9, vertical tabs, the host of the PBS
// first; what its agent detected is shown as text, never as a field to type in.

// Values given by the agent of the PBS (Détecter): read, not typed.
export function DetectedRows({ rows }: { rows: { label: string; value?: string; empty?: string }[] }) {
  return (
    <div className="rounded-md border border-line bg-raised/30">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-xs font-medium text-muted">Donné par l’agent de l’hôte</span>
        <Badge tone="neutral">détecté</Badge>
      </div>
      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
        {rows.map(({ label, value, empty }) => (
          <div key={label} className="contents">
            <dt className="text-xs leading-5 text-muted">{label}</dt>
            <dd className="min-w-0 font-mono text-xs leading-5 break-all text-zinc-200">{value || <span className="font-sans text-zinc-500">{empty ?? '—'}</span>}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// A tab that needs the host of the PBS first.
export function NeedsHost({ onGo }: { onGo: () => void }) {
  return (
    <p className="text-sm text-amber-400">
      Relier d’abord le PBS à son agent :{' '}
      <button type="button" className="underline underline-offset-2 hover:text-amber-300" onClick={onGo}>onglet Hôte</button>.
    </p>
  );
}

// State of a tab, in the list of tabs: done, or still to do.
export function TabMark({ done }: { done: boolean }) {
  return done ? <CircleCheck className="h-4 w-4 text-emerald-400" /> : <CircleAlert className="h-4 w-4 text-amber-400" />;
}

// Title and short explanation of a tab.
export function TabHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="font-medium text-zinc-100">{title}</p>
      {children && <p className="text-xs text-muted">{children}</p>}
    </div>
  );
}
