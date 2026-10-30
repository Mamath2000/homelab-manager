import type { ReactNode } from 'react';
import clsx from 'clsx';

// One cell of the strip at the top of a host or an equipment page: the label on one line, the value on two lines at most (the full text in the tooltip).
export function StripItem({ label, grow, plain, children }: { label: string; grow?: boolean; plain?: boolean; children: ReactNode }) {
  return (
    <div className={clsx('min-w-0 shrink border-r border-line px-4 py-2.5 last:border-r-0', grow && 'flex-1 basis-40')}>
      <dt className="truncate text-[11px] font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd
        onMouseEnter={(e) => { const el = e.currentTarget; el.title = el.scrollHeight > el.clientHeight + 1 ? (el.textContent ?? '') : ''; }}
        className={clsx('mt-0.5 text-sm text-zinc-200', plain ? 'flex max-h-[3.25rem] flex-wrap gap-1 overflow-hidden' : 'line-clamp-2 break-words')}
      >
        {children}
      </dd>
    </div>
  );
}
