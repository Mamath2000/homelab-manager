import { Fragment, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ScrollText } from 'lucide-react';
import { AUDIT_CATEGORIES, api, type AuditCategory, type AuditEntry } from '../lib/api';
import { AUDIT_CATEGORY_LABELS, auditActionLabel } from '../lib/audit';
import { PROFILE_LABELS } from '../lib/auth';
import { byLabel, dateTime } from '../lib/format';
import { Badge, Button, Empty, ResponsiveList, Segmented, Spinner } from './ui';

// Journal of the key actions (admins only): who did what, from where, with what result. Read only: entries are
// never changed nor removed from the hub, they go after a year.

type Period = '1' | '7' | '30' | 'all';
const PERIODS: { id: Period; label: string }[] = [
  { id: '1', label: '24 h' },
  { id: '7', label: '7 j' },
  { id: '30', label: '30 j' },
  { id: 'all', label: '1 an' },
];
// "" in the actor filter: entries without a known actor (failed logins of an unknown account)
const ALL = '*';
const UNKNOWN = '';

const fmt = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'oui' : 'non';
  if (Array.isArray(v)) return v.length ? v.map(fmt).join(', ') : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const isChange = (v: unknown): v is { from: unknown; to: unknown } => !!v && typeof v === 'object' && 'from' in v && 'to' in v;

// details: the fields changed (old → new), the other facts as they are
function Details({ details }: { details: Record<string, unknown> }) {
  const rows: { k: string; v: string }[] = [];
  const walk = (d: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(d)) {
      if (k === 'values' && v && typeof v === 'object' && !Array.isArray(v)) walk(v as Record<string, unknown>);
      else if (k === 'changed' && Array.isArray(v)) rows.push({ k: 'modifié', v: v.length ? v.join(', ') : 'rien' });
      else if (isChange(v)) rows.push({ k, v: `${fmt(v.from)} → ${fmt(v.to)}` });
      else rows.push({ k, v: fmt(v) });
    }
  };
  walk(details);
  if (!rows.length) return null;
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {rows.map((r, i) => (
        <Fragment key={i}>
          <dt className="break-words text-muted">{r.k}</dt>
          <dd className="break-all font-mono text-zinc-300">{r.v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

const target = (e: AuditEntry) => (e.target ? e.target.name ?? e.target.id ?? '' : '');

function Actor({ e }: { e: AuditEntry }) {
  if (e.actor.kind === 'anonymous') return <span className="text-zinc-400">{e.actor.name ?? 'compte inconnu'}</span>;
  return (
    <span className="text-zinc-100">
      {byLabel(e.actor)}
      {e.actor.profile && e.actor.profile !== 'admin' && <span className="ml-1 text-xs text-muted">({PROFILE_LABELS[e.actor.profile as keyof typeof PROFILE_LABELS] ?? e.actor.profile})</span>}
    </span>
  );
}

// MQTT commands: the topic they came on (the broker does not say who published them)
const topic = (e: AuditEntry) => (e.actor.kind === 'homeassistant' ? e.actor.keyName : null);
function Topic({ e }: { e: AuditEntry }) {
  const t = topic(e);
  return t ? <p className="break-all text-xs text-muted">topic MQTT <span className="font-mono text-zinc-300">{t}</span></p> : null;
}

function Result({ e }: { e: AuditEntry }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {e.ok ? <Badge tone="ok">ok</Badge> : <Badge tone="bad">échec</Badge>}
      {e.count > 1 && <Badge tone="warn">× {e.count}</Badge>}
    </span>
  );
}

export function AuditLog() {
  const [actor, setActor] = useState(ALL);
  const [category, setCategory] = useState<AuditCategory | ''>('');
  const [period, setPeriod] = useState<Period>('7');
  const [open, setOpen] = useState<string | null>(null);

  const { data: actors } = useQuery({ queryKey: ['audit-actors'], queryFn: api.auditActors });
  // the start of the period, fixed while the filters stay the same (a page further keeps the same window)
  const [from] = useState(() => new Map<Period, string>());
  const fromOf = (p: Period) => {
    if (p === 'all') return undefined;
    if (!from.has(p)) from.set(p, new Date(Date.now() - Number(p) * 86400_000).toISOString());
    return from.get(p);
  };

  const q = useInfiniteQuery({
    queryKey: ['audit', actor, category, period],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.audit({ actor: actor === ALL ? undefined : actor, category: category || undefined, from: fromOf(period), before: pageParam }),
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id));

  return (
    <>
      <p className="mb-4 text-sm text-muted">
        Actions clés sur le hub : connexions, comptes, clés d'API, hôtes, tâches lancées, paramètres. Les entrées ne peuvent être ni modifiées ni supprimées ; elles sont effacées automatiquement au bout d'un an.
      </p>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end">
        <label className="min-w-0">
          <span className="mb-1 block text-xs text-muted">Utilisateur</span>
          <select className="input w-full sm:w-48" value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value={ALL}>Tous</option>
            {actors?.actors.map((a) => <option key={a} value={a}>{a}</option>)}
            <option value={UNKNOWN}>Compte inconnu</option>
          </select>
        </label>
        <label className="min-w-0">
          <span className="mb-1 block text-xs text-muted">Type d'action</span>
          <select className="input w-full sm:w-48" value={category} onChange={(e) => setCategory(e.target.value as AuditCategory | '')}>
            <option value="">Tous</option>
            {AUDIT_CATEGORIES.map((c) => <option key={c} value={c}>{AUDIT_CATEGORY_LABELS[c]}</option>)}
          </select>
        </label>
        <div className="col-span-2 sm:col-auto">
          <Segmented label="Période" options={PERIODS} value={period} onChange={setPeriod} />
        </div>
      </div>

      <div className="panel min-w-0">
        {q.isLoading ? (
          <div className="flex justify-center p-10"><Spinner /></div>
        ) : q.isError ? (
          <p className="p-4 text-sm text-red-400">{(q.error as Error).message}</p>
        ) : entries.length === 0 ? (
          <Empty icon={ScrollText} title="Aucune entrée">Rien ne correspond à ces filtres.</Empty>
        ) : (
          <>
            <ResponsiveList mode="mobile">
              {entries.map((e) => (
                <button key={e.id} type="button" onClick={() => toggle(e.id)} className="block w-full space-y-2 p-4 text-left transition hover:bg-raised/50">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="break-words text-sm text-zinc-100">{auditActionLabel(e.action)}</div>
                      {target(e) && <div className="break-words text-xs text-muted">{target(e)}</div>}
                    </div>
                    <Result e={e} />
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-400">
                    <Actor e={e} />
                    <span>{dateTime(e.at)}</span>
                    {e.ip && <span className="font-mono">{e.ip}</span>}
                  </div>
                  {open === e.id && (
                    <div className="space-y-2 border-t border-line pt-2">
                      {e.error && <p className="break-words text-xs text-red-400">{e.error}</p>}
                      <Topic e={e} />
                      {e.details && <Details details={e.details} />}
                    </div>
                  )}
                </button>
              ))}
            </ResponsiveList>
            <ResponsiveList mode="desktop">
              <table className="w-full text-sm">
                <thead className="border-b border-line">
                  <tr className="text-left">
                    <th className="th w-8" />
                    <th className="th">Date</th>
                    <th className="th">Utilisateur</th>
                    <th className="th">Action</th>
                    <th className="th">Cible</th>
                    <th className="th">Résultat</th>
                    <th className="th">Adresse</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {entries.map((e) => {
                    const expandable = !!(e.details || e.error || topic(e));
                    return (
                      <Fragment key={e.id}>
                        <tr onClick={() => expandable && toggle(e.id)} className={expandable ? 'cursor-pointer hover:bg-raised/50' : undefined}>
                          <td className="td text-muted">{expandable && (open === e.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />)}</td>
                          <td className="td whitespace-nowrap text-xs text-zinc-400">{dateTime(e.at)}</td>
                          <td className="td"><Actor e={e} /></td>
                          <td className="td">
                            <span className="text-zinc-100">{auditActionLabel(e.action)}</span>
                            <span className="ml-2 text-xs text-muted">{AUDIT_CATEGORY_LABELS[e.category]}</span>
                          </td>
                          <td className="td break-all text-zinc-300">{target(e) || '—'}</td>
                          <td className="td"><Result e={e} /></td>
                          <td className="td font-mono text-xs text-zinc-400">{e.ip ?? '—'}</td>
                        </tr>
                        {open === e.id && (
                          <tr className="bg-raised/30">
                            <td />
                            <td colSpan={6} className="td space-y-2">
                              {e.error && <p className="text-xs text-red-400">{e.error}</p>}
                              <Topic e={e} />
                              {e.details && <Details details={e.details} />}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </ResponsiveList>
            {q.hasNextPage && (
              <div className="flex justify-center border-t border-line p-3">
                <Button size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Plus ancien</Button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
