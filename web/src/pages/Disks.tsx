import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, ArrowUpDown, Boxes, ChevronDown, Database, HardDrive, Layers, Monitor, Search, Server, type LucideIcon } from 'lucide-react';
import { HeaderTitle } from '../components/HeaderSlot';
import { DisksOverviewHeader } from '../components/DisksOverviewHeader';
import { Switch } from '../components/HealthThresholdsForm';
import { Badge, Empty, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { formatBytes } from '../lib/backups';
import { arrange, buildDiskRows, COLUMNS, NATURE_LABEL, siteRows, natureGroup, type DiskLevel, type DiskNature, type DiskRow, type NatureFilter, type Sort, type SortKey, type TreeRow } from '../lib/disks';
import { useHosts, useSites } from '../lib/queries';

const LEVELS: { id: '' | DiskLevel; label: string }[] = [
  { id: '', label: 'Tous' },
  { id: 'alert', label: 'Alerte' },
  { id: 'warn', label: 'Attention' },
  { id: 'ok', label: 'Sains' },
];
const LEVEL_DOT: Record<DiskLevel, string> = { ok: 'bg-emerald-500', warn: 'bg-amber-500', alert: 'bg-red-500' };
const LEVEL_TEXT: Record<DiskLevel, string> = { ok: 'text-zinc-100', warn: 'text-amber-300', alert: 'text-red-300' };
const LEVEL_BAR: Record<DiskLevel, string> = { ok: 'bg-emerald-500', warn: 'bg-amber-500', alert: 'bg-red-500' };
const LEVEL_RAIL: Record<DiskLevel, string> = { ok: 'bg-emerald-500/70', warn: 'bg-amber-500', alert: 'bg-red-500' };
const NATURE_ICON: Record<DiskNature, LucideIcon> = { disk: HardDrive, volume: Database, raid: Layers, ceph: Boxes, storage: Server, guest: Monitor };
const NATURE_TEXT: Record<DiskNature, string> = { disk: 'text-zinc-300', volume: 'text-sky-300', raid: 'text-indigo-300', ceph: 'text-indigo-300', storage: 'text-indigo-300', guest: 'text-orange-300' };

const SORT_KEYS: SortKey[] = ['name', 'level', 'host', 'nature', 'type', 'size', 'used', 'free', 'temperature', 'wear', 'smart', 'raid'];
const parseSort = (s: string | null): Sort => {
  const [key, dir] = (s ?? '').split(':');
  return SORT_KEYS.includes(key as SortKey) ? { key: key as SortKey, desc: dir === 'desc' } : { key: 'level', desc: true };
};

// Every disk, volume, RAID array, Ceph cluster, Proxmox VE storage and guest disk of the homelab: sites × natures on top,
// one sortable table below, flat or as a tree (disk → volumes, array → members, Ceph → OSD + pools → guest disks).
export function Disks() {
  const { data: hosts, isLoading, error } = useHosts();
  const { data: sites } = useSites();
  const { data: inv } = useQuery({ queryKey: ['disks'], queryFn: api.disks, refetchInterval: 60_000 });
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const site = params.get('site') ?? '';
  const host = params.get('host') ?? '';
  const nature = (params.get('n') ?? '') as NatureFilter;
  const level = (params.get('l') ?? '') as '' | DiskLevel;
  const tree = params.get('tree') !== '0';
  const sort = parseSort(params.get('sort'));
  const setMany = (values: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(values)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const rows = useMemo(() => buildDiskRows(hosts ?? [], inv), [hosts, inv]);
  const bySite = useMemo(() => siteRows(rows, sites ?? []), [rows, sites]);
  const hostNames = useMemo(() => [...new Set(rows.map((r) => r.hostName))].sort((a, b) => a.localeCompare(b)), [rows]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const inSite = site ? new Set(bySite.find((s) => s.id === site)?.rows.map((r) => r.id) ?? []) : null;
    return new Set(rows.filter((r) =>
      (!inSite || inSite.has(r.id)) &&
      (!host || r.hostName === host) &&
      (!nature || natureGroup(r.nature) === nature) &&
      (!level || r.level === level) &&
      (!needle || [r.name, r.sub, r.hostName, r.type, ...r.tags.map((t) => t.label)].some((x) => x.toLowerCase().includes(needle))),
    ).map((r) => r.id));
  }, [rows, bySite, q, site, host, nature, level]);
  const list = useMemo(() => arrange(rows, shown, sort, tree), [rows, shown, sort, tree]);
  const counts = (l: '' | DiskLevel) => rows.filter((r) => (!nature || natureGroup(r.nature) === nature) && (!l || r.level === l)).length;
  const linkOf = (r: DiskRow) => (r.hostId ? `/hosts/${r.hostId}` : null);
  const onSort = (key: SortKey) => setMany({ sort: sort.key === key ? `${key}:${sort.desc ? 'asc' : 'desc'}` : `${key}:${key === 'name' || key === 'host' || key === 'nature' || key === 'type' || key === 'raid' ? 'asc' : 'desc'}` });

  return (
    <>
      <HeaderTitle icon={HardDrive} title="Disques" />
      <p className="mb-4 text-sm text-muted">Disques physiques, volumes, RAID, Ceph et disques des VM / CT de tous les hôtes. Les états reprennent les alertes de la santé ; les seuils se règlent dans Santé.</p>
      {isLoading ? <div className="flex justify-center p-16"><Spinner /></div> : error ? <p className="text-sm text-red-300">{error.message}</p> : !rows.length ? (
        <Empty icon={HardDrive} title="Aucun disque connu">Les volumes apparaissent avec la santé des hôtes ; les disques physiques, une fois choisis dans les options SMART d’un hôte.</Empty>
      ) : (
        <>
          <DisksOverviewHeader sites={bySite} rows={rows} site={site} nature={nature} linkOf={linkOf} onSel={(s, n) => setMany({ site: s, n })} />

          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input className="input h-9 py-0 pl-9" placeholder="Nom, modèle, n° de série, /dev…" value={q} onChange={(e) => setMany({ q: e.target.value })} />
            </div>
            {bySite.length > 1 && (
              <select className="input h-9 w-auto py-0" value={site} onChange={(e) => setMany({ site: e.target.value })} aria-label="Site">
                <option value="">Tous les sites</option>
                {bySite.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
            <select className="input h-9 w-auto py-0" value={host} onChange={(e) => setMany({ host: e.target.value })} aria-label="Hôte">
              <option value="">Tous les hôtes</option>
              {hostNames.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
            <div className="flex flex-wrap gap-1 rounded-md border border-line bg-panel p-1" role="group" aria-label="Nature">
              {[{ id: '' as NatureFilter, label: 'Tout' }, ...COLUMNS].map((c) => (
                <button key={c.id} type="button" aria-pressed={nature === c.id} onClick={() => setMany({ n: c.id })}
                  className={clsx('rounded-sm px-2.5 py-1 text-xs font-medium transition', nature === c.id ? 'bg-raised text-zinc-100 ring-1 ring-line' : 'text-muted hover:text-zinc-200')}>
                  {c.label} <span className="text-[11px] text-zinc-500">{rows.filter((r) => !c.id || natureGroup(r.nature) === c.id).length}</span>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1 rounded-md border border-line bg-panel p-1" role="group" aria-label="État">
              {LEVELS.map((l) => (
                <button key={l.id} type="button" aria-pressed={level === l.id} onClick={() => setMany({ l: l.id })}
                  className={clsx('inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium transition', level === l.id ? 'bg-raised text-zinc-100 ring-1 ring-line' : 'text-muted hover:text-zinc-200')}>
                  {l.id && <i className={clsx('block h-2 w-2 rounded-full', LEVEL_DOT[l.id])} />}
                  {l.label} <span className="text-[11px] text-zinc-500">{counts(l.id)}</span>
                </button>
              ))}
            </div>
            <label className="ml-auto inline-flex items-center gap-2 text-xs text-muted">
              <Switch checked={tree} onChange={(v) => setMany({ tree: v ? '1' : '0' })} label="Vue hiérarchique" />
              Vue hiérarchique
            </label>
          </div>

          {!list.length ? <p className="panel p-6 text-center text-sm text-muted">Aucune ligne ne correspond aux filtres.</p> : (
            <div className="panel overflow-x-auto">
              <table className="w-full min-w-[1100px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line bg-raised text-left text-[11px] uppercase tracking-wider text-muted">
                    <th className="w-1 p-0" />
                    <SortTh k="name" sort={sort} onSort={onSort}>Nom</SortTh>
                    <SortTh k="level" sort={sort} onSort={onSort}>État</SortTh>
                    <SortTh k="host" sort={sort} onSort={onSort}>Hôte</SortTh>
                    <SortTh k="nature" sort={sort} onSort={onSort}>Nature</SortTh>
                    <SortTh k="type" sort={sort} onSort={onSort}>Type</SortTh>
                    <SortTh k="size" sort={sort} onSort={onSort} right>Taille</SortTh>
                    <SortTh k="used" sort={sort} onSort={onSort}>Espace utilisé</SortTh>
                    <SortTh k="free" sort={sort} onSort={onSort} right>Libre</SortTh>
                    <SortTh k="temperature" sort={sort} onSort={onSort} right>Temp.</SortTh>
                    <SortTh k="wear" sort={sort} onSort={onSort}>Usure / réalloués</SortTh>
                    <SortTh k="smart" sort={sort} onSort={onSort}>SMART</SortTh>
                    <SortTh k="raid" sort={sort} onSort={onSort}>RAID / pool</SortTh>
                  </tr>
                </thead>
                <tbody>
                  {list.map((t) => t.row
                    ? <DiskTableRow key={t.row.id} t={t} tree={tree} link={linkOf(t.row)} />
                    : <HostGroupRow key={t.hostId ?? t.hostName} t={t} link={t.hostId ? `/hosts/${t.hostId}` : null} />)}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}

function SortTh({ k, sort, onSort, right, children }: { k: SortKey; sort: Sort; onSort: (k: SortKey) => void; right?: boolean; children: React.ReactNode }) {
  const active = sort.key === k;
  const Icon = active ? (sort.desc ? ArrowDown : ArrowUp) : ArrowUpDown;
  return (
    <th className={clsx('whitespace-nowrap px-2 py-2 font-semibold', right && 'text-right')} aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" onClick={() => onSort(k)} className={clsx('inline-flex items-center gap-1 uppercase hover:text-zinc-200', active && 'text-zinc-100')}>
        {children}
        <Icon className={clsx('h-3 w-3', active ? 'text-emerald-400' : 'text-zinc-600')} />
      </button>
    </th>
  );
}

// Lines of the tree: one column per ancestor level (a vertical line when a sibling follows), then the elbow of the row.
function TreeLines({ t }: { t: TreeRow }) {
  if (t.depth === 0) return <span className="flex w-5 shrink-0 justify-center text-zinc-400">{t.hasChildren && <ChevronDown className="h-3.5 w-3.5" />}</span>;
  return (
    <>
      <span className="w-3 shrink-0" />
      {t.rails.map((on, i) => <span key={i} className={clsx('relative w-6 shrink-0 self-stretch', on && 'before:absolute before:inset-y-0 before:left-2 before:border-l-2 before:border-zinc-600')} />)}
      <span className={clsx('relative w-7 shrink-0 self-stretch before:absolute before:left-2 before:top-0 before:border-l-2 before:border-zinc-600 after:absolute after:left-2 after:right-1 after:top-1/2 after:border-t-2 after:border-zinc-600', t.last ? 'before:h-1/2' : 'before:bottom-0')} />
    </>
  );
}

function HostGroupRow({ t, link }: { t: TreeRow; link: string | null }) {
  return (
    <tr className="border-b border-line/70 bg-raised/60">
      <td className="w-1 p-0" />
      <td colSpan={12} className="py-0 pl-1 pr-2.5">
        <div className="flex min-h-[44px] items-center gap-2 font-semibold text-zinc-100">
          <TreeLines t={t} />
          <Server className="h-4 w-4 shrink-0 text-emerald-400" />
          {link ? <Link className="hover:text-emerald-300" to={link}>{t.hostName}</Link> : <span>{t.hostName}</span>}
        </div>
      </td>
    </tr>
  );
}

function SpaceBar({ r }: { r: DiskRow }) {
  if (r.used === null || !r.total) return <span className="text-xs text-muted">{r.hint ?? '—'}</span>;
  const pct = (r.used / r.total) * 100;
  return (
    <div className="flex min-w-[130px] items-center gap-2">
      <div className="relative h-2 flex-1 rounded-full bg-zinc-800">
        <div className={clsx('h-full rounded-full', LEVEL_BAR[r.level])} style={{ width: `${Math.min(100, pct)}%` }} />
        {r.thresholds && (
          <>
            <i className="absolute -top-0.5 h-3 w-px bg-amber-500/70" style={{ left: `${r.thresholds.warn}%` }} />
            <i className="absolute -top-0.5 h-3 w-px bg-red-500/70" style={{ left: `${r.thresholds.alert}%` }} />
          </>
        )}
      </div>
      <span className="w-11 text-right font-mono text-xs text-zinc-100">{pct.toFixed(0)} %</span>
    </div>
  );
}

const levelText = (l: DiskLevel) => (l === 'ok' ? 'text-zinc-100' : LEVEL_TEXT[l]);

function DiskTableRow({ t, tree, link }: { t: TreeRow; tree: boolean; link: string | null }) {
  const r = t.row;
  if (!r) return null;
  const Icon = NATURE_ICON[r.nature];
  const child = tree && t.depth > 0;
  const free = r.used !== null && r.total ? r.total - r.used : null;
  return (
    <tr className={clsx('border-b border-line/70 last:border-0', tree && !child && 'border-t border-t-zinc-700 bg-raised/60', child && 'bg-black/20', r.level === 'alert' && 'bg-red-500/[0.06]', r.level === 'warn' && 'bg-amber-500/[0.04]')}>
      <td className={clsx('w-1 p-0', LEVEL_RAIL[r.level])} />
      <td className="py-0 pl-1 pr-2.5">
        <div className="flex min-h-[44px] items-center">
          {tree && <TreeLines t={t} />}
          <div className="min-w-0 py-1.5" style={{ maxWidth: tree ? Math.max(128, 228 - (t.depth === 0 ? 20 : 40 + 24 * t.rails.length)) : 224 }}>
            <div className={clsx('truncate', r.nature === 'volume' || r.nature === 'guest' ? 'font-mono' : '', child ? 'font-medium text-zinc-200' : 'font-semibold text-zinc-100')}>{r.name}</div>
            <div className="truncate font-mono text-[11px] text-muted" title={r.sub}>{r.sub}</div>
          </div>
        </div>
      </td>
      <td className="px-2" title={r.reasons.join('\n') || undefined}>
        <Badge tone={r.level === 'alert' ? 'bad' : r.level === 'warn' ? 'warn' : 'ok'}>{{ ok: 'Sain', warn: 'Attention', alert: 'Alerte' }[r.level]}</Badge>
      </td>
      <td className="whitespace-nowrap px-2 font-medium">
        {link ? <Link className="text-zinc-100 hover:text-emerald-300" to={link}>{r.hostName}</Link> : <span className="text-zinc-300">{r.hostName}</span>}
      </td>
      <td className={clsx('whitespace-nowrap px-2 text-xs', NATURE_TEXT[r.nature])}><span className="inline-flex items-center gap-1.5"><Icon className="h-3.5 w-3.5" />{NATURE_LABEL[r.nature]}</span></td>
      <td className="px-2">{r.type && <span className="rounded-sm bg-zinc-800 px-1.5 py-0.5 text-[11px] font-semibold text-zinc-300">{r.type}</span>}</td>
      <td className="whitespace-nowrap px-2 text-right font-mono text-xs text-zinc-100">{r.sizeBytes ? formatBytes(r.sizeBytes) : <span className="text-muted">—</span>}</td>
      <td className="px-2"><SpaceBar r={r} /></td>
      <td className={clsx('whitespace-nowrap px-2 text-right font-mono text-xs', free === null ? 'text-muted' : levelText(r.level))}>{free === null ? '—' : formatBytes(free)}</td>
      <td className={clsx('whitespace-nowrap px-2 text-right font-mono text-xs', r.temperature === null ? 'text-muted' : levelText(r.temperatureLevel))}>
        {r.temperature === null ? '—' : `${r.temperature} °C`}
      </td>
      <td className="whitespace-nowrap px-2 text-xs">
        {r.wear !== null ? <><span className={clsx('font-mono', levelText(r.wearLevel))}>{r.wear} %</span> <span className="text-muted">usure</span></>
          : r.reallocated !== null ? <><span className={clsx('font-mono', r.reallocated > 0 ? 'text-red-300' : 'text-zinc-100')}>{r.reallocated}</span> <span className="text-muted">réalloués</span></>
          : r.powerOnHours === null && <span className="text-muted">—</span>}
        {r.powerOnHours !== null && <span className={clsx('text-muted', (r.wear !== null || r.reallocated !== null) && 'ml-2')} title="Heures de fonctionnement">{(r.powerOnHours / 8766).toLocaleString('fr', { maximumFractionDigits: 1 })} an{r.powerOnHours >= 2 * 8766 ? 's' : ''}</span>}
      </td>
      <td className="whitespace-nowrap px-2">
        {r.smart === 'failed' ? <Badge tone="bad">Défaillant</Badge> : r.smart === 'error' ? <Badge tone="warn">Erreur</Badge> : r.smart === 'standby' ? <span title="Disque en veille : dernières valeurs connues"><Badge tone="neutral">Veille</Badge></span> : r.smart === 'ok' ? <Badge tone="ok">Sain</Badge> : <span className="text-xs text-muted">—</span>}
      </td>
      <td className="whitespace-nowrap px-2">
        <span className="inline-flex flex-wrap gap-1">
          {r.tags.length ? r.tags.map((tag) => (
            <span key={tag.label} className={clsx('rounded-sm px-1.5 py-0.5 text-[11px] font-semibold', tag.level === 'alert' ? 'bg-red-500/15 text-red-300' : tag.level === 'warn' ? 'bg-amber-500/15 text-amber-300' : 'bg-indigo-500/15 text-indigo-300')}>{tag.label}</span>
          )) : <span className="text-xs text-muted">—</span>}
        </span>
      </td>
    </tr>
  );
}

