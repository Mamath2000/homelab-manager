import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Cloud, HardDrive } from 'lucide-react';
import type { BackupGroup, BackupsView, BackupStatsView, BackupUsageView } from '../lib/api';
import { formatBytes, formatDuration, scaleTop } from '../lib/backups';
import { timeAgo } from '../lib/format';
import { useBackupStats, useBackupUsage } from '../lib/queries';

const DAY = 86_400_000;
const date = (t: number, o: Intl.DateTimeFormatOptions) => new Date(t).toLocaleDateString('fr-FR', o);

// Width of an element, followed: the charts are drawn in pixels so that their text keeps its size.
// The element can mount after the first render (empty state, data loading), hence the state-held node.
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [el, setEl] = useState<T | null>(null);
  const [w, setW] = useState(0);
  const attach = useCallback((node: T | null) => {
    ref.current = node;
    setEl(node);
  }, []);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.round(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [attach, w, ref] as const;
}

// Top of an axis: a round number above the value, so the three ticks (0, half, top) read easily.
function niceTop(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1))));
  return (([1, 2, 3, 4, 5, 6, 8, 10].find((m) => m * p >= v) ?? 10) * p);
}

// --- status ------------------------------------------------------------------------------

// Followed backups by state, last day with a backup and the 30 last days.
export function StateBand({ groups, days }: { groups: BackupGroup[]; days: BackupStatsView['days'] | undefined }) {
  const ok = groups.filter((g) => g.state === 'ok').length;
  const late = groups.filter((g) => g.state === 'stale').length;
  const bad = groups.filter((g) => g.state === 'failed' || g.state === 'task_failed' || g.state === 'gone').length;
  const other = groups.length - ok - late - bad;
  const parts = [
    { n: ok, label: 'à jour', bar: 'bg-emerald-500', dot: 'rounded-full bg-emerald-500' },
    { n: late, label: 'en retard', bar: 'bg-amber-400', dot: 'rounded-[2px] bg-amber-400' },
    { n: bad, label: 'en échec / disparues', bar: 'bg-red-500', dot: 'rotate-45 scale-90 rounded-[1px] bg-red-500' },
    { n: other, label: 'autres', bar: 'bg-zinc-600', dot: 'rounded-full bg-zinc-600' },
  ].filter((p) => p.n > 0);
  const list = days ?? [];
  const last = [...list].reverse().find((d) => d.count > 0);
  const l30 = list.slice(-30);
  const tot = l30.reduce((a, d) => ({ up: a.up + d.uploaded, dur: a.dur + d.duration, failed: a.failed + d.failed, active: a.active + (d.count ? 1 : 0) }), { up: 0, dur: 0, failed: 0, active: 0 });
  return (
    <section className="panel grid divide-y divide-line md:grid-cols-[1.3fr_1fr_1fr] md:divide-x md:divide-y-0" aria-label="État des sauvegardes">
      <div className="flex min-w-0 flex-col gap-1.5 px-5 py-4">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted">Suivi</span>
        <div className="text-2xl font-semibold leading-tight tabular-nums text-zinc-100">
          {ok} <span className="text-sm font-normal text-muted">sur {groups.length} à jour</span>
        </div>
        <div className="flex h-2 gap-0.5" role="img" aria-label={parts.map((p) => `${p.n} ${p.label}`).join(', ')}>
          {parts.map((p) => <i key={p.label} className={clsx('block rounded-[2px]', p.bar)} style={{ flex: p.n }} />)}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-300">
          {parts.map((p) => (
            <span key={p.label} className="flex items-center gap-1.5"><span className={clsx('inline-block h-2 w-2', p.dot)} />{p.n} {p.label}</span>
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 px-5 py-4">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted">Dernière sauvegarde</span>
        {last ? (
          <>
            <div className="text-2xl font-semibold leading-tight text-zinc-100">{date(last.day, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 tabular-nums">
              <Kpi value={formatBytes(last.uploaded)} label="transférés" />
              <Kpi value={formatDuration(last.duration)} label="cumulé" />
              <Kpi value={String(last.count)} label={`job${last.count > 1 ? 's' : ''}${last.failed ? `, ${last.failed} en échec` : ', 0 échec'}`} />
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">Aucune statistique pour l’instant.</p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 px-5 py-4">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted">30 derniers jours</span>
        <div className="text-2xl font-semibold leading-tight tabular-nums text-zinc-100">{formatBytes(tot.up)}</div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 tabular-nums">
          <Kpi value={formatDuration(tot.active ? tot.dur / tot.active : 0)} label="par jour en moyenne" />
          <Kpi value={String(tot.failed)} label={`échec${tot.failed > 1 ? 's' : ''}`} />
        </div>
      </div>
    </section>
  );
}

function Kpi({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex flex-col">
      <b className="text-base font-semibold text-zinc-100">{value}</b>
      <span className="text-xs text-muted">{label}</span>
    </span>
  );
}

// --- storage -----------------------------------------------------------------------------

type Point = { day: number; used: number };
type Store = { name: string; total: number; used: number; hist: Point[] };

// Total of several datastores per day: a datastore not seen that day keeps its last value.
function sumHistory(stores: Store[]): Point[] {
  const days = [...new Set(stores.flatMap((s) => s.hist.map((p) => p.day)))].sort((a, b) => a - b);
  return days.map((day) => ({
    day,
    used: stores.reduce((a, s) => a + ([...s.hist].reverse().find((p) => p.day <= day)?.used ?? 0), 0),
  }));
}

const level = (pct: number) => (pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-400' : '');
const levelText = (pct: number) => (pct >= 90 ? 'text-red-400' : pct >= 75 ? 'text-amber-400' : 'text-zinc-100');

// Growth over the last 30 days known, and the day the datastore would be full at that pace.
function growth(hist: Point[], total: number, used: number) {
  if (hist.length < 7) return null;
  const from = hist.find((p) => p.day >= hist[hist.length - 1].day - 30 * DAY) ?? hist[0];
  const span = (hist[hist.length - 1].day - from.day) / DAY;
  if (span < 6) return null;
  const gain = used - from.used;
  const full = gain > 0 ? Date.now() + ((total - used) / (gain / span)) * DAY : null;
  return { gain, span: Math.round(span), full };
}

function Gauge({ pct, base }: { pct: number; base: string }) {
  return (
    <div className="relative h-2 rounded-full bg-raised" role="img" aria-label={`${pct} % utilisé`}>
      <div className={clsx('h-full rounded-full', level(pct) || base)} style={{ width: `${Math.min(100, pct)}%` }} />
      <u className="absolute -bottom-0.5 -top-0.5 left-[75%] w-px bg-zinc-500/60" />
      <u className="absolute -bottom-0.5 -top-0.5 left-[90%] w-px bg-zinc-500/60" />
    </div>
  );
}

// Curve of the fill level over the days known, with the value of each day under the pointer.
function Curve({ hist, total, stroke, fill }: { hist: Point[]; total: number; stroke: string; fill: string }) {
  const [attach, w, ref] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 56, L = 44, R = 4, T = 6, B = 14;
  if (hist.length < 2) {
    return <p className="rounded-md border border-dashed border-line px-3 py-3 text-center text-xs text-muted">L’évolution apparaîtra après quelques relevés.</p>;
  }
  const lo = Math.min(...hist.map((p) => p.used)), hi = Math.max(...hist.map((p) => p.used)), pad = Math.max((hi - lo) * 0.15, 1);
  const y0 = lo - pad, y1 = hi + pad;
  const X = (i: number) => L + (i / (hist.length - 1)) * Math.max(1, w - L - R);
  const Y = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const pts = hist.map((p, i) => `${X(i).toFixed(1)},${Y(p.used).toFixed(1)}`).join(' ');
  const move = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    setHover(Math.max(0, Math.min(hist.length - 1, Math.round(((e.clientX - r.left - L) / Math.max(1, w - L - R)) * (hist.length - 1)))));
  };
  const p = hover === null ? null : hist[hover];
  return (
    <div ref={attach} className="relative" style={{ height: H }} onPointerMove={move} onPointerLeave={() => setHover(null)}>
      {w > 0 && (
        <svg width={w} height={H} className="block overflow-visible">
          {[hi, lo].map((v) => (
            <g key={v}>
              <line x1={L} x2={w - R} y1={Y(v)} y2={Y(v)} className="stroke-line" strokeDasharray="3 3" />
              <text x={L - 6} y={Y(v) + 3} textAnchor="end" className="fill-muted text-[10px] tabular-nums">{formatBytes(v)}</text>
            </g>
          ))}
          <polygon points={`${L},${H - B} ${pts} ${w - R},${H - B}`} className={fill} opacity={0.15} />
          <polyline points={pts} fill="none" className={stroke} strokeWidth={2} strokeLinejoin="round" />
          <text x={L} y={H - 2} className="fill-muted text-[10px]">{date(hist[0].day, { day: 'numeric', month: 'short' })}</text>
          <text x={w - R} y={H - 2} textAnchor="end" className="fill-muted text-[10px]">aujourd’hui</text>
          {hover !== null && p && (
            <>
              <line x1={X(hover)} x2={X(hover)} y1={T} y2={H - B} className="stroke-zinc-500" />
              <circle cx={X(hover)} cy={Y(p.used)} r={4} className={clsx(fill, 'stroke-panel')} opacity={1} strokeWidth={2} />
            </>
          )}
        </svg>
      )}
      {p && (
        <div className="pointer-events-none absolute z-10 min-w-36 rounded-md border border-line bg-raised px-2.5 py-2 text-xs shadow-lg" style={{ left: Math.min(Math.max(0, X(hover!) - 72), Math.max(0, w - 150)), top: -64 }}>
          <strong className="mb-1 block font-semibold text-zinc-100">{date(p.day, { weekday: 'short', day: 'numeric', month: 'long' })}</strong>
          <div className="flex justify-between gap-3"><span className="text-muted">Utilisé</span><span className="tabular-nums">{formatBytes(p.used)}</span></div>
          <div className="flex justify-between gap-3"><span className="text-muted">Libre</span><span className="tabular-nums">{formatBytes(Math.max(0, total - p.used))}</span></div>
        </div>
      )}
    </div>
  );
}

// Small trend of a datastore line.
function Mini({ hist, stroke }: { hist: Point[]; stroke: string }) {
  const tail = hist.slice(-30);
  if (tail.length < 2) return <span className="h-[30px] w-16" />;
  const lo = Math.min(...tail.map((p) => p.used)), hi = Math.max(...tail.map((p) => p.used));
  const pts = tail.map((p, i) => `${((i / (tail.length - 1)) * 64).toFixed(1)},${(28 - ((p.used - lo) / (hi - lo || 1)) * 24).toFixed(1)}`).join(' ');
  return (
    <svg viewBox="0 0 64 30" preserveAspectRatio="none" className="h-[30px] w-12 overflow-visible" aria-hidden>
      <polyline points={pts} fill="none" className={stroke} strokeWidth={1.6} />
    </svg>
  );
}

function DatastoreRow({ s }: { s: Store }) {
  const pct = s.total ? Math.round((s.used / s.total) * 100) : 0;
  const g = growth(s.hist, s.total, s.used);
  const stroke = pct >= 90 ? 'stroke-red-500' : pct >= 75 ? 'stroke-amber-400' : 'stroke-emerald-500';
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-x-2 gap-y-0.5 py-1.5">
      <div className="flex min-w-0 justify-between gap-2 text-[13px]">
        <span className="truncate font-medium text-zinc-100">{s.name}</span>
        <span className="shrink-0 tabular-nums"><b className={clsx('font-medium', levelText(pct))}>{pct} %</b> <span className="text-xs text-muted">{formatBytes(s.used)} / {formatBytes(s.total)}</span></span>
      </div>
      <div className="row-span-3 col-start-2 row-start-1"><Mini hist={s.hist} stroke={stroke} /></div>
      <Gauge pct={pct} base="bg-emerald-500" />
      <div className="flex justify-between gap-2 text-[11px] tabular-nums text-muted">
        <span>{formatBytes(Math.max(0, s.total - s.used))} libres</span>
        {g && <span>{g.gain >= 0 ? '+' : '−'}{formatBytes(Math.abs(g.gain))} / {g.span} j</span>}
      </div>
    </div>
  );
}

function StoreCard({ title, role, where, icon, accent, curve, curveFill, stores }: {
  title: string;
  role: ReactNode;
  where: string;
  icon: ReactNode;
  accent: string;
  curve: string;
  curveFill: string;
  stores: Store[];
}) {
  const used = stores.reduce((a, s) => a + s.used, 0);
  const total = stores.reduce((a, s) => a + s.total, 0);
  const pct = total ? Math.round((used / total) * 100) : 0;
  const hist = stores.length === 1 ? stores[0].hist : sumHistory(stores);
  const g = growth(hist, total, used);
  return (
    <article className="panel flex min-w-0 flex-col gap-2 px-4 pb-3 pt-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {icon}
        <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
        {role}
        <span className="ml-auto text-xs text-muted">{stores.length > 1 ? `${stores.length} datastores · ` : ''}{where}</span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 tabular-nums">
        <b className="text-[22px] font-semibold text-zinc-100">{formatBytes(used)}</b>
        <span className="text-sm text-muted">sur {formatBytes(total)} · <span className={levelText(pct) === 'text-zinc-100' ? '' : levelText(pct)}>{pct} %</span> · {formatBytes(Math.max(0, total - used))} libres</span>
      </div>
      <Gauge pct={pct} base={accent} />
      {g && (
        <div className="flex flex-wrap justify-between gap-x-2 text-xs tabular-nums">
          <span><b className="font-semibold text-zinc-100">{g.gain >= 0 ? '+' : '−'}{formatBytes(Math.abs(g.gain))}</b> <span className="text-muted">sur {g.span} jours</span></span>
          {g.full && <span className="text-muted">plein vers {date(g.full, { month: 'long', year: 'numeric' })}</span>}
        </div>
      )}
      <Curve hist={hist} total={total} stroke={curve} fill={curveFill} />
      {stores.length > 1 && (
        <div className="grid grid-cols-2 gap-x-4 border-t border-line [&>*]:border-b [&>*]:border-line [&>*:nth-last-child(-n+2):nth-child(odd)]:border-b-0 [&>*:last-child]:border-b-0">
          {stores.map((s) => <DatastoreRow key={s.name} s={s} />)}
        </div>
      )}
    </article>
  );
}

// Main PBS (all its datastores, each with its own fill level) and secondary PBS.
export function StoragePanels({ data, usage }: { data: BackupsView; usage: BackupUsageView | undefined }) {
  const main: Store[] = data.datastores.map((d) => ({ name: d.store, total: d.total, used: d.used, hist: (usage?.main[d.store] ?? []).map((p) => ({ day: p.day, used: p.used })) }));
  const off = data.offsite?.usage;
  return (
    <>
      {main.length > 0 && (
        <StoreCard
          title="PBS principal"
          role={<span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-400">Principal</span>}
          where={data.connected ? `relevé ${timeAgo(data.polledAt)}` : 'non connecté'}
          icon={<HardDrive className="h-4 w-4 text-emerald-400" />}
          accent="bg-emerald-500"
          curve="stroke-emerald-500"
          curveFill="fill-emerald-500"
          stores={main}
        />
      )}
      {off && data.offsite && (
        <StoreCard
          title="PBS secours"
          role={<span className="rounded-full bg-sky-400/15 px-2 py-0.5 text-[11px] font-medium text-sky-400">Secours · copie</span>}
          where={data.offsite.pollError ? 'relevé en échec' : data.offsite.host}
          icon={<Cloud className="h-4 w-4 text-sky-400" />}
          accent="bg-sky-400"
          curve="stroke-sky-400"
          curveFill="fill-sky-400"
          stores={[{ name: data.offsite.store, total: off.total, used: off.used, hist: (usage?.offsite ?? []).map((p) => ({ day: p.day, used: p.used })) }]}
        />
      )}
    </>
  );
}

// --- activity ----------------------------------------------------------------------------

type Grain = 'day' | 'week' | 'month';
type Bucket = { start: number; label: string; tick: string; uploaded: number; duration: number; count: number; failed: number; n: number };

const grains: { key: Grain; label: string }[] = [
  { key: 'day', label: 'Jour' },
  { key: 'week', label: 'Semaine' },
  { key: 'month', label: 'Mois' },
];

// Days added up by day (30 last), week starting on Monday (12 last) or month (6 last); the first and the
// current period can be partial and say so.
function bucketize(days: BackupStatsView['days'], grain: Grain): Bucket[] {
  if (grain === 'day') {
    return days.slice(-30).map((d) => ({ ...d, start: d.day, label: date(d.day, { weekday: 'long', day: 'numeric', month: 'long' }), tick: date(d.day, { day: 'numeric', month: 'short' }), n: 1 }));
  }
  const key = (t: number) => {
    const d = new Date(t);
    return grain === 'month' ? new Date(d.getFullYear(), d.getMonth(), 1).getTime() : new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
  };
  const map = new Map<number, Bucket>();
  for (const d of days) {
    const k = key(d.day);
    const b = map.get(k) ?? { start: k, label: '', tick: '', uploaded: 0, duration: 0, count: 0, failed: 0, n: 0 };
    b.uploaded += d.uploaded;
    b.duration += d.duration;
    b.count += d.count;
    b.failed += d.failed;
    b.n++;
    map.set(k, b);
  }
  const last = days[days.length - 1]?.day ?? 0;
  const all = [...map.values()].slice(grain === 'month' ? -6 : -12);
  return all.map((b, i) => {
    const first = new Date(b.start);
    const full = grain === 'month' ? new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate() : 7;
    const partial = b.n < full && (i === 0 || b.start + full * DAY > last);
    const end = b.start + (b.n - 1) * DAY;
    return {
      ...b,
      label: grain === 'month' ? date(b.start, { month: 'long', year: 'numeric' }) + (partial ? ' (partiel)' : '') : `Semaine du ${date(b.start, { day: 'numeric', month: 'short' })} au ${date(end, { day: 'numeric', month: 'short' })}${partial ? ' (partielle)' : ''}`,
      tick: grain === 'month' ? date(b.start, { month: 'short' }) : date(b.start, { day: 'numeric', month: 'short' }),
    };
  });
}

// Volume uploaded (bars, left axis) and backup time added up (line, right axis) per day, week or month,
// one plot with the same three horizontal marks for both scales.
export function ActivityPanel({ error }: { error: string | null }) {
  const [grain, setGrain] = useState<Grain>('day');
  const { data } = useBackupStats(180);
  const [attach, w, ref] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [tall, setTall] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1100px)');
    const on = () => setTall(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const buckets = bucketize(data?.days ?? [], grain);
  const n = buckets.length;
  const empty = !buckets.some((b) => b.count);
  const tot = buckets.reduce((a, b) => ({ up: a.up + b.uploaded, dur: a.dur + b.duration }), { up: 0, dur: 0 });
  const H = tall ? 230 : 190, L = 52, R = 56, TOP = 14;
  const top = niceTop(scaleTop(buckets.map((b) => b.uploaded)));
  const clipped = buckets.some((b) => b.uploaded > top);
  const maxD = niceTop(Math.max(1, ...buckets.map((b) => b.duration)) / 60_000) * 60_000;
  const slot = Math.max(1, w - L - R) / Math.max(1, n);
  const bw = Math.max(3, Math.min(slot - 2, 38));
  const cx = (i: number) => L + slot * (i + 0.5);
  const yV = (v: number) => TOP + (1 - Math.min(v, top) / top) * (H - TOP);
  const yD = (t: number) => TOP + (1 - t / maxD) * (H - TOP);
  const every = Math.ceil(n / Math.max(2, Math.floor((w - L) / 64)));
  const move = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - L) / slot);
    setHover(i >= 0 && i < n ? i : null);
  };
  const b = hover === null ? null : buckets[hover];
  return (
    <section className="panel min-w-0 px-4 pb-3 pt-4" aria-label="Activité des sauvegardes">
      <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="text-sm font-semibold text-zinc-100">Activité</h2>
        {!empty && (
          <span className="text-xs tabular-nums text-muted">
            {formatBytes(tot.up)} transférés · {formatDuration(tot.dur)} de sauvegarde · du {date(buckets[0].start, { day: 'numeric', month: 'short' })} au {date(data!.days[data!.days.length - 1].day, { day: 'numeric', month: 'short' })}
          </span>
        )}
        <div className="ml-auto flex gap-1 rounded-md border border-line bg-raised p-0.5" role="group" aria-label="Regrouper par">
          {grains.map((g) => (
            <button key={g.key} aria-pressed={grain === g.key} onClick={() => { setGrain(g.key); setHover(null); }} className={clsx('rounded-sm px-2.5 py-1 text-xs font-medium transition', grain === g.key ? 'bg-panel text-zinc-100 ring-1 ring-line' : 'text-muted hover:text-zinc-200')}>
              {g.label}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="mb-2 text-xs text-amber-400">Statistiques indisponibles : {error}</p>}
      {empty ? (
        <p className="py-10 text-center text-xs text-muted">{error ? '' : 'Aucune statistique pour l’instant : le premier relevé des tâches du PBS peut prendre quelques minutes.'}</p>
      ) : (
        <>
          <div className="mt-2 text-[11px] font-medium uppercase tracking-wider text-muted">Volume transféré et durée de sauvegarde</div>
          <div ref={attach} className="relative mt-1" style={{ height: H + 30 }} onPointerMove={move} onPointerLeave={() => setHover(null)}>
            {w > 0 && (
              <svg width={w} height={H + 30} className="block overflow-visible">
                {[0, 0.5, 1].map((f) => (
                  <g key={f}>
                    <line x1={L} x2={w - R} y1={yV(top * f)} y2={yV(top * f)} className="stroke-line" strokeDasharray="3 3" />
                    <text x={L - 6} y={yV(top * f) + 3} textAnchor="end" className="fill-muted text-[10px] tabular-nums">{f === 1 && clipped ? '≥ ' : ''}{f ? formatBytes(top * f) : '0'}</text>
                    <text x={w - R + 8} y={yD(maxD * f) + 3} className="fill-violet-400 text-[10px] tabular-nums">{f ? formatDuration(maxD * f) : '0'}</text>
                  </g>
                ))}
                {buckets.map((k, i) => {
                  const over = k.uploaded > top;
                  const h = Math.max(2, H - yV(k.uploaded));
                  return (
                    <g key={k.start}>
                      <rect x={cx(i) - bw / 2} y={H - h} width={bw} height={h} rx={2} className={k.failed ? 'fill-red-500' : over ? 'fill-emerald-300' : 'fill-emerald-500'} opacity={hover === null || hover === i ? 0.95 : 0.55} />
                      {over && <text x={cx(i)} y={9} textAnchor="middle" className="fill-emerald-300 text-[10px] tabular-nums">{formatBytes(k.uploaded)} ▲</text>}
                      {k.failed > 0 && <rect x={cx(i) - 4} y={H + 3} width={8} height={8} className="fill-red-500" transform={`rotate(45 ${cx(i)} ${H + 7})`} />}
                      {(i % every === 0 && n - 1 - i >= every) || i === n - 1 ? <text x={cx(i)} y={H + 26} textAnchor="middle" className="fill-muted text-[10px]">{k.tick}</text> : null}
                    </g>
                  );
                })}
                <line x1={L} x2={w - R} y1={H} y2={H} className="stroke-line" />
                <polyline points={buckets.map((k, i) => `${cx(i)},${yD(k.duration)}`).join(' ')} fill="none" className="stroke-violet-400" strokeWidth={2} strokeLinejoin="round" />
                {n <= 14 && buckets.map((k, i) => <circle key={k.start} cx={cx(i)} cy={yD(k.duration)} r={3.5} className="fill-violet-400 stroke-panel" strokeWidth={2} />)}
                {hover !== null && <line x1={cx(hover)} x2={cx(hover)} y1={0} y2={H} className="stroke-zinc-500" />}
              </svg>
            )}
            {b && (
              <div className="pointer-events-none absolute z-10 min-w-40 rounded-md border border-line bg-raised px-2.5 py-2 text-xs shadow-lg" style={{ left: cx(hover!) + 12 + 170 > w ? Math.max(0, cx(hover!) - 182) : cx(hover!) + 12, top: 16 }}>
                <strong className="mb-1 block font-semibold text-zinc-100">{b.label}</strong>
                <TipRow k="Volume" v={formatBytes(b.uploaded)} />
                <TipRow k="Durée" v={formatDuration(b.duration)} />
                {grain !== 'day' && <TipRow k="Moyenne / jour" v={formatBytes(b.uploaded / b.n)} />}
                <TipRow k="Jobs" v={<>{b.count}{b.failed > 0 && <b className="text-red-400"> · {b.failed} en échec</b>}</>} />
              </div>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-muted">
            <span><span className="mr-1 inline-block h-2 w-2 rounded-[2px] bg-emerald-500" />volume transféré (gauche)</span>
            {clipped && <span><span className="mr-1 inline-block h-2 w-2 rounded-[2px] bg-emerald-300" />hors échelle (valeur indiquée)</span>}
            <span><span className="mr-1 inline-block h-0.5 w-3 bg-violet-400 align-middle" />temps de sauvegarde cumulé (droite)</span>
            <span><span className="mr-1 inline-block h-2 w-2 rotate-45 bg-red-500" />au moins un échec</span>
          </div>
        </>
      )}
    </section>
  );
}

function TipRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{k}</span>
      <span className="tabular-nums">{v}</span>
    </div>
  );
}

// Top of the Backups page: status band, storage of the PBS (main, secondary) and activity.
export function BackupOverview({ data }: { data: BackupsView }) {
  const { data: stats } = useBackupStats(180);
  const { data: usage } = useBackupUsage();
  const hasStorage = data.datastores.length > 0 || !!data.offsite?.usage;
  return (
    <div className="mb-5 space-y-3">
      <StateBand groups={data.groups} days={stats?.days} />
      {data.connected || hasStorage ? (
        <div className={clsx('grid gap-3 min-[1100px]:grid-cols-[minmax(340px,440px)_minmax(0,1fr)] min-[1500px]:grid-cols-[1fr_1fr_2fr]', !hasStorage && '!grid-cols-1')}>
          {hasStorage && (
            <div className="grid min-w-0 content-start gap-3 md:grid-cols-2 min-[1100px]:grid-cols-1 min-[1500px]:contents">
              <StoragePanels data={data} usage={usage} />
            </div>
          )}
          {data.connected && <ActivityPanel error={data.statsError} />}
        </div>
      ) : null}
    </div>
  );
}
