import { useMemo } from 'react';
import clsx from 'clsx';
import type { Host, SiteConfig } from '../lib/api';
import type { HostFilter } from '../lib/hostFilters';
import { inColumn, kindColumns, overview, siteRows, todoItems, worstTone, type Part } from '../lib/hostOverview';
import { toneBadge, toneBg } from '../lib/status';

const label = 'text-[11px] font-medium uppercase tracking-wider text-muted';

function SegBar({ parts, name }: { parts: Part[]; name: string }) {
  const shown = parts.filter((p) => p.n > 0);
  return (
    <div className="flex h-2 gap-0.5" role="img" aria-label={`${name} : ${shown.map((p) => `${p.n} ${p.label}`).join(', ')}`}>
      {shown.map((p) => <i key={p.label} title={`${p.n} ${p.label}`} className={clsx('block min-w-[3px] rounded-[2px]', toneBg[p.tone])} style={{ flex: p.n }} />)}
    </div>
  );
}

function Health({ parts, ok, total, unit, children }: { parts: Part[]; ok: number; total: number; unit: string; children?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xl font-semibold leading-tight tabular-nums text-zinc-100 max-md:text-[17px]">
        {ok} <span className="text-sm font-normal text-muted">sur {total} {unit}</span>
      </div>
      <div className="mt-1.5"><SegBar parts={parts} name={unit} /></div>
      {children}
    </div>
  );
}

interface Props {
  hosts: Host[];
  sites: SiteConfig[];
  filter: HostFilter;
  site: string;
  kind: string;
  onFilter: (key: string) => void;
  onSite: (id: string) => void;
  onKind: (key: string) => void;
  // site and nature together, one URL update
  onSiteKind: (site: string, kind: string) => void;
}

// Top of the Hosts page: health of the fleet, sites × natures matrix (a cell is the worst state of its hosts) and what
// needs action. Everything filters the list below; a second click removes the filter.
export function HostsOverview({ hosts, sites, filter, site, kind, onFilter, onSite, onKind, onSiteKind }: Props) {
  const o = useMemo(() => overview(hosts), [hosts]);
  const columns = useMemo(() => kindColumns(hosts), [hosts]);
  const rows = useMemo(() => siteRows(hosts, sites), [hosts, sites]);
  const todo = useMemo(() => todoItems.map((t) => ({ ...t, n: hosts.filter(t.test).length })).filter((t) => t.n > 0 || t.key !== 'reinstall'), [hosts]);
  const online = o.fleet[0].n;
  const upToDate = o.updates[0].n;
  const toggleSiteKind = (siteId: string, kindKey: string) => {
    const same = site === siteId && kind === kindKey;
    onSiteKind(same ? '' : siteId, same ? '' : kindKey);
  };

  const todoChips = todo.map((t) => (
    <button
      key={t.key}
      type="button"
      title={t.label}
      aria-pressed={filter === t.key}
      onClick={() => onFilter(t.key)}
      className={clsx(
        'flex min-w-0 items-center gap-2 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs transition max-md:shrink-0',
        filter === t.key ? 'border-emerald-500 bg-emerald-500/10' : 'border-line bg-raised hover:border-zinc-500',
        t.n === 0 && 'opacity-45',
      )}
    >
      <b className={clsx('flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-semibold tabular-nums text-white', toneBg[t.tone])}>{t.n}</b>
      <span className="truncate">{t.short}</span>
    </button>
  ));

  const cellHead = 'flex h-5 items-center justify-center truncate rounded-sm px-1 text-[11px] font-semibold text-muted';
  const cols = `minmax(4.5rem,1.3fr) repeat(${columns.length}, minmax(2.5rem,1fr)) minmax(2rem,.6fr)`;

  return (
    <section aria-label="Vue d’ensemble du parc" className="mb-4">
      {/* grand écran et tablette */}
      <div className="hidden gap-3 md:grid md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="panel min-w-0 px-4 py-2.5">
          <div className="grid gap-0.5" style={{ gridTemplateColumns: cols }} role="grid" aria-label="Hôtes par site et par nature, la couleur est le pire état de la case">
            <span />
            {columns.map((c) => (
              <button key={c.key} type="button" title={c.label} aria-pressed={kind === c.key} onClick={() => onKind(kind === c.key ? '' : c.key)}
                className={clsx(cellHead, 'hover:bg-raised hover:text-zinc-200', kind === c.key && 'bg-emerald-500/10 text-zinc-100 ring-1 ring-emerald-500')}>
                {c.label}
              </button>
            ))}
            <span className={cellHead}>Total</span>
            {rows.map((r) => (
              <RowCells key={r.id} id={r.id} name={r.name} hosts={r.hosts} columns={columns} site={site} kind={kind} onSite={onSite} onCell={toggleSiteKind} />
            ))}
          </div>
        </div>

        <div className="panel flex min-w-0 flex-col justify-center gap-3 px-4 py-2.5">
          <div>
            <span className={label}>Parc</span>
            <Health parts={o.fleet} ok={online} total={hosts.length} unit="en ligne" />
          </div>
          <div>
            <span className={label}>Mises à jour</span>
            <Health parts={o.updates} ok={upToDate} total={o.aptHosts} unit="à jour">
              <div className="mt-1 flex gap-3 text-xs tabular-nums text-muted">
                <span><b className="font-semibold text-zinc-100">{o.packages}</b> paquets</span>
                <span><b className="font-semibold text-red-400">{o.security}</b> de sécurité</span>
              </div>
            </Health>
          </div>
        </div>

        <div className="panel min-w-0 px-4 py-2.5 md:col-span-2 xl:col-span-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 xl:block">
            <span className={clsx(label, 'xl:mb-2 xl:block')}>À traiter</span>
            <div className="flex flex-wrap gap-1.5 xl:grid xl:grid-cols-2">{todoChips}</div>
          </div>
        </div>
      </div>

      {/* mobile : bloc compact, les sites et systèmes en pastilles qui défilent */}
      <div className="panel px-3 py-2.5 md:hidden">
        <div className="grid grid-cols-2 divide-x divide-line">
          <div className="pr-3">
            <span className={label}>Parc</span>
            <Health parts={o.fleet} ok={online} total={hosts.length} unit="en ligne" />
          </div>
          <div className="pl-3">
            <span className={label}>Mises à jour</span>
            <Health parts={o.updates} ok={upToDate} total={o.aptHosts} unit="à jour" />
          </div>
        </div>
        <div className="-mx-1 mt-2.5 flex items-center gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
          <span className={clsx(label, 'shrink-0 pr-0.5')}>À traiter</span>
          {todoChips.filter((_, i) => todo[i].n > 0)}
          <span className={clsx(label, 'shrink-0 pl-2 pr-0.5')}>Sites</span>
          {rows.map((r) => (
            <button key={r.id} type="button" aria-pressed={site === r.id} onClick={() => onSite(site === r.id ? '' : r.id)}
              className={clsx('flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs', site === r.id ? 'border-emerald-500 bg-emerald-500/10' : 'border-line bg-raised')}>
              <i className={clsx('h-2 w-2 rounded-full', toneBg[worstTone(r.hosts)])} />{r.name}<b className="font-semibold tabular-nums">{r.hosts.length}</b>
            </button>
          ))}
          <span className={clsx(label, 'shrink-0 pl-2 pr-0.5')}>Natures</span>
          {columns.map((c) => (
            <button key={c.key} type="button" title={c.label} aria-pressed={kind === c.key} onClick={() => onKind(kind === c.key ? '' : c.key)}
              className={clsx('flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs', kind === c.key ? 'border-emerald-500 bg-emerald-500/10' : 'border-line bg-raised')}>
              {c.label}<b className="font-semibold tabular-nums">{hosts.filter((h) => inColumn(h, c)).length}</b>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function RowCells({ id, name, hosts, columns, site, kind, onSite, onCell }: {
  id: string;
  name: string;
  hosts: Host[];
  columns: ReturnType<typeof kindColumns>;
  site: string;
  kind: string;
  onSite: (id: string) => void;
  onCell: (site: string, kind: string) => void;
}) {
  return (
    <>
      <button type="button" aria-pressed={site === id} onClick={() => onSite(site === id ? '' : id)}
        className={clsx('flex h-[22px] min-w-0 items-center truncate rounded-sm px-1.5 text-left text-[13px] hover:bg-raised', site === id && 'bg-emerald-500/10 ring-1 ring-emerald-500')}>
        <span className="truncate">{name}</span>
      </button>
      {columns.map((c) => {
        const cell = hosts.filter((h) => inColumn(h, c));
        if (!cell.length) return <span key={c.key} className="flex h-[22px] items-center justify-center text-xs text-zinc-600">·</span>;
        const active = site === id && kind === c.key;
        return (
          <button key={c.key} type="button" aria-pressed={active} title={cell.map((h) => h.name).join(', ')} onClick={() => onCell(id, c.key)}
            className={clsx('flex h-[22px] items-center justify-center rounded-sm text-xs font-semibold tabular-nums ring-1 ring-inset transition hover:brightness-125', toneBadge[worstTone(cell)], active && 'ring-2 !ring-zinc-100')}>
            {cell.length}
          </button>
        );
      })}
      <span className="flex h-[22px] items-center justify-center text-xs tabular-nums text-muted">{hosts.length}</span>
    </>
  );
}
