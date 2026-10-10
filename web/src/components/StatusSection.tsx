import { Children, type ReactNode } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { ArrowRight, type LucideIcon } from 'lucide-react';
import { toneText, type Tone } from '../lib/status';
import { StatusRing } from './StatusRing';

export interface Stat {
  label: string;
  value: number;
  tone: Tone;
  // counted in the list but not drawn in the ring (non exclusive states)
  ringless?: boolean;
}

// Dashboard row: cards on the left, counters + ring on the right (on top on mobile).
export function StatusSection({ icon: Icon, title, to, stats, cardsTitle, cardsIcon: CardsIcon, children, empty }: {
  icon: LucideIcon;
  title: string;
  to: string;
  stats: Stat[];
  cardsTitle: string;
  cardsIcon: LucideIcon;
  children: ReactNode;
  empty?: ReactNode;
}) {
  return (
    <section className="panel grid overflow-hidden md:grid-cols-[1fr_288px]">
      <Link to={to} className="flex items-center justify-between gap-4 border-b border-line p-5 transition hover:bg-raised/40 md:order-last md:border-b-0 md:border-l">
        <div className="min-w-0">
          <h2 className="mb-4 flex items-center gap-2 whitespace-nowrap text-sm font-medium text-zinc-100">
            <Icon className="h-4 w-4 text-zinc-300" />
            {title}
          </h2>
          <ul className="space-y-1.5 text-xs">
            {stats.map((s) => (
              <li key={s.label} className="flex items-center gap-3">
                <span className={clsx('w-6 shrink-0 text-right font-semibold tabular-nums', s.value > 0 ? toneText[s.tone] : 'text-zinc-600')}>
                  {s.value}
                </span>
                <span className={clsx('whitespace-nowrap', s.value > 0 ? 'text-zinc-300' : 'text-zinc-500')}>{s.label}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="shrink-0"><StatusRing segments={stats.filter((s) => !s.ringless)} size={96} /></div>
      </Link>
      <div className="min-w-0 p-5">
        <h3 className="mb-3 flex items-center gap-2 text-sm text-muted">
          <CardsIcon className="h-4 w-4" />
          {cardsTitle}
        </h3>
        {empty ?? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 max-sm:[&>*:nth-child(n+3)]:hidden sm:max-xl:[&>*:nth-child(n+5)]:hidden xl:max-2xl:[&>*:nth-child(n+7)]:hidden 2xl:[&>*:nth-child(n+9)]:hidden">
              {children}
            </div>
            <MoreLink to={to} count={Children.toArray(children).length} />
          </>
        )}
      </div>
    </section>
  );
}

// Cards are limited to two rows (2, 4, 6 or 8 depending on the columns): link to the full page
// when some are hidden at the current width.
function MoreLink({ to, count }: { to: string; count: number }) {
  if (count <= 2) return null;
  return (
    <Link
      to={to}
      className={clsx(
        'mt-3 items-center gap-1.5 text-xs text-muted transition hover:text-zinc-200',
        'flex',
        count > 4 ? 'sm:flex' : 'sm:hidden',
        count > 6 ? 'xl:flex' : 'xl:hidden',
        count > 8 ? '2xl:flex' : '2xl:hidden',
      )}
    >
      Voir tout ({count}) <ArrowRight className="h-3.5 w-3.5" />
    </Link>
  );
}

export function ItemCard({ to, icon: Icon, tone, title, right, children }: {
  to: string;
  icon: LucideIcon;
  tone: Tone;
  title: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Link to={to} className="group flex min-w-0 flex-col gap-2.5 rounded-md border border-line bg-raised/40 p-3.5 transition hover:border-zinc-600 hover:bg-raised">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2.5">
          <Icon className={clsx('h-4 w-4 shrink-0', toneText[tone])} />
          <span className="truncate text-sm font-medium text-zinc-100">{title}</span>
        </span>
        {right}
      </div>
      {children && <div className="flex flex-wrap gap-1.5">{children}</div>}
    </Link>
  );
}
