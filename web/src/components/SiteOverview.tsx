import { Link } from 'react-router';
import clsx from 'clsx';
import { MapPin, RefreshCw } from 'lucide-react';
import type { DomainMeta, Host, StatusView } from '../lib/api';
import { cellCls, cellLabel, cellOf, domainCells, domainText, hostsDomains, levelTone, worstLevel, type Cell } from '../lib/monitoring';
import { useMe } from '../lib/auth';
import { useRunBulk, useStatus } from '../lib/queries';
import { inColumn, kindColumns } from '../lib/hostOverview';
import { count, siteKindMeta, type Site } from '../lib/sites';
import { hasApt, toneStroke, type Tone } from '../lib/status';
import { Badge, Button, Panel } from './ui';

// Looks for APT updates on the online hosts of the given sites.
function CheckButton({ hosts, label, title }: { hosts: Host[]; label: string; title: string }) {
  const { canWrite } = useMe();
  const bulk = useRunBulk();
  if (!canWrite) return null;
  const targets = hosts.filter((h) => h.online && hasApt(h));
  return (
    <Button size="sm" icon={RefreshCw} loading={bulk.isPending} disabled={!targets.length} title={title} aria-label={label} className="w-10 px-0 md:w-9 md:h-9" onClick={() => bulk.mutate({ hostIds: targets.map((h) => h.id), action: 'apt_update' })} />
  );
}

// the host opens with the list of its site: previous / next and the way back stay in it
const hostLink = (h: Host) => `/hosts/${h.id}?site=${h.siteId ?? 'none'}`;

const cellTone: Record<Cell, Tone> = { ok: 'ok', warn: 'warn', alert: 'bad', unknown: 'neutral', none: 'neutral' };

// One column per host, one square per domain of the site (top to bottom, as the hub orders them):
// coloured when read, grey when the domain applies but cannot be read now, nothing when the host does
// not provide it.
function Tile({ host, status, domains, small }: { host: Host; status: StatusView | undefined; domains: DomainMeta[]; small?: boolean }) {
  const title = [host.name, ...domains.map((d) => `${d.label.toLowerCase()} : ${domainText(status?.hosts[host.id]?.domains[d.id])}`)].join(' · ');
  return (
    <Link
      to={hostLink(host)}
      title={title}
      aria-label={title}
      className={clsx('flex flex-col gap-px transition hover:brightness-125 focus-visible:outline-2 focus-visible:outline-emerald-400', small ? 'w-[26px]' : 'w-[30px]')}
      style={{ height: `${(small ? 13 : 15) * Math.max(domains.length, 1)}px` }}
    >
      {domains.map((d) => (
        <span key={d.id} className={clsx('flex-1 rounded-[3px]', cellCls[cellOf(status?.hosts[host.id]?.domains[d.id])])} />
      ))}
    </Link>
  );
}

// Stacked bar of a domain over the hosts of a site: one segment per state, worst first.
const barColor: Record<Cell, string> = { alert: '#ef4444', warn: '#f59e0b', unknown: '#3f3f46', ok: '#10b981', none: 'transparent' };
const barOrder: Cell[] = ['alert', 'warn', 'ok', 'unknown'];

function Meter({ domain, cells }: { domain: DomainMeta; cells: Cell[] }) {
  const present = cells.filter((c) => c !== 'none');
  const summary = [
    count(present, 'alert') > 0 && <span key="a" className="text-red-400">{count(present, 'alert')} en alerte</span>,
    count(present, 'warn') > 0 && `${count(present, 'warn')} avertissement${count(present, 'warn') > 1 ? 's' : ''}`,
    count(present, 'ok') > 0 && `${count(present, 'ok')} OK`,
    count(present, 'unknown') > 0 && `${count(present, 'unknown')} inconnu${count(present, 'unknown') > 1 ? 's' : ''}`,
  ].filter(Boolean);
  return (
    <div className="min-w-0">
      <div className="mb-1 flex flex-wrap justify-between gap-x-2 text-xs text-muted">
        <span>{domain.label}</span>
        <span className="text-zinc-300">{summary.flatMap((x, i) => (i ? [' · ', x] : [x]))}</span>
      </div>
      <div className="flex h-2 gap-[2px] overflow-hidden rounded bg-line">
        {barOrder.filter((c) => count(present, c) > 0).map((c) => <span key={c} style={{ width: `${(count(present, c) / present.length) * 100}%`, background: barColor[c] }} />)}
      </div>
    </div>
  );
}

// stacked: the meters one under the other (narrow column)
function Meters({ site, status, domains, stacked }: { site: Site; status: StatusView | undefined; domains: DomainMeta[]; stacked?: boolean }) {
  return (
    <div className={clsx('grid gap-x-5 gap-y-2', !stacked && 'grid-cols-[repeat(auto-fit,minmax(170px,1fr))]')}>
      {domains.map((d) => <Meter key={d.id} domain={d} cells={domainCells(status, site.hosts, d.id)} />)}
    </div>
  );
}

function SiteHeader({ site, status }: { site: Site; status: StatusView | undefined }) {
  return (
    <header className="flex flex-wrap items-center gap-2.5">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: status ? toneStroke[levelTone[worstLevel(status, site.hosts)]] : toneStroke.neutral }} />
      <b className="text-[15px] font-medium text-zinc-100">{site.name}</b>
      {site.kind && <Badge tone="neutral">{siteKindMeta[site.kind].label}</Badge>}
      <span className="text-xs text-muted">{site.hosts.length} hôte{site.hosts.length > 1 ? 's' : ''}</span>
      <span className="ml-auto"><CheckButton hosts={site.hosts} label="Vérifier" title={`Rechercher les mises à jour sur les hôtes de ${site.name}`} /></span>
    </header>
  );
}

function SiteCard({ site, status, small }: { site: Site; status: StatusView | undefined; small?: boolean }) {
  const domains = hostsDomains(status, site.hosts);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SiteHeader site={site} status={status} />
      {site.kind === 'main' ? (
        // main site: tiles grouped by host type, as in the matrix of the Hosts page
        <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
          {kindColumns(site.hosts).map((c) => {
            const hosts = site.hosts.filter((h) => inColumn(h, c));
            return (
              <div key={c.key} className="flex flex-col gap-1.5">
                <span className="text-[11px] text-muted">{c.label} · {hosts.length}</span>
                <div className="flex flex-wrap items-start gap-x-1.5 gap-y-2">
                  {hosts.map((h) => <Tile key={h.id} host={h} status={status} domains={domains} small={small} />)}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-x-1.5 gap-y-2">
          {site.hosts.map((h) => <Tile key={h.id} host={h} status={status} domains={domains} small={small} />)}
        </div>
      )}
      <Meters site={site} status={status} domains={domains} stacked={small} />
    </div>
  );
}

// External sites of a single host: one line each instead of a card.
function ExternalSites({ sites, status }: { sites: Site[]; status: StatusView | undefined }) {
  return (
    <div>
      <header className="mb-1 flex items-center gap-2.5">
        <b className="text-[15px] font-medium text-zinc-100">Sites externes</b>
        <Badge tone="neutral">supervisés</Badge>
        <span className="ml-auto"><CheckButton hosts={sites.flatMap((s) => s.hosts)} label="Tout vérifier" title="Rechercher les mises à jour sur tous les sites externes" /></span>
      </header>
      {sites.map((s) => {
        const h = s.hosts[0];
        const domains = hostsDomains(status, s.hosts);
        return (
          <Link
            key={s.name}
            to={hostLink(h)}
            className="flex flex-col gap-1.5 border-t border-line py-2 text-sm first-of-type:border-t-0 hover:bg-raised/50"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: status ? toneStroke[levelTone[worstLevel(status, s.hosts)]] : toneStroke.neutral }} />
              <span className="min-w-0 truncate">
                <span className="font-medium text-zinc-200">{s.name}</span> <span className="text-muted">{h.name}</span>
              </span>
            </span>
            <span className="flex w-full gap-2">
              {domains.map((d) => {
                const c = cellOf(status?.hosts[h.id]?.domains[d.id]);
                return (
                  <Badge key={d.id} tone={cellTone[c]} className="min-w-0 flex-1 basis-0 flex-col !gap-0 whitespace-normal text-center leading-tight">
                    <span>{d.label}</span>
                    <span>{cellLabel[c]}</span>
                  </Badge>
                );
              })}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

function Legend({ domains }: { domains: DomainMeta[] }) {
  const items = [
    { cls: cellCls.ok, label: 'OK' },
    { cls: cellCls.warn, label: 'avertissement' },
    { cls: cellCls.alert, label: 'alerte' },
    { cls: cellCls.unknown, label: 'inconnu (hôte hors ligne…)' },
    { cls: 'ring-1 ring-line', label: 'non fourni par l’hôte' },
  ];
  return (
    <span className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] text-muted">
      <span>haut → bas : {domains.map((d) => d.label.toLowerCase()).join(' · ')}</span>
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <i className={clsx('block h-2.5 w-2.5 rounded-[2px]', i.cls)} />
          {i.label}
        </span>
      ))}
    </span>
  );
}

// Sites of the dashboard: the main ones in large, then on one row the small ones and the external
// sites of a single host, grouped in one card.
export function SiteOverview({ sites }: { sites: Site[] }) {
  const { data: status } = useStatus();
  const external = sites.filter((s) => s.kind === 'external' && s.hosts.length === 1);
  const rest = sites.filter((s) => !external.includes(s));
  // the biggest sites take the whole width, the small ones share a row
  const large = rest.filter((s) => s.kind === 'main' || s.hosts.length > 8);
  const small = rest.filter((s) => !large.includes(s));

  return (
    <Panel title="Sites" icon={MapPin}>
      <div className="mb-4">
        <Legend domains={hostsDomains(status, sites.flatMap((s) => s.hosts))} />
      </div>
      <div className="flex flex-col gap-5">
        {large.map((s) => <SiteCard key={s.name} site={s} status={status} />)}
        {/* the small sites and the external ones share a row, one column each */}
        {(small.length > 0 || external.length > 0) && (
          <div className="grid gap-x-6 gap-y-5 border-t border-line pt-4 first:border-t-0 first:pt-0 md:grid-cols-[repeat(auto-fit,minmax(260px,1fr))]">
            {small.map((s) => <SiteCard key={s.name} site={s} status={status} small />)}
            {external.length > 0 && <ExternalSites sites={external} status={status} />}
          </div>
        )}
      </div>
    </Panel>
  );
}
