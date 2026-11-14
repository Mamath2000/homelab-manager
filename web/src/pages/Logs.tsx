import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUp, ChevronDown, ChevronRight, Copy, Filter, FilterX, ListCollapse, Pause, Radio, RefreshCw, ScrollText, Search, X } from 'lucide-react';
import { HeaderTitle } from '../components/HeaderSlot';
import { Badge, Button, Empty, Modal, Spinner } from '../components/ui';
import { api, logParams, type LogHits, type LogLevel, type LogMatrix, type LogQuery, type LogRow } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useHosts, useLogServers, useSites, useTags } from '../lib/queries';
import { toneBadge, type Tone } from '../lib/status';
import { useToast } from '../lib/toast';

// Journals of the hosts (hub/src/routes/logs.ts): the hosts send them in syslog to a log server, the hub reads them
// there. Every filter lives in the address of the page, so that a view can be shared or reopened from a host.

const PAGE = 200;
// rows kept on screen while following live
const LIVE_MAX = 1000;

const PERIODS = [
  { id: '15m', label: '15 min' },
  { id: '1h', label: '1 h' },
  { id: '6h', label: '6 h' },
  { id: '24h', label: '24 h' },
  { id: '7d', label: '7 j' },
] as const;
const DEFAULT_PERIOD = '1h';
const DEFAULT_SEVERITY = 4;
const ALL_SEVERITIES = 7; // debug and worse: every journal

// the worst severity kept, as a choice: each one includes the ones before it
const SEVERITY_CHOICES = [
  { id: '3', label: 'Erreurs' },
  { id: '4', label: 'Avertissements' },
  { id: '5', label: 'Notices' },
  { id: '6', label: 'Infos' },
  { id: '7', label: 'Tout' },
];

const LEVEL_META: Record<LogLevel, { label: string; text: string; bar: string }> = {
  emerg: { label: 'urgence', text: 'text-red-300', bar: 'bg-red-600' },
  alert: { label: 'alerte', text: 'text-red-300', bar: 'bg-red-600' },
  crit: { label: 'critique', text: 'text-red-300', bar: 'bg-red-500' },
  error: { label: 'erreur', text: 'text-red-400', bar: 'bg-red-400' },
  warning: { label: 'avert.', text: 'text-amber-300', bar: 'bg-amber-400' },
  notice: { label: 'notice', text: 'text-sky-300', bar: 'bg-sky-400' },
  info: { label: 'info', text: 'text-zinc-400', bar: 'bg-zinc-500' },
  debug: { label: 'debug', text: 'text-zinc-500', bar: 'bg-zinc-700' },
};

const STEP_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 };
const stepMs = (step: string) => parseInt(step, 10) * (STEP_MS[step.slice(-1)] ?? 60_000);

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
// time of a row: the hour to the millisecond, with the day when it is not today
function rowTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hour = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return d.toDateString() === new Date().toDateString() ? hour : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hour}`;
}
const barLabel = (iso: string, long: boolean) => {
  const d = new Date(iso);
  return long ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// value of a datetime-local input, in local time
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);

// The filters as the address of the page carries them.
function useLogFilters() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => {
    const sev = params.get('sev');
    return {
      role: params.get('role') ?? '',
      host: params.get('host') ?? '',
      hostname: params.get('hostname') ?? '',
      site: list(params.get('site')),
      tag: params.get('tag') ?? '',
      severity: sev !== null && /^[0-7]$/.test(sev) ? +sev : DEFAULT_SEVERITY,
      // a level of the matrix (a row or a cell): its severities only, over the severity above
      level: MATRIX_ROWS.find((r) => r.level === params.get('level'))?.level ?? '',
      app: list(params.get('app')),
      notApp: list(params.get('notApp')),
      source: list(params.get('source')),
      q: params.get('q') ?? '',
      from: params.get('from') ?? DEFAULT_PERIOD,
      to: params.get('to') ?? '',
      live: params.get('live') === '1',
    };
  }, [params]);
  const set = (patch: Partial<Record<keyof typeof filters, string | number | boolean | string[]>>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      const key = k === 'severity' ? 'sev' : k;
      const s = Array.isArray(v) ? v.join(',') : typeof v === 'boolean' ? (v ? '1' : '') : String(v);
      const isDefault = (k === 'severity' && v === DEFAULT_SEVERITY) || (k === 'from' && v === DEFAULT_PERIOD);
      if (!s || isDefault) next.delete(key);
      else next.set(key, s);
    }
    setParams(next, { replace: true });
  };
  return [filters, set, () => setParams(new URLSearchParams(), { replace: true })] as const;
}
type Filters = ReturnType<typeof useLogFilters>[0];

// The severities kept: a level of the matrix alone, else the given one and worse.
const severityOf = (f: Filters): Pick<LogQuery, 'severity' | 'minSeverity'> => {
  const row = MATRIX_ROWS.find((r) => r.level === f.level);
  return row ? { severity: row.max, minSeverity: row.min } : { severity: f.severity };
};

const toQuery = (f: Filters): LogQuery => ({
  ...(f.role ? { role: f.role } : {}),
  ...(f.host ? { host: [f.host] } : {}),
  ...(f.hostname ? { hostname: [f.hostname] } : {}),
  ...(f.site.length ? { site: f.site } : {}),
  ...(f.tag ? { tag: f.tag } : {}),
  ...severityOf(f),
  ...(f.app.length ? { app: f.app } : {}),
  ...(f.notApp.length ? { notApp: f.notApp } : {}),
  ...(f.source.length ? { source: f.source } : {}),
  ...(f.q ? { q: f.q } : {}),
});

// Stacked bars per severity over the range; a click on a bar, or a drag over several, zooms on them.
function Histogram({ hits, onZoom }: { hits: LogHits; onZoom: (from: string, to: string) => void }) {
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const n = hits.timestamps.length;
  const totals = hits.timestamps.map((_, i) => hits.series.reduce((sum, s) => sum + s.values[i], 0));
  const max = Math.max(1, ...totals);
  const step = stepMs(hits.step);
  const long = step >= 3600_000 * 3;
  const lo = drag ? Math.min(drag.a, drag.b) : -1;
  const hi = drag ? Math.max(drag.a, drag.b) : -1;
  const apply = () => {
    if (!drag) return;
    onZoom(hits.timestamps[lo], new Date(Date.parse(hits.timestamps[hi]) + step).toISOString());
    setDrag(null);
  };
  // the worst severities at the bottom of each bar
  const series = [...hits.series].sort((a, b) => a.severity - b.severity);
  if (!n) return <div className="panel flex h-full min-h-[8rem] items-center justify-center p-3 text-xs text-muted">Aucun journal pour cette sélection.</div>;
  return (
    <div className="panel flex min-h-[8rem] flex-1 flex-col p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="text-zinc-300">{totals.reduce((a, b) => a + b, 0).toLocaleString('fr-FR')} lignes</span>
        {series.map((s) => (
          <span key={s.level} className="inline-flex items-center gap-1.5">
            <span className={clsx('h-2 w-2 rounded-sm', LEVEL_META[s.level].bar)} />
            {LEVEL_META[s.level].label} {s.total.toLocaleString('fr-FR')}
          </span>
        ))}
        <span className="ml-auto hidden sm:inline">Cliquer ou glisser sur les barres pour zoomer</span>
      </div>
      <div className="flex min-h-[6rem] flex-1 select-none items-end gap-px" onMouseLeave={() => setDrag(null)} onMouseUp={apply} role="img" aria-label="Nombre de lignes par tranche de temps et par criticité">
        {hits.timestamps.map((t, i) => (
          <div
            key={t}
            className={clsx('flex h-full min-w-0 flex-1 cursor-zoom-in flex-col-reverse rounded-sm', i >= lo && i <= hi ? 'bg-emerald-500/20' : 'hover:bg-raised')}
            title={`${barLabel(t, true)} · ${totals[i].toLocaleString('fr-FR')} ligne${totals[i] > 1 ? 's' : ''}`}
            onMouseDown={(e) => (e.preventDefault(), setDrag({ a: i, b: i }))}
            onMouseEnter={() => drag && setDrag({ a: drag.a, b: i })}
          >
            {series.map((s) => (s.values[i] ? <div key={s.level} className={LEVEL_META[s.level].bar} style={{ height: `${Math.max((s.values[i] / max) * 100, 2)}%` }} /> : null))}
          </div>
        ))}
      </div>
      {n > 0 && (
        <div className="mt-1 flex justify-between font-mono text-[10px] text-zinc-500">
          <span>{barLabel(hits.timestamps[0], long)}</span>
          {n > 2 && <span>{barLabel(hits.timestamps[Math.floor(n / 2)], long)}</span>}
          <span>{barLabel(new Date(Date.parse(hits.timestamps[n - 1]) + step).toISOString(), long)}</span>
        </div>
      )}
    </div>
  );
}

// The rows of the matrix: the three worst severities together, then one row per level. It filters the page below it. A
// row keeps its level only, a column its source at every level, a cell its source at its level; a second click on it
// takes the filter off.
const MATRIX_ROWS: { level: LogLevel; min: number; max: number; severities: number[]; tone: Tone }[] = [
  { level: 'crit', min: 0, max: 2, severities: [0, 1, 2], tone: 'bad' },
  { level: 'error', min: 3, max: 3, severities: [3], tone: 'bad' },
  { level: 'warning', min: 4, max: 4, severities: [4], tone: 'warn' },
  { level: 'notice', min: 5, max: 5, severities: [5], tone: 'info' },
  { level: 'info', min: 6, max: 6, severities: [6], tone: 'neutral' },
  { level: 'debug', min: 7, max: 7, severities: [7], tone: 'neutral' },
];
const NO_SOURCE = '_none';
// a click upstream (a site, the matrix) lets the sender picked go: it may not be in the new selection
const NO_SENDER = { host: '', hostname: '' };
const SOURCE_LABEL: Record<string, string> = { host: 'hôtes', esphome: 'ESPHome', omada: 'Omada', docker: 'Docker', [NO_SOURCE]: 'sans source' };

// The sites as blocks to pick: a click selects the site, a second one lets it go, several can be held, none is every site.
// It narrows the matrix, the senders and the list.
function SiteBlocks({ sites, selected, onSite }: { sites: { id: string; name: string }[]; selected: string[]; onSite: (id: string) => void }) {
  return (
    <div className="flex shrink-0 flex-col justify-center gap-1" role="group" aria-label="Sites">
      {sites.map((s) => {
        const on = selected.includes(s.id);
        return (
          <button key={s.id} type="button" aria-pressed={on} title={on ? 'Ne plus filtrer' : `Ajouter ${s.name}`} onClick={() => onSite(s.id)} className={clsx('panel truncate px-3 py-1.5 text-left text-xs font-semibold text-muted hover:text-zinc-200', on && 'bg-emerald-500/10 !text-zinc-100 ring-1 ring-emerald-500')}>
            {s.name}
          </button>
        );
      })}
    </div>
  );
}

// The senders of the period as a cloud of buttons: the more problems (error or worse) a sender has, the bigger and the
// earlier it is. A click keeps its journals only, a second one lets it go.
function SenderCloud({ senders, current, onPick }: { senders: { key: string; label: string; count: number; errors: number }[]; current: string; onPick: (key: string) => void }) {
  const sorted = [...senders].sort((a, b) => b.errors - a.errors || b.count - a.count || a.label.localeCompare(b.label, 'fr'));
  const top = Math.log1p(Math.max(0, ...sorted.map((x) => x.errors)));
  return (
    <div className="panel flex h-full max-h-56 min-w-0 flex-wrap content-start items-center gap-1.5 overflow-auto px-3 py-2.5" role="group" aria-label="Émetteurs, les plus en difficulté en premier">
      {!sorted.length && <span className="m-auto text-xs text-muted">Aucun émetteur pour cette sélection.</span>}
      {sorted.map((x) => {
        const on = current === x.key;
        const size = top > 0 ? 0.7 + 0.6 * (Math.log1p(x.errors) / top) : 0.75;
        return (
          <button
            key={x.key}
            type="button"
            aria-pressed={on}
            style={{ fontSize: `${size}rem` }}
            title={`${x.label} · ${x.count.toLocaleString('fr-FR')} journaux, ${x.errors.toLocaleString('fr-FR')} erreur${x.errors > 1 ? 's' : ''} ou pire`}
            onClick={() => onPick(x.key)}
            className={clsx('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-medium leading-tight hover:brightness-125', x.errors > 0 ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-line bg-raised text-muted', on && '!border-emerald-500 !bg-emerald-500/10 !text-zinc-100 ring-1 ring-emerald-500')}
          >
            {x.label}
            {x.errors > 0 && <span className="text-[0.7em] tabular-nums opacity-80">{x.errors.toLocaleString('fr-FR')}</span>}
          </button>
        );
      })}
    </div>
  );
}

// Journals per source (columns) and per criticity (rows) over the period, for the selected sites only. Fixed: every source
// of the server is a column, every level a row, an empty cell shows "-".
function Matrix({ matrix, source, level, onSource, onLevel, onCell }: { matrix: LogMatrix; source: string[]; level: string; onSource: (s: string) => void; onLevel: (l: LogLevel) => void; onCell: (s: string, l: LogLevel) => void }) {
  const count = (src: string, severities: number[]) => matrix.cells.filter((c) => c.source === src && severities.includes(c.severity)).reduce((sum, c) => sum + c.count, 0);
  const all = [0, 1, 2, 3, 4, 5, 6, 7];
  const cols = `minmax(4.5rem,1.3fr) ${matrix.sources.length ? `repeat(${matrix.sources.length}, minmax(3rem,1fr)) ` : ''}minmax(3rem,.8fr)`;
  const head = 'flex h-5 items-center justify-center truncate rounded-sm px-1 text-[11px] font-semibold text-muted';
  const cell = 'flex h-[22px] items-center justify-center rounded-sm text-xs font-semibold tabular-nums';
  const fmt = (n: number) => (n ? n.toLocaleString('fr-FR') : '-');
  // a column alone (every level) selects no row
  const rowOn = (l: LogLevel) => level === l;
  return (
    <div className="panel flex h-full min-w-0 flex-col justify-center px-4 py-2.5">
      <div className="grid gap-0.5" style={{ gridTemplateColumns: cols }} role="grid" aria-label="Journaux par source et par criticité, la couleur est la criticité">
        <span />
        {matrix.sources.map((src) => (
          <button key={src} type="button" title={`Tout ${SOURCE_LABEL[src] ?? src}`} aria-pressed={source.includes(src)} onClick={() => onSource(src)} className={clsx(head, 'hover:bg-raised hover:text-zinc-200', source.includes(src) && 'bg-emerald-500/10 text-zinc-100 ring-1 ring-emerald-500')}>
            {SOURCE_LABEL[src] ?? src}
          </button>
        ))}
        <span className={head}>Total</span>
        {MATRIX_ROWS.map((row) => (
          <Fragment key={row.level}>
            <button type="button" title={`Seulement ${LEVEL_META[row.level].label}`} aria-pressed={rowOn(row.level)} onClick={() => onLevel(row.level)} className={clsx('flex h-[22px] min-w-0 items-center truncate rounded-sm px-1.5 text-left text-[13px] hover:bg-raised', LEVEL_META[row.level].text, rowOn(row.level) && 'bg-emerald-500/10 ring-1 ring-emerald-500')}>
              <span className="truncate">{LEVEL_META[row.level].label}</span>
            </button>
            {matrix.sources.map((src) => {
              const n = count(src, row.severities);
              const active = source.includes(src) && rowOn(row.level);
              if (!n) return <span key={src} className={clsx(cell, 'font-normal text-zinc-600', active && 'ring-2 ring-inset ring-zinc-100')}>-</span>;
              return (
                <button key={src} type="button" aria-pressed={active} title={`${SOURCE_LABEL[src] ?? src} · ${LEVEL_META[row.level].label}`} onClick={() => onCell(src, row.level)} className={clsx(cell, 'ring-1 ring-inset transition hover:brightness-125', toneBadge[row.tone], active && 'ring-2 !ring-zinc-100')}>
                  {fmt(n)}
                </button>
              );
            })}
            <span className={clsx(cell, 'font-normal text-muted')}>{fmt(matrix.sources.reduce((sum, src) => sum + count(src, row.severities), 0))}</span>
          </Fragment>
        ))}
        <span className={head}>Total</span>
        {matrix.sources.map((src) => <span key={src} className={clsx(cell, 'font-normal text-muted')}>{fmt(count(src, all))}</span>)}
        <span className={clsx(cell, 'font-normal text-zinc-300')}>{fmt(matrix.sources.reduce((sum, src) => sum + count(src, all), 0))}</span>
      </div>
    </div>
  );
}

// What surrounds a journal on its host, the journal itself highlighted.
function ContextModal({ row, role, onClose }: { row: LogRow; role: string; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['logs', 'context', role, row.hostname, row.time], queryFn: () => api.logContext(role || undefined, row.hostname, row.time) });
  const target = useRef<HTMLLIElement>(null);
  useEffect(() => {
    target.current?.scrollIntoView({ block: 'center' });
  }, [data]);
  return (
    <Modal open onClose={onClose} wide="screen" title={`Contexte · ${row.hostName}`}>
      {isLoading ? (
        <div className="flex justify-center p-10"><Spinner /></div>
      ) : error ? (
        <p className="text-sm text-red-400">{(error as Error).message}</p>
      ) : (
        <ol className="max-h-[65vh] overflow-y-auto rounded-md border border-line font-mono text-xs">
          {data!.rows.map((r, i) => {
            const self = r.time === row.time && r.message === row.message;
            return (
              <li key={`${r.time}:${i}`} ref={self ? target : undefined} className={clsx('flex gap-3 border-b border-line/60 px-3 py-1 last:border-b-0', self && 'bg-emerald-500/10')}>
                <span className="shrink-0 text-zinc-500">{rowTime(r.time)}</span>
                <span className={clsx('w-14 shrink-0', LEVEL_META[r.level].text)}>{LEVEL_META[r.level].label}</span>
                <span className="w-28 shrink-0 truncate text-zinc-400" title={r.app}>{r.app || '—'}</span>
                <span className="min-w-0 whitespace-pre-wrap break-words text-zinc-200">{r.message}</span>
              </li>
            );
          })}
        </ol>
      )}
      <p className="mt-2 text-xs text-muted">Les 20 lignes d'avant et d'après sur cet hôte, toutes criticités et applications confondues (une heure de part et d'autre au plus).</p>
    </Modal>
  );
}

function Row({ row, open, onToggle, onFilter, onContext }: { row: LogRow; open: boolean; onToggle: () => void; onFilter: (patch: Parameters<ReturnType<typeof useLogFilters>[1]>[0]) => void; onContext: () => void }) {
  const toast = useToast();
  const meta = LEVEL_META[row.level];
  const fields: [string, string][] = [
    ['Hôte', row.hostname],
    ['Application', row.app ? `${row.app}${row.pid ? `[${row.pid}]` : ''}` : ''],
    ['Facility', row.facility],
    ['Criticité', `${meta.label} (${row.severity})`],
    ['Reçu de', row.remoteIp ?? ''],
    ['Date', new Date(row.time).toLocaleString('fr-FR')],
    ...Object.entries(row.fields ?? {}),
  ].filter((f): f is [string, string] => !!f[1]);
  return (
    <li className={clsx('border-b border-line/60 last:border-b-0', open && 'bg-raised/40')}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-x-3 px-3 py-1.5 text-left font-mono text-xs hover:bg-raised/40 max-md:flex-wrap">
        <span className="flex shrink-0 items-center gap-1.5 text-zinc-500">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {rowTime(row.time)}
        </span>
        <span className={clsx('w-14 shrink-0', meta.text)}>{meta.label}</span>
        <span className="w-32 shrink-0 truncate text-zinc-300" title={row.hostName}>{row.hostName}</span>
        <span className="w-28 shrink-0 truncate text-zinc-400" title={row.app}>{row.app || '—'}</span>
        <span className={clsx('min-w-0 flex-1 text-zinc-200 max-md:basis-full', open ? 'whitespace-pre-wrap break-words' : 'truncate')}>{row.message}</span>
      </button>
      {open && (
        <div className="space-y-3 px-3 pb-3 pl-8 text-xs">
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
            {fields.map(([k, v]) => (
              <div key={k} className="flex min-w-0 gap-2">
                <dt className="shrink-0 text-muted">{k}</dt>
                <dd className="min-w-0 break-all font-mono text-zinc-300">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" icon={ListCollapse} onClick={onContext}>Voir le contexte</Button>
            <Button size="sm" icon={Filter} onClick={() => onFilter(row.hostId ? { host: row.hostId, hostname: '' } : { hostname: row.hostname, host: '' })}>Cet hôte</Button>
            {row.app && <Button size="sm" icon={Filter} onClick={() => onFilter({ app: [row.app], notApp: [] })}>Cette application</Button>}
            {row.app && <Button size="sm" icon={FilterX} onClick={() => onFilter({ notApp: row.app, app: [] })}>Exclure {row.app}</Button>}
            <Button
              size="sm"
              icon={Copy}
              onClick={() => navigator.clipboard.writeText(`${row.time} ${row.hostname} ${row.app}${row.pid ? `[${row.pid}]` : ''}: ${row.message}`).then(() => toast.success('Ligne copiée'), () => toast.error('Copie impossible'))}
            >
              Copier
            </Button>
            {row.hostId && <Link to={`/hosts/${row.hostId}`} className="inline-flex items-center px-2 text-emerald-400 hover:underline">Fiche de l'hôte</Link>}
          </div>
        </div>
      )}
    </li>
  );
}

// Live tail of the journals that match the filters: newest first, paused while the reader is down the list.
type TailState = { key: string; rows: LogRow[]; waiting: number; error: string | null };
const NO_TAIL: TailState = { key: '', rows: [], waiting: 0, error: null };

function useLiveTail(enabled: boolean, query: LogQuery) {
  // the state belongs to the filters it was read with: other filters start from nothing
  const [state, setState] = useState<TailState>(NO_TAIL);
  const queue = useRef<LogRow[]>([]);
  const paused = useRef(false);
  const key = logParams(query);
  const update = (patch: (s: TailState) => Partial<TailState>) =>
    setState((s) => {
      const base = s.key === key ? s : { ...NO_TAIL, key };
      return { ...base, ...patch(base) };
    });
  const flush = () => {
    const fresh = queue.current.reverse();
    queue.current = [];
    update((s) => ({ waiting: 0, rows: fresh.length ? [...fresh, ...s.rows].slice(0, LIVE_MAX) : s.rows }));
  };
  useEffect(() => {
    queue.current = [];
    if (!enabled) return;
    const es = new EventSource(`/api/logs/tail?${key}`);
    es.onopen = () => update(() => ({ error: null }));
    es.onmessage = (e) => {
      queue.current.push(JSON.parse(e.data) as LogRow);
      if (queue.current.length > LIVE_MAX) queue.current.shift();
      if (paused.current) update(() => ({ waiting: queue.current.length }));
    };
    es.addEventListener('end', (e) => update(() => ({ error: (JSON.parse((e as MessageEvent).data) as { error: string }).error })));
    es.onerror = () => update((s) => ({ error: s.error ?? 'suivi interrompu, reconnexion…' }));
    // rows are shown by batches: a burst does not redraw the list for each of them
    const timer = setInterval(() => !paused.current && queue.current.length && flush(), 500);
    const onScroll = () => {
      paused.current = window.scrollY > 240;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      es.close();
      clearInterval(timer);
      window.removeEventListener('scroll', onScroll);
    };
  }, [enabled, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const resume = () => {
    window.scrollTo({ top: 0 });
    paused.current = false;
    flush();
  };
  const cur = enabled && state.key === key ? state : NO_TAIL;
  return { rows: cur.rows, waiting: cur.waiting, error: cur.error, resume };
}

// The text looked for in the messages: applied on Enter or when the field is left.
function SearchBox({ initial, onApply }: { initial: string; onApply: (q: string) => void }) {
  const [text, setText] = useState(initial);
  const apply = () => text.trim() !== initial && onApply(text.trim());
  return (
    <form className="col-span-2 min-w-0" onSubmit={(e) => (e.preventDefault(), apply())}>
      <span className="mb-1 block text-xs text-muted">Texte du message</span>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <input className="input w-full pl-8" value={text} onChange={(e) => setText(e.target.value)} onBlur={apply} placeholder="failed, oom, 192.168.1.20…" spellCheck={false} />
      </div>
    </form>
  );
}

export function Logs() {
  const qc = useQueryClient();
  const [f, set, clear] = useLogFilters();
  const { data: servers = [], isLoading: loadingServers } = useLogServers();
  const { data: hosts = [] } = useHosts();
  const { data: sites = [] } = useSites();
  const { data: tags = [] } = useTags();
  const [opened, setOpened] = useState<string | null>(null);
  const [context, setContext] = useState<LogRow | null>(null);
  const [custom, setCustom] = useState(false);

  const query = toQuery(f);
  const range = { from: f.from, ...(f.to ? { to: f.to } : {}) };
  const hasServer = servers.length > 0;
  const absolute = !/^\d+[mhd]$/.test(f.from);

  // The head of the page cascades, the period over all of it: the sites narrow the matrix, the sites and the matrix (source,
  // criticity) the senders, the sites, the matrix and the sender the histogram. The filters above the list touch the list
  // only.
  const head: LogQuery = { ...(f.role ? { role: f.role } : {}), ...(f.site.length ? { site: f.site } : {}), ...range };
  const picked: LogQuery = { ...head, ...(f.source.length ? { source: f.source } : {}), ...(f.level || f.severity !== DEFAULT_SEVERITY ? severityOf(f) : {}) };
  const sender: LogQuery = { ...picked, ...severityOf(f), ...(f.host ? { host: [f.host] } : {}), ...(f.hostname ? { hostname: [f.hostname] } : {}) };
  const matrix = useQuery({ queryKey: ['logs', 'matrix', head], queryFn: () => api.logMatrix(head), enabled: hasServer, placeholderData: keepPreviousData });
  const sources = useQuery({ queryKey: ['logs', 'sources', picked], queryFn: () => api.logSources(picked), enabled: hasServer, placeholderData: keepPreviousData });
  const hits = useQuery({ queryKey: ['logs', 'hits', sender], queryFn: () => api.logHits(sender), enabled: hasServer, placeholderData: keepPreviousData });
  const apps = useQuery({ queryKey: ['logs', 'apps', query, range], queryFn: () => api.logFields('app', { ...query, ...range }), enabled: hasServer && !f.live, placeholderData: keepPreviousData, staleTime: 30_000 });
  const rows = useInfiniteQuery({
    queryKey: ['logs', 'rows', query, range],
    queryFn: ({ pageParam }) => api.logs({ ...query, ...range }, PAGE, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.more ? last.rows[last.rows.length - 1]?.time : undefined),
    enabled: hasServer && !f.live,
    placeholderData: keepPreviousData,
  });
  const live = useLiveTail(hasServer && f.live, query);

  if (loadingServers) return <div className="flex justify-center p-20"><Spinner /></div>;
  if (!hasServer) {
    return (
      <>
        <HeaderTitle icon={ScrollText} title="Logs" />
        <Empty icon={ScrollText} title="Aucun serveur de logs">Déclarer un rôle « Serveur de logs » dans Paramètres › Rôles : les hôtes y envoient leurs journaux, lisibles ici.</Empty>
      </>
    );
  }

  const shown = f.live ? live.rows : (rows.data?.pages.flatMap((p) => p.rows) ?? []);
  const failure = (matrix.error ?? (f.live ? null : rows.error)) as Error | null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['logs'] });
  const rowKey = (r: LogRow, i: number) => `${r.time}|${r.hostname}|${i}`;

  // the senders of the selection, a host of the hub keeping the name it has there; the one picked stays shown
  const senders = sources.data?.sources ?? [];
  const current = f.host ? `h:${f.host}` : f.hostname ? `n:${f.hostname}` : '';
  const cloud = senders.map((x) => ({ key: x.hostId ? `h:${x.hostId}` : `n:${x.hostname}`, label: x.hostName, count: x.count, errors: x.errors }));
  if (current && sources.isSuccess && !cloud.some((o) => o.key === current)) cloud.push({ key: current, label: f.host ? (hosts.find((h) => h.id === f.host)?.name ?? f.host) : f.hostname, count: 0, errors: 0 });
  // the server received nothing at all over the period, whatever the sites
  const nothing = matrix.isSuccess && !matrix.data.sources.length;
  const filtered = !!(f.host || f.hostname || f.site.length || f.tag || f.app.length || f.notApp.length || f.source.length || f.q || f.level || f.severity !== DEFAULT_SEVERITY || f.from !== DEFAULT_PERIOD || f.to);
  const appChoices = [...new Set([...f.app, ...(apps.data?.values.map((v) => v.value) ?? [])])];

  const field = 'mb-1 block text-xs text-muted';
  const small = 'input h-7 py-0 text-xs';

  return (
    <>
      <HeaderTitle icon={ScrollText} title="Logs">
        {servers.length === 1 && <span className="truncate text-xs text-muted">{servers[0].name}</span>}
      </HeaderTitle>

      <div className="mb-3 grid gap-3 xl:grid-cols-[minmax(0,5fr)_minmax(0,3fr)_minmax(0,4fr)]">
        <div className="flex min-w-0 gap-3">
          {sites.length > 0 && <SiteBlocks sites={sites} selected={f.site} onSite={(id) => set({ site: f.site.includes(id) ? f.site.filter((x) => x !== id) : [...f.site, id], ...NO_SENDER })} />}
          <div className={clsx('min-w-0 flex-1', matrix.isPlaceholderData && 'opacity-60')}>
            <Matrix
              matrix={{ sources: [...new Set([...(matrix.data?.sources ?? []), ...f.source])], cells: matrix.data?.cells ?? [] }}
              source={f.source}
              level={f.level}
              onSource={(s) => {
                // the whole column; from one of its cells, the whole column too
                const same = f.source.includes(s) && !f.level;
                set({ source: same ? [] : [s], level: '', severity: same ? DEFAULT_SEVERITY : ALL_SEVERITIES, ...NO_SENDER });
              }}
              onLevel={(l) => set({ level: f.level === l ? '' : l, ...NO_SENDER })}
              onCell={(s, l) => {
                const same = f.source.includes(s) && f.level === l;
                set({ source: same ? [] : [s], level: same ? '' : l, severity: DEFAULT_SEVERITY, ...NO_SENDER });
              }}
            />
          </div>
        </div>
        <div className={clsx('min-w-0', sources.isPlaceholderData && 'opacity-60')}>
          <SenderCloud senders={cloud} current={current} onPick={(k) => set({ host: k.startsWith('h:') && k !== current ? k.slice(2) : '', hostname: k.startsWith('n:') && k !== current ? k.slice(2) : '' })} />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <div className={clsx('flex min-h-0 flex-1 flex-col', hits.isPlaceholderData && 'opacity-60')}>
            <Histogram hits={hits.data ?? { step: '1m', timestamps: [], series: [] }} onZoom={(from, to) => (setCustom(false), set({ from, to }))} />
          </div>
          {/* what the whole page is read over, and the way back to nothing picked: not a filter of the list */}
          <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted">
            {(absolute || custom) && (
              <>
                <input
                  type="datetime-local"
                  aria-label="Du"
                  className={small}
                  value={absolute ? toLocalInput(f.from) : ''}
                  onChange={(e) => e.target.value && set({ from: new Date(e.target.value).toISOString(), to: f.to || new Date().toISOString() })}
                />
                <span>→</span>
                <input type="datetime-local" aria-label="Au" className={small} value={f.to ? toLocalInput(f.to) : ''} disabled={!absolute} onChange={(e) => e.target.value && set({ to: new Date(e.target.value).toISOString() })} />
              </>
            )}
            <label className="inline-flex items-center gap-1.5">
              Période
              <select
                className={small}
                value={absolute || custom ? 'custom' : f.from}
                onChange={(e) => {
                  if (e.target.value === 'custom') return setCustom(true);
                  setCustom(false);
                  set({ from: e.target.value, to: '' });
                }}
              >
                {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                <option value="custom">Personnalisée…</option>
              </select>
            </label>
            <Button size="sm" icon={FilterX} disabled={!filtered} onClick={() => (setCustom(false), clear())}>Tout effacer</Button>
          </div>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        {tags.length > 0 && (
          <label className="min-w-0">
            <span className={field}>Tag</span>
            <select className="input w-full" value={f.tag} onChange={(e) => set({ tag: e.target.value })}>
              <option value="">Tous</option>
              {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}
        <label className="min-w-0">
          <span className={field}>Application</span>
          <select className="input w-full" value={f.app[0] ?? ''} onChange={(e) => set({ app: e.target.value ? [e.target.value] : [] })} disabled={f.live && !f.app.length}>
            <option value="">Toutes</option>
            {appChoices.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        {servers.length > 1 && (
          <label className="min-w-0">
            <span className={field}>Serveur</span>
            <select className="input w-full" value={f.role || servers[0].id} onChange={(e) => set({ role: e.target.value === servers[0].id ? '' : e.target.value })}>
              {servers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
        )}
        <SearchBox key={f.q} initial={f.q} onApply={(q) => set({ q })} />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {current && (
          <button type="button" className="inline-flex items-center gap-1 rounded-md border border-line bg-raised px-2 py-1 text-xs text-zinc-300 hover:text-zinc-100" title="Ne plus filtrer" onClick={() => set({ host: '', hostname: '' })}>
            {cloud.find((o) => o.key === current)?.label ?? current} <X className="h-3 w-3" />
          </button>
        )}
        {f.source.map((s) => (
          <button key={s} type="button" className="inline-flex items-center gap-1 rounded-md border border-line bg-raised px-2 py-1 text-xs text-zinc-300 hover:text-zinc-100" title="Ne plus filtrer" onClick={() => set({ source: f.source.filter((x) => x !== s) })}>
            {SOURCE_LABEL[s] ?? s} <X className="h-3 w-3" />
          </button>
        ))}
        {f.notApp.map((a) => (
          <button key={a} type="button" className="inline-flex items-center gap-1 rounded-md border border-line bg-raised px-2 py-1 text-xs text-zinc-300 hover:text-zinc-100" title="Ne plus exclure" onClick={() => set({ notApp: f.notApp.filter((x) => x !== a) })}>
            sans {a} <X className="h-3 w-3" />
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {!f.live && <Button size="sm" icon={RefreshCw} loading={rows.isRefetching || hits.isRefetching} onClick={() => void refresh()}>Actualiser</Button>}
          <Button size="sm" variant={f.live ? 'primary' : 'secondary'} icon={f.live ? Pause : Radio} onClick={() => set({ live: !f.live })}>{f.live ? 'Arrêter le direct' : 'Direct'}</Button>
        </div>
      </div>

      {failure ? (
        <div className="panel p-4 text-sm text-red-400">{failure.message}</div>
      ) : nothing && !f.live ? (
        <div className="panel">
          <Empty icon={ScrollText} title="Aucun journal reçu">
            Le serveur de logs n'a rien reçu sur la période. Activer l'option « Envoi des journaux » dans Paramètres › Standardisation (ou sur la fiche d'un hôte),
            puis l'appliquer : rsyslog est installé sur l'hôte et envoie ses journaux vers {servers[0].target || 'le serveur'}.
          </Empty>
        </div>
      ) : (
        <>
          {f.live && (
            <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
              <Badge tone={live.error ? 'warn' : 'ok'}>{live.error ?? 'en direct'}</Badge>
              <span className="text-muted">Les nouvelles lignes arrivent en haut ; la période est ignorée. Descendre dans la liste met l'affichage en pause.</span>
            </div>
          )}
          {f.live && live.waiting > 0 && (
            <button type="button" onClick={live.resume} className="fixed bottom-6 left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-2 rounded-full border border-emerald-500/40 bg-panel px-4 py-2 text-sm text-emerald-300 shadow-lg hover:bg-raised">
              <ArrowUp className="h-4 w-4" />
              {live.waiting >= LIVE_MAX ? `${LIVE_MAX}+` : live.waiting} nouvelle{live.waiting > 1 ? 's' : ''} ligne{live.waiting > 1 ? 's' : ''}
            </button>
          )}
          <div className={clsx('panel overflow-hidden', rows.isPlaceholderData && !f.live && 'opacity-60')}>
            {!f.live && rows.isLoading ? (
              <div className="flex justify-center p-10"><Spinner /></div>
            ) : !shown.length ? (
              <Empty icon={ScrollText} title={f.live ? 'En attente de journaux…' : 'Aucune ligne pour ces filtres'}>
                {!f.live && f.level ? <>Seules les lignes de niveau « {LEVEL_META[f.level as LogLevel].label} » sont affichées : choisir une autre case de la matrice ou élargir la période.</> : !f.live && f.severity < 7 && <>Seules les lignes de criticité « {SEVERITY_CHOICES.find((c) => +c.id === Math.max(3, f.severity))?.label.toLowerCase()} » ou pire sont affichées : élargir la criticité ou la période.</>}
              </Empty>
            ) : (
              <ul>
                {shown.map((r, i) => (
                  <Fragment key={rowKey(r, i)}>
                    <Row
                      row={r}
                      open={opened === rowKey(r, i)}
                      onToggle={() => setOpened(opened === rowKey(r, i) ? null : rowKey(r, i))}
                      onFilter={(patch) => {
                        // "exclude": added to the ones already excluded
                        if (typeof patch.notApp === 'string') set({ ...patch, notApp: [...new Set([...f.notApp, patch.notApp])] });
                        else set(patch);
                        setOpened(null);
                      }}
                      onContext={() => setContext(r)}
                    />
                  </Fragment>
                ))}
              </ul>
            )}
          </div>
          {!f.live && shown.length > 0 && (
            <div className="mt-3 flex items-center justify-center gap-3 text-xs text-muted">
              <span>{shown.length.toLocaleString('fr-FR')} ligne{shown.length > 1 ? 's' : ''} affichée{shown.length > 1 ? 's' : ''}{rows.dataUpdatedAt ? ` · lu ${timeAgo(rows.dataUpdatedAt)}` : ''}</span>
              {rows.hasNextPage && <Button size="sm" loading={rows.isFetchingNextPage} onClick={() => void rows.fetchNextPage()}>Charger plus ancien</Button>}
            </div>
          )}
        </>
      )}
      {context && <ContextModal row={context} role={f.role} onClose={() => setContext(null)} />}
    </>
  );
}
