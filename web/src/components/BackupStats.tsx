import { useState } from 'react';
import clsx from 'clsx';
import { formatBytes } from '../lib/backups';
import { useBackupStats } from '../lib/queries';

const day = (t: number) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

// "1 h 05", "12 min", "40 s"
export function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

// Bars of the volume uploaded per day over the last 30 days, for the line of a backup.
export function StatBars({ cells, className }: { cells: { uploaded: number; duration: number; failed: number }[] | undefined; className?: string }) {
  const days = 30;
  const list = cells ?? [];
  const max = Math.max(1, ...list.map((c) => c.uploaded));
  return (
    <div className={clsx('flex h-6 items-end gap-[2px]', className ?? 'w-40')} aria-label="Volume transféré, 30 derniers jours">
      {Array.from({ length: days }, (_, i) => {
        const c = list[i];
        const empty = !c || (!c.uploaded && !c.duration);
        return (
          <span
            key={i}
            title={c && !empty ? `${formatBytes(c.uploaded)} transférés · ${formatDuration(c.duration)}${c.failed ? ` · ${c.failed} échec${c.failed > 1 ? 's' : ''}` : ''}` : undefined}
            className={clsx('min-w-0 flex-1 rounded-[1px]', empty ? 'h-px bg-raised' : c.failed ? 'bg-red-500/80' : 'bg-emerald-500/80')}
            // a backup that uploaded nothing new still shows (2 px)
            style={empty ? undefined : { height: `${Math.max(8, (c.uploaded / max) * 100)}%` }}
          />
        );
      })}
    </div>
  );
}

// Volume uploaded per day (bars) and backup time added up per day (line, right axis).
export function StatsPanel({ error }: { error: string | null }) {
  const [days, setDays] = useState<30 | 60>(30);
  const { data } = useBackupStats(days);
  const cells = data?.days ?? [];
  const maxUp = Math.max(1, ...cells.map((c) => c.uploaded));
  const maxDur = Math.max(1, ...cells.map((c) => c.duration));
  const total = cells.reduce((a, c) => ({ up: a.up + c.uploaded, dur: a.dur + c.duration }), { up: 0, dur: 0 });
  const empty = !cells.some((c) => c.count);
  const n = cells.length || days;
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const line = cells.map((c, i) => `${x(i)},${100 - (c.duration / maxDur) * 100}`).join(' ');
  return (
    <div className="panel mb-4 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="text-sm font-semibold text-zinc-200">Données sauvegardées par jour</h2>
        <span className="text-xs text-muted">
          {formatBytes(total.up)} transférés · {formatDuration(total.dur)} de sauvegarde sur {days} jours
        </span>
        <div className="ml-auto flex gap-1 rounded-md border border-line bg-panel p-1">
          {([30, 60] as const).map((d) => (
            <button key={d} onClick={() => setDays(d)} className={clsx('rounded-sm px-2.5 py-1 text-xs font-medium transition', days === d ? 'bg-raised text-zinc-100 ring-1 ring-line' : 'text-muted hover:text-zinc-200')}>
              {d} j
            </button>
          ))}
        </div>
      </div>
      {error && <p className="mb-2 text-xs text-amber-400">Statistiques indisponibles : {error}</p>}
      {empty ? (
        <p className="py-6 text-center text-xs text-muted">{error ? '' : 'Aucune statistique pour l’instant : le premier relevé des tâches du PBS peut prendre quelques minutes.'}</p>
      ) : (
        <div className="flex gap-2">
          <div className="flex w-14 shrink-0 flex-col justify-between text-right text-[10px] tabular-nums text-muted">
            <span>{formatBytes(maxUp)}</span>
            <span>0</span>
          </div>
          <div className="relative h-36 min-w-0 flex-1 border-b border-line">
            <div className="absolute inset-0 flex items-end gap-[2px]">
              {cells.map((c) => (
                <span
                  key={c.day}
                  title={`${day(c.day)} : ${formatBytes(c.uploaded)} transférés · ${formatDuration(c.duration)} · ${c.count} sauvegarde${c.count > 1 ? 's' : ''}${c.failed ? ` dont ${c.failed} en échec` : ''}`}
                  className={clsx('min-w-0 flex-1 rounded-t-[2px]', c.failed ? 'bg-red-500/80' : 'bg-emerald-500/80')}
                  style={{ height: c.count ? `${Math.max(1, (c.uploaded / maxUp) * 100)}%` : 0 }}
                />
              ))}
            </div>
            <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Temps de sauvegarde cumulé par jour">
              <polyline points={line} fill="none" stroke="rgb(251 191 36)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
          <div className="flex w-14 shrink-0 flex-col justify-between text-[10px] tabular-nums text-amber-400">
            <span>{formatDuration(maxDur)}</span>
            <span>0</span>
          </div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-muted">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-[2px] bg-emerald-500/80" />volume transféré (gauche)</span>
        <span><span className="mr-1 inline-block h-0.5 w-3 bg-amber-400 align-middle" />temps de sauvegarde cumulé (droite)</span>
      </div>
    </div>
  );
}
