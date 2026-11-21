import type { ReactNode } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronUp, type LucideIcon } from 'lucide-react';
import { gaugeLevel, type CardInfo, type CardLevel, type CardState, type CardVisual } from '../lib/hostCards';
import { Badge } from './ui';
import type { Tone } from '../lib/status';

const levelLabel: Record<CardLevel, string> = { ok: 'OK', warn: 'Avertissement', alert: 'Alerte', none: 'Info' };
const levelTone: Record<CardLevel, Tone> = { ok: 'ok', warn: 'warn', alert: 'bad', none: 'neutral' };
const rail: Record<CardLevel, string> = { ok: 'bg-emerald-500', warn: 'bg-amber-400', alert: 'bg-red-500', none: 'bg-zinc-600' };
const iconBox: Record<CardLevel, string> = {
  ok: 'bg-emerald-500/10 text-emerald-400',
  warn: 'bg-amber-500/10 text-amber-400',
  alert: 'bg-red-500/10 text-red-400',
  none: 'bg-zinc-500/10 text-zinc-400',
};
const textTone: Record<CardLevel, string> = { ok: 'text-muted', warn: 'text-amber-300', alert: 'text-red-300', none: 'text-muted' };
const tint: Record<CardLevel, string> = {
  ok: '',
  none: '',
  warn: 'bg-gradient-to-r from-amber-500/10 to-transparent to-60%',
  alert: 'bg-gradient-to-r from-red-500/10 to-transparent to-60%',
};
const cell: Record<CardLevel, string> = { ok: 'bg-emerald-500/60', warn: 'bg-amber-400', alert: 'bg-red-500', none: 'bg-raised' };

function Visual({ visual }: { visual?: CardVisual }) {
  if (!visual) return null;
  switch (visual.kind) {
    case 'bars':
      return (
        <div className="flex items-end gap-2">
          {visual.items.map((i) => (
            <div key={i.label} className="flex flex-col items-center gap-0.5 text-[9.5px] text-muted" title={`${i.label} ${Math.round(i.percent)} %`}>
              <span className="relative block h-8 w-3 overflow-hidden rounded-[3px] bg-raised">
                <span className={clsx('absolute inset-x-0 bottom-0', cell[gaugeLevel(i.percent)])} style={{ height: `${Math.min(100, Math.max(3, i.percent))}%` }} />
              </span>
              {i.label}
            </div>
          ))}
        </div>
      );
    case 'battery':
      return (
        <div className="w-32 text-right">
          <span className="font-mono text-base font-semibold text-zinc-100">{Math.round(visual.percent)} %</span>
          <span className="ml-1 text-[11px] text-muted">batterie</span>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-raised">
            <div className={clsx('h-full', visual.percent < 20 ? cell.alert : visual.percent < 50 ? cell.warn : cell.ok)} style={{ width: `${visual.percent}%` }} />
          </div>
        </div>
      );
    case 'dots':
      return (
        <div className="flex max-w-36 flex-wrap justify-end gap-1.5">
          {visual.levels.slice(0, 12).map((l, i) => <span key={i} className={clsx('h-3.5 w-3.5 rounded-[4px]', cell[l])} />)}
        </div>
      );
    case 'days':
      return (
        <div className="w-36">
          <div className="grid grid-cols-[repeat(14,minmax(0,1fr))] gap-0.5">
            {visual.levels.map((l, i) => <span key={i} className={clsx('h-5 rounded-[2px]', l === 'none' ? 'bg-raised' : cell[l])} />)}
          </div>
          <div className="mt-0.5 text-right text-[10.5px] text-muted">14 derniers jours</div>
        </div>
      );
    case 'count':
      return (
        <div className="text-right">
          <div className={clsx('font-mono text-2xl font-semibold leading-none', visual.value === '—' ? 'text-zinc-500' : 'text-zinc-100')}>{visual.value}</div>
          <div className="mt-0.5 text-[10.5px] text-muted">{visual.label}</div>
        </div>
      );
  }
}

// One card of the host page: reduced it is a row of fixed height (level, short text, small visual); a click opens the
// complete card in place, which then keeps its own header and actions.
export function HostCard({ title, icon: Icon, state, info, text, expanded, onToggle, children }: {
  title: string;
  icon: LucideIcon;
  state: CardState;
  info: CardInfo;
  text: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  if (expanded) {
    return (
      <div>
        <div className="mb-1 flex justify-end">
          <button type="button" aria-expanded onClick={onToggle} className="inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs text-muted transition hover:bg-raised hover:text-zinc-100">
            <ChevronUp className="h-3.5 w-3.5" />Réduire {title}
          </button>
        </div>
        {children}
      </div>
    );
  }
  const level = state.level;
  return (
    <button
      type="button"
      aria-expanded={false}
      title={text}
      onClick={onToggle}
      className={clsx('panel grid h-[72px] w-full grid-cols-[4px_40px_minmax(0,1fr)_auto_16px] items-center gap-3 overflow-hidden pr-3.5 text-left transition hover:border-zinc-600', tint[level])}
    >
      <span className={clsx('h-full', rail[level])} />
      <span className={clsx('flex h-10 w-10 items-center justify-center rounded-lg', iconBox[level])}><Icon className="h-5 w-5" /></span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <span className="truncate">{title}</span>
          <Badge tone={levelTone[level]}>{levelLabel[level]}</Badge>
        </span>
        <span className={clsx('mt-0.5 block truncate text-[12.5px]', textTone[level])}>{text}</span>
      </span>
      <span className="flex justify-end"><Visual visual={info.visual} /></span>
      <ChevronDown className="h-4 w-4 text-zinc-600" />
    </button>
  );
}
