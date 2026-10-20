import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Activity } from 'lucide-react';
import type { AlertLevel, DayAlert } from '../lib/api';
import { domainIcon } from '../lib/monitoring';
import { useHostAlerts, useStatus } from '../lib/queries';
import { Panel } from './ui';

const DAYS = 30;
const MOBILE_BREAKPOINT = 640;

type Cell = AlertLevel | 'none';
const cellColor: Record<Cell, string> = {
  ok: 'bg-emerald-500/55',
  warn: 'bg-amber-500',
  alert: 'bg-red-500',
  // not followed that day: hatched
  none: 'bg-raised bg-[repeating-linear-gradient(135deg,transparent_0_4px,rgb(255_255_255/0.04)_4px_6px)]',
};
const levelLabel: Record<Cell, string> = { ok: 'OK', warn: 'avertissement', alert: 'alerte', none: 'non suivi' };

// Same day key as the hub (local time).
function dayKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function lastDays() {
  const today = new Date();
  return Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (DAYS - 1 - i));
    return { date: d, key: dayKey(d) };
  });
}

const shortDate = (d: Date) => d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
const longDate = (d: Date) => d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const reasonText = (a: DayAlert | null) => (!a ? 'non suivi' : a.reasons.length ? a.reasons.join(' · ') : levelLabel[a.level]);

// Alerts of the last 30 days of a host, one row per domain the host provides (given by the hub), one
// square per day (latest known state of the day; today, the live status).
// A click on a day shows its reasons in each domain.
export function AlertTimeline({ hostId }: { hostId: string }) {
  const { data } = useHostAlerts(hostId);
  const { data: status } = useStatus();
  const [isCompact, setIsCompact] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    const update = () => setIsCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const live = status?.hosts[hostId];
  const domains = (status?.domains ?? []).filter((d) => live?.domains[d.id]);
  const days = lastDays();
  const visibleDays = isCompact ? days.slice(-7) : days;
  const [picked, setPicked] = useState<string | null>(null);
  const selected = days.find((d) => d.key === picked) ?? visibleDays[visibleDays.length - 1];
  const byDay = new Map((data?.days ?? []).map((d) => [d.day, d]));
  const today = days[DAYS - 1].key;
  const at = (key: string, dom: string): DayAlert | null => {
    const l = key === today ? live?.domains[dom] : undefined;
    if (l) return l.level === 'unknown' ? null : { level: l.level, reasons: l.checks.filter((c) => c.level !== 'ok' && c.reason).map((c) => c.reason!) };
    return byDay.get(key)?.domains[dom] ?? null;
  };
  // what is said of a day: its reasons, or why nothing is known (host away today)
  const text = (key: string, dom: string) => {
    const l = key === today ? live?.domains[dom] : undefined;
    return l?.level === 'unknown' ? (l.reason ?? 'non suivi') : reasonText(at(key, dom));
  };

  const rows = (
    <div className="space-y-1.5">
      <div className={clsx('grid items-end gap-4', isCompact ? 'grid-cols-[4.5rem_minmax(0,1fr)]' : 'grid-cols-[9rem_minmax(0,1fr)]')}>
        <span />
        <div className={clsx('grid gap-[3px] text-[11px] text-muted', isCompact ? 'grid-cols-[repeat(7,minmax(0,1fr))]' : 'grid-cols-[repeat(30,minmax(0,1fr))]')}>
          {visibleDays.map((d, i) => (
            <span key={d.key} className="whitespace-nowrap text-center">{i === visibleDays.length - 1 ? 'auj.' : d.date.getDay() === 1 ? shortDate(d.date) : ''}</span>
          ))}
        </div>
      </div>
      {domains.map((domain) => {
        const { id, label } = domain;
        const Icon = domainIcon(domain);
        const levels = visibleDays.map((d) => at(d.key, id)?.level ?? 'none');
        return (
          <div key={id} className={clsx('grid items-center gap-4', isCompact ? 'grid-cols-[4.5rem_minmax(0,1fr)]' : 'grid-cols-[9rem_minmax(0,1fr)]')}>
            <span className={clsx('flex items-center gap-2 text-sm text-zinc-300', isCompact && 'justify-center')}>
              <Icon className="h-4 w-4 text-muted" />
              {!isCompact && label}
            </span>
            <div className={clsx('grid gap-[3px]', isCompact ? 'grid-cols-[repeat(7,minmax(0,1fr))]' : 'grid-cols-[repeat(30,minmax(0,1fr))]')}>
              {visibleDays.map((d, i) => (
                <button
                  key={d.key}
                  type="button"
                  title={`${shortDate(d.date)} · ${label} : ${text(d.key, id)}`}
                  aria-label={`${shortDate(d.date)}, ${label} : ${levelLabel[levels[i]]}`}
                  onClick={() => setPicked(d.key)}
                  className={clsx(
                    'h-6 min-h-6 rounded-[3px] transition hover:brightness-125',
                    cellColor[levels[i]],
                    d.key === selected.key && 'outline-2 outline-offset-1 outline-zinc-100',
                    isCompact && 'min-w-6',
                  )}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );

  const detail = isCompact ? (
    <div className="-mx-4 mt-3 space-y-2 border-t border-line px-4 py-2.5 text-sm">
      <span className="block font-medium capitalize text-zinc-100">
        {longDate(selected.date)}
        {selected.key === days[DAYS - 1].key && <span className="block text-xs font-normal normal-case text-muted">aujourd'hui</span>}
      </span>
      {domains.map(({ id, label }) => {
        const a = at(selected.key, id);
        return (
          <div key={id} className="flex min-w-0 items-start gap-2.5">
            <span className={clsx('mt-1 h-2.5 w-2.5 shrink-0 rounded-[2px]', cellColor[a?.level ?? 'none'])} />
            <div className="min-w-0">
              <span className="font-medium text-zinc-200">{label}</span>
              <span className="block break-words text-zinc-400">{text(selected.key, id)}</span>
            </div>
          </div>
        );
      })}
    </div>
  ) : (
    <div
      className="-mx-4 mt-3 grid gap-4 border-t border-line px-4 py-2.5 text-sm"
      style={{ gridTemplateColumns: `9rem repeat(${domains.length}, minmax(0, 1fr))` }}
    >
      <span className="font-medium capitalize text-zinc-100">
        {longDate(selected.date)}
        {selected.key === days[DAYS - 1].key && <span className="block text-xs font-normal normal-case text-muted">aujourd'hui</span>}
      </span>
      {domains.map(({ id, label }) => {
        const a = at(selected.key, id);
        return (
          <div key={id} className="flex min-w-0 items-baseline gap-2">
            <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-[2px]', cellColor[a?.level ?? 'none'])} />
            <span className="min-w-0 break-words" title={`${label} · ${text(selected.key, id)}`}>
              <span className="font-medium text-zinc-200">{label}</span>
              <span className="text-zinc-400"> · {text(selected.key, id)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );

  return (
    <Panel
      title="Alertes sur 30 jours"
      icon={Activity}
      bodyClassName="px-4 pt-3"
      actions={
        <span className="flex items-center gap-3 text-xs text-muted">
          {(['ok', 'warn', 'alert', 'none'] as Cell[]).map((c) => (
            <span key={c} className="flex items-center gap-1.5">
              <span className={clsx('h-2.5 w-2.5 rounded-[2px]', cellColor[c], c === 'none' && 'ring-1 ring-line')} />
              {levelLabel[c]}
            </span>
          ))}
        </span>
      }
    >
      {rows}
      {detail}
    </Panel>
  );
}
