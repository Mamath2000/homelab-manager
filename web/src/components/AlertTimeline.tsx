import { useState } from 'react';
import clsx from 'clsx';
import { Activity, BatteryCharging, Container, DatabaseBackup, Package, type LucideIcon } from 'lucide-react';
import type { AlertDomain, AlertLevel, DayAlert } from '../lib/api';
import { useHostAlerts } from '../lib/queries';
import { Badge, Panel } from './ui';

const DAYS = 30;

const allDomains: { id: AlertDomain; label: string; icon: LucideIcon }[] = [
  { id: 'apt', label: 'Mises à jour', icon: Package },
  { id: 'docker', label: 'Docker', icon: Container },
  { id: 'backups', label: 'Sauvegardes', icon: DatabaseBackup },
  { id: 'ups', label: 'Onduleur', icon: BatteryCharging },
];

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

// Alerts of the last 30 days of a host, one row per domain, one square per day (latest known state of the day).
// A click on a day shows its reasons in each domain.
// The UPS row only exists for a host with a UPS.
export function AlertTimeline({ hostId, ups }: { hostId: string; ups?: boolean }) {
  const { data } = useHostAlerts(hostId);
  const domains = allDomains.filter((d) => d.id !== 'ups' || ups);
  const days = lastDays();
  const [picked, setPicked] = useState<string | null>(null);
  const selected = days.find((d) => d.key === picked) ?? days[DAYS - 1];
  const byDay = new Map((data?.days ?? []).map((d) => [d.day, d]));
  const at = (key: string, dom: AlertDomain): DayAlert | null => byDay.get(key)?.[dom] ?? null;

  const rows = (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[9rem_minmax(0,1fr)_12rem] items-end gap-4">
        <span />
        <div className="grid grid-cols-[repeat(30,minmax(0,1fr))] gap-[3px] text-[11px] text-muted">
          {days.map((d, i) => (
            <span key={d.key} className="whitespace-nowrap">{i === DAYS - 1 ? 'auj.' : d.date.getDay() === 1 ? shortDate(d.date) : ''}</span>
          ))}
        </div>
        <span />
      </div>
      {domains.map(({ id, label, icon: Icon }) => {
        const levels = days.map((d) => at(d.key, id)?.level ?? 'none');
        const alerts = levels.filter((l) => l === 'alert').length;
        const warns = levels.filter((l) => l === 'warn').length;
        const followed = levels.some((l) => l !== 'none');
        return (
          <div key={id} className="grid grid-cols-[9rem_minmax(0,1fr)_12rem] items-center gap-4">
            <span className="flex items-center gap-2 text-sm text-zinc-300">
              <Icon className="h-4 w-4 text-muted" />
              {label}
            </span>
            <div className="grid grid-cols-[repeat(30,minmax(0,1fr))] gap-[3px]">
              {days.map((d, i) => (
                <button
                  key={d.key}
                  type="button"
                  title={`${shortDate(d.date)} · ${label} : ${reasonText(at(d.key, id))}`}
                  aria-label={`${shortDate(d.date)}, ${label} : ${levelLabel[levels[i]]}`}
                  onClick={() => setPicked(d.key)}
                  className={clsx(
                    'h-6 rounded-[3px] transition-[height] hover:brightness-125',
                    cellColor[levels[i]],
                    d.key === selected.key && 'outline-2 outline-offset-1 outline-zinc-100',
                  )}
                />
              ))}
            </div>
            <span className="flex justify-end gap-1.5">
              {!followed ? (
                <span className="text-xs text-muted">non suivi</span>
              ) : alerts + warns === 0 ? (
                <Badge tone="ok">sans alerte</Badge>
              ) : (
                <>
                  {alerts > 0 && <Badge tone="bad">{alerts} j d'alerte</Badge>}
                  {warns > 0 && <Badge tone="warn">{warns} j d'avert.</Badge>}
                </>
              )}
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
              <span className="min-w-0">
                <span className="font-medium text-zinc-200">{label}</span>
                <span className="text-zinc-400"> · {reasonText(a)}</span>
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
