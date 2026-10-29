import clsx from 'clsx';
import { Link } from 'react-router';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { Probe, ProbeType } from '../lib/api';
import { TYPES } from '../lib/probes';
import type { ProbeOwner } from './Probes';

export interface ProbeItem {
  probe: Probe;
  ownerName: string;
  ownerPath: string;
  owner: ProbeOwner;
}

// A row of the matrix: a site, or hosts / equipments when there is a single site.
export interface ProbeRow {
  id: string;
  name: string;
  items: ProbeItem[];
}

const label = 'text-[11px] font-medium uppercase tracking-wider text-muted';
const MAX_FAILING = 8;

const green = (alpha = 1) => `hsl(130 70% 50% / ${alpha})`;
const red = (alpha = 1) => `hsl(0 70% 50% / ${alpha})`;
const grey = (alpha = 1) => `hsl(240 4% 60% / ${alpha})`;

// Worst state of a cell: one probe down makes it red; grey when none could be measured.
function tint(list: ProbeItem[]) {
  const states = list.map((i) => i.probe.state);
  const c = states.includes('down') ? red : states.includes('up') ? green : grey;
  return { backgroundColor: c(0.22), color: c(), boxShadow: `inset 0 0 0 1px ${c(0.4)}` };
}

interface Props {
  rows: ProbeRow[];
  items: ProbeItem[];
  row: string;
  type: string;
  onSel: (row: string, type: string) => void;
}

// Top of the Probes page, same model as the Health one: rows × probe types matrix (a cell takes the colour of its worst
// probe) and the failing probes on the right. A cell, a row or a type filters the cards below; a second click removes it.
export function ProbesOverviewHeader({ rows, items, row, type, onSel }: Props) {
  const columns = TYPES.filter((t) => items.some((i) => i.probe.target.type === t.id));
  const failing = items
    .filter((i) => i.probe.state !== 'up')
    .sort((a, b) => Number(b.probe.state === 'down') - Number(a.probe.state === 'down') || a.ownerName.localeCompare(b.ownerName));
  const cols = `minmax(4.5rem,1.3fr) repeat(${columns.length}, minmax(2.5rem,1fr)) minmax(2rem,.6fr)`;
  const cellHead = 'flex h-5 items-center justify-center truncate rounded-sm px-1 text-[11px] font-semibold text-muted';
  const ofType = (list: ProbeItem[], t: ProbeType) => list.filter((i) => i.probe.target.type === t);

  return (
    <section aria-label="Vue d’ensemble des sondes" className="mb-4 grid gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div className="panel min-w-0 px-4 py-2.5">
        <div className="grid gap-0.5" style={{ gridTemplateColumns: cols }} role="grid" aria-label="Sondes par ligne et par type, rouge si une sonde est down">
          <span />
          {columns.map((c) => (
            <button key={c.id} type="button" title={c.label} aria-pressed={type === c.id} onClick={() => onSel(row, type === c.id ? '' : c.id)}
              className={clsx(cellHead, 'hover:bg-raised hover:text-zinc-200', type === c.id && 'bg-emerald-500/10 text-zinc-100 ring-1 ring-emerald-500')}>
              {c.label}
            </button>
          ))}
          <span className={cellHead}>Total</span>
          {rows.map((r) => (
            <RowCells key={r.id} row={r} columns={columns} sel={{ row, type }} ofType={ofType} onSel={onSel} />
          ))}
        </div>
        <div className="mt-2 flex items-center gap-3 text-[11px] text-muted">
          {[['up', green], ['down', red], ['inconnu', grey]].map(([l, c]) => (
            <span key={l as string} className="inline-flex items-center gap-1.5"><i className="block h-2.5 w-2.5 rounded-[2px]" style={{ background: (c as typeof green)() }} />{l as string}</span>
          ))}
        </div>
      </div>

      <div className="panel min-w-0 px-4 py-2.5">
        <span className={label}>Sondes en défaut</span>
        {failing.length ? (
          <ul className="mt-1.5 space-y-1">
            {failing.slice(0, MAX_FAILING).map((i) => (
              <li key={i.probe.id} className="flex min-w-0 items-center gap-2 text-xs" title={i.probe.message ?? undefined}>
                <AlertTriangle className={clsx('h-3.5 w-3.5 shrink-0', i.probe.state === 'down' ? 'text-red-400' : 'text-zinc-500')} />
                <Link className="shrink-0 font-medium text-zinc-100 hover:text-emerald-300" to={i.ownerPath}>{i.ownerName}</Link>
                <span className={clsx('truncate', i.probe.state === 'down' ? 'text-red-300' : 'text-muted')}>{i.probe.name}{i.probe.message ? ` · ${i.probe.message}` : ''}</span>
              </li>
            ))}
            {failing.length > MAX_FAILING && <li className="text-xs text-muted">… et {failing.length - MAX_FAILING} autre(s)</li>}
          </ul>
        ) : (
          <p className="mt-1.5 flex items-center gap-2 text-sm text-muted"><CheckCircle2 className="h-4 w-4 text-emerald-400" />Toutes les sondes répondent.</p>
        )}
      </div>
    </section>
  );
}

function RowCells({ row, columns, sel, ofType, onSel }: {
  row: ProbeRow;
  columns: typeof TYPES;
  sel: { row: string; type: string };
  ofType: (list: ProbeItem[], t: ProbeType) => ProbeItem[];
  onSel: (row: string, type: string) => void;
}) {
  return (
    <>
      <button type="button" aria-pressed={sel.row === row.id} onClick={() => onSel(sel.row === row.id ? '' : row.id, '')}
        className={clsx('flex h-[22px] min-w-0 items-center truncate rounded-sm px-1.5 text-left text-[13px] hover:bg-raised', sel.row === row.id && !sel.type && 'bg-emerald-500/10 ring-1 ring-emerald-500')}>
        <span className="truncate">{row.name}</span>
      </button>
      {columns.map((c) => {
        const cell = ofType(row.items, c.id);
        if (!cell.length) return <span key={c.id} className="flex h-[22px] items-center justify-center text-xs text-zinc-600">·</span>;
        const active = sel.row === row.id && sel.type === c.id;
        return (
          <button key={c.id} type="button" aria-pressed={active} title={cell.map((i) => `${i.ownerName} · ${i.probe.name}`).join(', ')} onClick={() => onSel(active ? '' : row.id, active ? '' : c.id)}
            style={tint(cell)}
            className={clsx('flex h-[22px] items-center justify-center rounded-sm text-xs font-semibold tabular-nums transition hover:brightness-125', active && 'ring-2 ring-zinc-100')}>
            {cell.length}
          </button>
        );
      })}
      <span className="flex h-[22px] items-center justify-center text-xs tabular-nums text-muted">{row.items.length}</span>
    </>
  );
}
