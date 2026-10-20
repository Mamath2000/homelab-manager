import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import clsx from 'clsx';
import { ArrowUpCircle, Container, RefreshCw, Search } from 'lucide-react';
import { ImageUpdateBadge, ServiceTags, StackActions, StackStatusBadge } from '../components/Docker';
import { Button, ConfirmModal, Empty, PageHeader, ResponsiveList, Spinner, Tag } from '../components/ui';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { useHosts, useRunBulk } from '../lib/queries';
import { allStacks, stackPath, type HostStack } from '../lib/status';
import { useToast } from '../lib/toast';

type Filter = 'all' | 'updates' | 'problems' | 'stopped';

const filters: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Toutes' },
  { key: 'updates', label: 'À mettre à jour' },
  { key: 'problems', label: 'Problèmes' },
  { key: 'stopped', label: 'Arrêtées' },
];

const match: Record<Filter, (s: HostStack) => boolean> = {
  all: () => true,
  updates: (s) => s.managed && s.updates > 0,
  problems: (s) => s.problems.length > 0,
  stopped: (s) => s.managed && (s.status === 'stopped' || s.status === 'down'),
};

// Every compose stack of every host, with its state and image updates.
export function Docker() {
  const { data: hosts, isLoading } = useHosts();
  const { canWrite } = useMe();
  const toast = useToast();
  const bulk = useRunBulk();
  const [params, setParams] = useSearchParams();
  const filter = filters.find((f) => f.key === params.get('f'))?.key ?? 'all';
  const q = params.get('q') ?? '';
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const [busy, setBusy] = useState(false);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const stacks = useMemo(() => allStacks(hosts ?? []), [hosts]);
  const dockerHosts = (hosts ?? []).filter((h) => h.docker);

  if (isLoading || !hosts) return <div className="flex justify-center p-20"><Spinner /></div>;

  const needle = q.toLowerCase();
  const list = stacks.filter((s) => (match[filter] ?? match.all)(s) && (!needle || s.name.includes(needle) || s.host.name.toLowerCase().includes(needle)));
  // unmanaged stacks show their updates, but are updated by their own system
  const toUpdate = stacks.filter((s) => s.managed && s.updates > 0 && s.host.online);

  const updateAll = async () => {
    setBusy(true);
    let ok = 0;
    // one at a time per host is enforced by the agents: jobs queue up
    for (const s of toUpdate) {
      try {
        const j = await api.runJob(s.host.id, 'docker_update', [], { stack: s.name });
        if (j.status !== 'failed') ok++;
      } catch {
        // counted below
      }
    }
    setBusy(false);
    setConfirmUpdate(false);
    if (ok) toast.success(`${ok} mise(s) à jour de stack lancée(s)`);
    if (ok < toUpdate.length) toast.error(`${toUpdate.length - ok} mise(s) à jour non lancée(s)`);
  };

  // unmanaged stacks are listed, but out of the counts
  const managed = stacks.filter((s) => s.managed);
  const tiles = [
    { label: 'Stacks', value: managed.length },
    { label: 'En marche', value: managed.filter((s) => s.status === 'running').length },
    { label: 'À mettre à jour', value: managed.filter((s) => s.updates > 0).length },
    { label: 'Problèmes', value: stacks.filter((s) => s.problems.length > 0).length },
  ];

  return (
    <>
      <PageHeader
        icon={Container}
        title="Docker"
        actions={
          canWrite && dockerHosts.length > 0 && (
            <>
              <Button
                icon={RefreshCw}
                loading={bulk.isPending}
                disabled={!dockerHosts.some((h) => h.online)}
                title="Compare les images au registre sur tous les hôtes Docker (sans rien télécharger)"
                onClick={() => bulk.mutate({ hostIds: dockerHosts.filter((h) => h.online).map((h) => h.id), action: 'docker_check' })}
              >
                Vérifier les images
              </Button>
              <Button icon={ArrowUpCircle} variant="primary" disabled={!toUpdate.length} onClick={() => setConfirmUpdate(true)}>
                Mettre à jour ({toUpdate.length})
              </Button>
            </>
          )
        }
      />

      {dockerHosts.length === 0 ? (
        <div className="panel">
          <Empty icon={Container} title="Aucun hôte avec Docker">
            L'agent détecte Docker et le plugin compose v2 tout seul : les stacks compose des hôtes apparaissent ici dès que l'agent est à jour.
          </Empty>
        </div>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {tiles.map((t) => (
              <div key={t.label} className="panel px-5 py-4">
                <div className="text-2xl font-semibold tabular-nums text-zinc-100">{t.value}</div>
                <div className="text-xs text-muted">{t.label}</div>
              </div>
            ))}
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-3">
            <label className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted" />
              <input className="input w-64 pl-8" placeholder="Stack ou hôte…" value={q} onChange={(e) => setParam('q', e.target.value)} />
            </label>
            <div className="flex flex-wrap gap-1 rounded-md border border-line bg-panel p-1">
              {filters.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setParam('f', f.key === 'all' ? '' : f.key)}
                  className={clsx(
                    'rounded-sm px-2.5 py-1 text-xs font-medium transition',
                    filter === f.key ? 'bg-raised text-zinc-100 ring-1 ring-line' : 'text-muted hover:text-zinc-200',
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="panel min-w-0">
            {list.length === 0 ? (
              <p className="p-6 text-sm text-muted">Aucune stack.</p>
            ) : (
              <>
                <ResponsiveList mode="mobile">
                  {list.map((s) => (
                    <article key={`${s.host.id}/${s.name}`} className="min-w-0 space-y-3 p-4">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <Link
                          to={stackPath(s.host.id, s.name)}
                          title={s.name}
                          className="min-w-0 truncate font-medium text-zinc-100 hover:text-emerald-300"
                        >
                          {s.name}
                        </Link>
                        {canWrite && <StackActions host={s.host} stack={s} compact />}
                      </div>
                      <Link
                        to={`/hosts/${s.host.id}`}
                        className={clsx('block truncate text-xs hover:text-emerald-300', s.host.online ? 'text-zinc-300' : 'text-zinc-500 line-through')}
                      >
                        {s.host.name}
                      </Link>
                      <div className="flex flex-wrap items-center gap-2">
                        <StackStatusBadge stack={s} />
                        {s.managed && <ImageUpdateBadge update={s.update} count={s.updates} />}
                      </div>
                      {s.problems.length > 0 && <p className="break-words text-xs text-amber-300">{s.problems.join(' · ')}</p>}
                      {s.services.length > 0 && <ServiceTags services={s.services} />}
                    </article>
                  ))}
                </ResponsiveList>
                <ResponsiveList mode="desktop">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="border-b border-line">
                  <tr>
                    <th className="th">Stack</th>
                    <th className="th">Hôte</th>
                    <th className="th">État</th>
                    <th className="th">Images</th>
                    <th className="th">Services</th>
                    <th className="th">Vérifiées</th>
                    {canWrite && <th className="th text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {list.map((s) => (
                    <tr key={`${s.host.id}/${s.name}`} className="hover:bg-raised/40">
                      <td className="td">
                        <Link to={stackPath(s.host.id, s.name)} className="font-medium text-zinc-100 hover:text-emerald-300">{s.name}</Link>
                        {s.problems.length > 0 && <p className="text-xs text-amber-300">{s.problems.join(' · ')}</p>}
                      </td>
                      <td className="td">
                        <Link to={`/hosts/${s.host.id}`} className={clsx('hover:text-emerald-300', s.host.online ? 'text-zinc-300' : 'text-zinc-500 line-through')}>
                          {s.host.name}
                        </Link>
                      </td>
                      <td className="td"><StackStatusBadge stack={s} /></td>
                      <td className="td">{s.managed && <ImageUpdateBadge update={s.update} count={s.updates} />}</td>
                      <td className="td">
                        <ServiceTags services={s.services} />
                      </td>
                      <td className="td text-xs text-zinc-400">
                        {s.host.docker?.updatesCheckedAt ? timeAgo(s.host.docker.updatesCheckedAt) : 'jamais'}
                      </td>
                      {canWrite && (
                        <td className="td">
                          <div className="flex justify-end"><StackActions host={s.host} stack={s} compact /></div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
                </ResponsiveList>
              </>
            )}
          </div>
        </>
      )}

      <ConfirmModal
        open={confirmUpdate}
        onClose={() => setConfirmUpdate(false)}
        title="Mettre à jour les stacks"
        confirmLabel={`Mettre à jour ${toUpdate.length} stack(s)`}
        loading={busy}
        onConfirm={updateAll}
      >
        docker compose pull puis up -d sur chaque stack, sur les hôtes en ligne :
        <div className="mt-2 flex flex-wrap gap-1.5">
          {toUpdate.map((s) => <Tag key={`${s.host.id}/${s.name}`}>{s.host.name} · {s.name}</Tag>)}
        </div>
      </ConfirmModal>
    </>
  );
}
