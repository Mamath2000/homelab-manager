import clsx from 'clsx';
import { Link } from 'react-router';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { COLUMNS, LEVEL_RANK, natureGroup, type DiskLevel, type DiskRow, type DiskSiteRow, type NatureFilter } from '../lib/disks';

const label = 'text-[11px] font-medium uppercase tracking-wider text-muted';
const MAX_WATCH = 8;

const HUE: Record<DiskLevel, string> = { ok: '130 70% 50%', warn: '38 92% 50%', alert: '0 70% 50%' };
const tint = (level: DiskLevel) => ({ backgroundColor: `hsl(${HUE[level]} / 0.22)`, color: `hsl(${HUE[level]})`, boxShadow: `inset 0 0 0 1px hsl(${HUE[level]} / 0.4)` });
const worstOf = (rows: DiskRow[]) => rows.reduce<DiskLevel>((a, r) => (LEVEL_RANK[r.level] > LEVEL_RANK[a] ? r.level : a), 'ok');

// Top of the Disks page, same model as the Probes one: sites × kinds of rows (a cell takes the colour of its worst row,
// a click filters the list; a second click removes the filter), and the rows to watch on the right.
export function DisksOverviewHeader({ sites, rows, site, nature, onSel, linkOf }: {
  sites: DiskSiteRow[];
  rows: DiskRow[];
  site: string;
  nature: NatureFilter;
  onSel: (site: string, nature: NatureFilter) => void;
  linkOf: (r: DiskRow) => string | null;
}) {
  const columns = COLUMNS.filter((c) => rows.some((r) => natureGroup(r.nature) === c.id));
  const watch = rows.filter((r) => r.level !== 'ok').sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.hostName.localeCompare(b.hostName));
  const cols = `minmax(5rem,1.3fr) repeat(${columns.length}, minmax(3rem,1fr)) minmax(2.5rem,.6fr)`;
  const cellHead = 'flex h-5 items-center justify-center truncate rounded-sm px-1 text-[11px] font-semibold text-muted';

  return (
    <section aria-label="Vue d’ensemble des disques" className="mb-4 grid gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div className="panel min-w-0 px-4 py-2.5">
        <div className="grid gap-0.5" style={{ gridTemplateColumns: cols }} role="grid" aria-label="Disques par site et par nature, coloré par le pire état">
          <span />
          {columns.map((c) => (
            <button key={c.id} type="button" title={c.title} aria-pressed={nature === c.id} onClick={() => onSel(site, nature === c.id ? '' : c.id)}
              className={clsx(cellHead, 'hover:bg-raised hover:text-zinc-200', nature === c.id && 'bg-emerald-500/10 text-zinc-100 ring-1 ring-emerald-500')}>
              {c.label}
            </button>
          ))}
          <span className={cellHead}>Total</span>
          {sites.map((s) => (
            <SiteCells key={s.id} row={s} columns={columns} sel={{ site, nature }} onSel={onSel} />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted">
          {(['ok', 'warn', 'alert'] as const).map((l) => (
            <span key={l} className="inline-flex items-center gap-1.5"><i className="block h-2.5 w-2.5 rounded-[2px]" style={{ background: `hsl(${HUE[l]})` }} />{{ ok: 'sain', warn: 'attention', alert: 'alerte' }[l]}</span>
          ))}
        </div>
      </div>

      <div className="panel min-w-0 px-4 py-2.5">
        <span className={label}>À surveiller</span>
        {watch.length ? (
          <ul className="mt-1.5 space-y-1">
            {watch.slice(0, MAX_WATCH).map((r) => {
              const to = linkOf(r);
              return (
                <li key={r.id} className="flex min-w-0 items-center gap-2 text-xs" title={r.reasons.join('\n')}>
                  <AlertTriangle className={clsx('h-3.5 w-3.5 shrink-0', r.level === 'alert' ? 'text-red-400' : 'text-amber-400')} />
                  {to ? <Link className="shrink-0 font-medium text-zinc-100 hover:text-emerald-300" to={to}>{r.hostName}</Link> : <span className="shrink-0 font-medium text-zinc-100">{r.hostName}</span>}
                  <span className={clsx('truncate', r.level === 'alert' ? 'text-red-300' : 'text-amber-300')}>{r.reasons[0] ?? r.name}</span>
                </li>
              );
            })}
            {watch.length > MAX_WATCH && <li className="text-xs text-muted">… et {watch.length - MAX_WATCH} autre(s)</li>}
          </ul>
        ) : (
          <p className="mt-1.5 flex items-center gap-2 text-sm text-muted"><CheckCircle2 className="h-4 w-4 text-emerald-400" />Aucun disque ni volume à surveiller.</p>
        )}
      </div>
    </section>
  );
}

function SiteCells({ row, columns, sel, onSel }: {
  row: DiskSiteRow;
  columns: typeof COLUMNS;
  sel: { site: string; nature: NatureFilter };
  onSel: (site: string, nature: NatureFilter) => void;
}) {
  return (
    <>
      <button type="button" aria-pressed={sel.site === row.id} onClick={() => onSel(sel.site === row.id ? '' : row.id, '')}
        className={clsx('flex h-[22px] min-w-0 items-center truncate rounded-sm px-1.5 text-left text-[13px] hover:bg-raised', sel.site === row.id && !sel.nature && 'bg-emerald-500/10 ring-1 ring-emerald-500')}>
        <span className="truncate">{row.name}</span>
      </button>
      {columns.map((c) => {
        const cell = row.rows.filter((r) => natureGroup(r.nature) === c.id);
        if (!cell.length) return <span key={c.id} className="flex h-[22px] items-center justify-center text-xs text-zinc-600">·</span>;
        const active = sel.site === row.id && sel.nature === c.id;
        return (
          <button key={c.id} type="button" aria-pressed={active} title={`${row.name} · ${c.label} : ${cell.length}`} onClick={() => onSel(active ? '' : row.id, active ? '' : c.id)}
            style={tint(worstOf(cell))}
            className={clsx('flex h-[22px] items-center justify-center rounded-sm text-xs font-semibold tabular-nums transition hover:brightness-125', active && 'ring-2 ring-zinc-100')}>
            {cell.length}
          </button>
        );
      })}
      <span className="flex h-[22px] items-center justify-center text-xs tabular-nums text-muted">{row.rows.length}</span>
    </>
  );
}
