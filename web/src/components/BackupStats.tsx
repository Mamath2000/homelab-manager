import { formatBytes, formatDuration } from '../lib/backups';

// Volume uploaded and time of the last day with a backup, for the line of a backup.
export function LastRun({ cells }: { cells: { uploaded: number; duration: number; failed: number }[] | undefined }) {
  const c = [...(cells ?? [])].reverse().find((x) => x.uploaded || x.duration);
  if (!c) return <span className="text-zinc-500">—</span>;
  return (
    <div className="tabular-nums leading-tight" title={c.failed ? `${c.failed} échec${c.failed > 1 ? 's' : ''} ce jour-là` : undefined}>
      <div className={c.failed ? 'text-red-400' : 'text-zinc-100'}>{formatBytes(c.uploaded)}</div>
      <div className="text-xs text-muted">{formatDuration(c.duration)}</div>
    </div>
  );
}
