import clsx from 'clsx';
import { formatBytes, formatDuration, scaleTop } from '../lib/backups';

// Bars of the volume uploaded per day over the last 30 days, for the line of a backup.
export function StatBars({ cells, className }: { cells: { uploaded: number; duration: number; failed: number }[] | undefined; className?: string }) {
  const days = 30;
  const list = cells ?? [];
  const max = scaleTop(list.map((c) => c.uploaded));
  return (
    <div className={clsx('flex h-9 items-end gap-[2px]', className ?? 'w-full min-w-40 max-w-60')} aria-label="Volume transféré, 30 derniers jours">
      {Array.from({ length: days }, (_, i) => {
        const c = list[i];
        const empty = !c || (!c.uploaded && !c.duration);
        return (
          <span
            key={i}
            title={c && !empty ? `${formatBytes(c.uploaded)} transférés · ${formatDuration(c.duration)}${c.failed ? ` · ${c.failed} échec${c.failed > 1 ? 's' : ''}` : ''}` : undefined}
            className={clsx('min-w-0 flex-1 rounded-t-[1px]', empty ? 'h-px bg-raised' : c.failed ? 'bg-red-500/80' : c.uploaded > max ? 'bg-emerald-300' : 'bg-emerald-500/80')}
            // a backup that uploaded nothing new still shows (3 px)
            style={empty ? undefined : { height: `${Math.max(8, Math.min(1, c.uploaded / max) * 100)}%` }}
          />
        );
      })}
    </div>
  );
}
