import { useMemo } from 'react';
import clsx from 'clsx';
import { Link } from 'react-router';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { Host, HealthOverviewHost, SiteConfig } from '../lib/api';
import { inColumn, kindColumns, siteRows } from '../lib/hostOverview';

export interface HealthItem {
  host: Host;
  health: HealthOverviewHost;
}

const label = 'text-[11px] font-medium uppercase tracking-wider text-muted';
const MAX_ALERTS = 8;

// Risk of a host from 0 (nothing to report) to 1 (several alerts): a warning weighs 0.3, an alert 0.6.
function healthRisk(h: HealthOverviewHost): number {
  const alerts = h.health?.alerts ?? [];
  return Math.min(1, alerts.reduce((sum, a) => sum + (a.level === 'alert' ? 0.6 : 0.3), 0));
}

// Green (hue 130) to red (hue 0).
const riskHsl = (risk: number, alpha = 1) => `hsl(${Math.round(130 * (1 - risk))} 70% 50% / ${alpha})`;

interface Props {
  items: HealthItem[];
  sites: SiteConfig[];
  site: string;
  kind: string;
  onSiteKind: (site: string, kind: string) => void;
}

// Top of the Health page: sites × natures matrix (a cell takes the colour of its riskiest host, green to red) and the
// main alerts on the right. A cell, a site or a nature filters the cards below; a second click removes the filter.
export function HealthOverviewHeader({ items, sites, site, kind, onSiteKind }: Props) {
  const hosts = useMemo(() => items.map((i) => i.host), [items]);
  const risk = useMemo(() => new Map(items.map((i) => [i.host.id, healthRisk(i.health)])), [items]);
  const columns = useMemo(() => kindColumns(hosts), [hosts]);
  const rows = useMemo(() => siteRows(hosts, sites), [hosts, sites]);
  const alerts = useMemo(
    () =>
      items
        .flatMap((i) => (i.health.health?.alerts ?? []).map((a) => ({ ...a, hostId: i.host.id, hostName: i.host.name })))
        .sort((a, b) => Number(b.level === 'alert') - Number(a.level === 'alert') || a.hostName.localeCompare(b.hostName)),
    [items],
  );
  const worst = (list: Host[]) => Math.max(0, ...list.map((h) => risk.get(h.id) ?? 0));
  const cols = `minmax(4.5rem,1.3fr) repeat(${columns.length}, minmax(2.5rem,1fr)) minmax(2rem,.6fr)`;
  const cellHead = 'flex h-5 items-center justify-center truncate rounded-sm px-1 text-[11px] font-semibold text-muted';

  return (
    <section aria-label="Vue d’ensemble de la santé" className="mb-4 grid gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div className="panel min-w-0 px-4 py-2.5">
        <div className="grid gap-0.5" style={{ gridTemplateColumns: cols }} role="grid" aria-label="Hôtes par site et par nature, la couleur va du vert au rouge selon les alertes">
          <span />
          {columns.map((c) => (
            <button key={c.key} type="button" title={c.label} aria-pressed={kind === c.key} onClick={() => onSiteKind(site, kind === c.key ? '' : c.key)}
              className={clsx(cellHead, 'hover:bg-raised hover:text-zinc-200', kind === c.key && 'bg-emerald-500/10 text-zinc-100 ring-1 ring-emerald-500')}>
              {c.label}
            </button>
          ))}
          <span className={cellHead}>Total</span>
          {rows.map((r) => (
            <RowCells key={r.id} id={r.id} name={r.name} hosts={r.hosts} columns={columns} site={site} kind={kind} worst={worst} onSiteKind={onSiteKind} />
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2 text-[11px] text-muted">
          <span>Sain</span>
          <i className="h-1.5 flex-1 rounded-full" style={{ background: `linear-gradient(to right, ${riskHsl(0)}, ${riskHsl(0.5)}, ${riskHsl(1)})` }} />
          <span>Critique</span>
        </div>
      </div>

      <div className="panel min-w-0 px-4 py-2.5">
        <span className={label}>Principales alertes</span>
        {alerts.length ? (
          <ul className="mt-1.5 space-y-1">
            {alerts.slice(0, MAX_ALERTS).map((a) => (
              <li key={`${a.hostId}-${a.key}`} className="flex min-w-0 items-center gap-2 text-xs" title={a.reason}>
                <AlertTriangle className={clsx('h-3.5 w-3.5 shrink-0', a.level === 'alert' ? 'text-red-400' : 'text-amber-400')} />
                <Link className="shrink-0 font-medium text-zinc-100 hover:text-emerald-300" to={`/hosts/${a.hostId}`}>{a.hostName}</Link>
                <span className={clsx('truncate', a.level === 'alert' ? 'text-red-300' : 'text-amber-300')}>{a.reason}</span>
              </li>
            ))}
            {alerts.length > MAX_ALERTS && <li className="text-xs text-muted">… et {alerts.length - MAX_ALERTS} autre(s)</li>}
          </ul>
        ) : (
          <p className="mt-1.5 flex items-center gap-2 text-sm text-muted"><CheckCircle2 className="h-4 w-4 text-emerald-400" />Aucune alerte.</p>
        )}
      </div>
    </section>
  );
}

function RowCells({ id, name, hosts, columns, site, kind, worst, onSiteKind }: {
  id: string;
  name: string;
  hosts: Host[];
  columns: ReturnType<typeof kindColumns>;
  site: string;
  kind: string;
  worst: (hosts: Host[]) => number;
  onSiteKind: (site: string, kind: string) => void;
}) {
  const tint = (r: number) => ({ backgroundColor: riskHsl(r, 0.22), color: riskHsl(r), boxShadow: `inset 0 0 0 1px ${riskHsl(r, 0.4)}` });
  return (
    <>
      <button type="button" aria-pressed={site === id} onClick={() => onSiteKind(site === id ? '' : id, '')}
        className={clsx('flex h-[22px] min-w-0 items-center truncate rounded-sm px-1.5 text-left text-[13px] hover:bg-raised', site === id && !kind && 'bg-emerald-500/10 ring-1 ring-emerald-500')}>
        <span className="truncate">{name}</span>
      </button>
      {columns.map((c) => {
        const cell = hosts.filter((h) => inColumn(h, c));
        if (!cell.length) return <span key={c.key} className="flex h-[22px] items-center justify-center text-xs text-zinc-600">·</span>;
        const active = site === id && kind === c.key;
        const same = active;
        return (
          <button key={c.key} type="button" aria-pressed={active} title={cell.map((h) => h.name).join(', ')} onClick={() => onSiteKind(same ? '' : id, same ? '' : c.key)}
            style={tint(worst(cell))}
            className={clsx('flex h-[22px] items-center justify-center rounded-sm text-xs font-semibold tabular-nums transition hover:brightness-125', active && 'ring-2 ring-zinc-100')}>
            {cell.length}
          </button>
        );
      })}
      <span className="flex h-[22px] items-center justify-center text-xs tabular-nums text-muted">{hosts.length}</span>
    </>
  );
}
