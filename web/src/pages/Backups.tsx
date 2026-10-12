import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import clsx from 'clsx';
import { DatabaseBackup, HardDrive, RefreshCw, Search, Trash2, Unlink } from 'lucide-react';
import { BackupTimeline } from '../components/HostBackups';
import { Badge, Button, Empty, Modal, PageHeader, Spinner } from '../components/ui';
import { api, type BackupGroup, type BackupsView, type Host } from '../lib/api';
import { useMe } from '../lib/auth';
import { backupKind, backupKindOf, backupKinds, backupStateMeta, type BackupKind, formatBytes, groupLabel, hoursLabel, rhythmLabel, scheduleLabel, thresholdSourceLabel } from '../lib/backups';
import { dateTime, timeAgo } from '../lib/format';
import { useBackups, useHosts } from '../lib/queries';
import { useToast } from '../lib/toast';

type Filter = 'all' | 'late';

const filters: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Toutes' },
  { key: 'late', label: 'En retard / échec' },
];

// Groups of the PBS attached to no host: not followed, listed to be attached from the host page.
function OrphansModal({ data, open, onClose, canManage }: { data: BackupsView; open: boolean; onClose: () => void; canManage: boolean }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const needle = q.toLowerCase();
  const list = data.orphans.filter((o) => !needle || `${o.store}/${o.ns}/${o.type}/${o.backupId} ${o.comment ?? ''}`.toLowerCase().includes(needle));
  const forget = async (id: string) => {
    try {
      await api.forgetBackup(id);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  return (
    <Modal open={open} onClose={onClose} wide title={`Sauvegardes orphelines (${data.orphans.length})`}>
      <p className="mb-3 text-sm text-muted">
        Sauvegardes du PBS rattachées à aucun hôte : elles ne sont pas suivies. Pour en suivre une, rattache-la depuis la fiche de son hôte
        (carte Sauvegardes).
      </p>
      <label className="relative mb-3 block">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted" />
        <input className="input pl-8" placeholder="Datastore, namespace, nom…" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <div className="max-h-[55vh] overflow-auto rounded-md border border-line">
        {list.length === 0 ? (
          <p className="p-4 text-sm text-muted">Aucune sauvegarde orpheline.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 border-b border-line bg-panel">
              <tr>
                <th className="th">Sauvegarde</th>
                <th className="th">Datastore</th>
                <th className="th">Dernière</th>
                <th className="th text-right">Snapshots</th>
                {canManage && <th className="th" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((o) => (
                <tr key={o.id} className={clsx(o.gone && 'opacity-60')}>
                  <td className="td">
                    <div className="text-zinc-100">{groupLabel({ type: o.type, backupId: o.backupId })}</div>
                    {o.comment && <div className="text-xs text-muted">{o.comment}</div>}
                    {o.gone && <div className="text-xs text-muted">disparue du PBS</div>}
                  </td>
                  <td className="td text-xs text-zinc-300">{o.store}{o.ns ? ` › ${o.ns}` : ''}</td>
                  <td className="td text-xs" title={dateTime(o.lastBackup)}>{timeAgo(o.lastBackup)}</td>
                  <td className="td text-right tabular-nums text-xs">{o.count}</td>
                  {canManage && (
                    <td className="td text-right">
                      {o.gone && <Button size="sm" variant="ghost" icon={Trash2} title="Oublier" onClick={() => forget(o.id)} />}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}

// Threshold of a group: automatic (schedule, learned rhythm, retention; none: never late) or fixed (admin).
function ThresholdCell({ g, canManage, onChange }: { g: BackupGroup; canManage: boolean; onChange: (h: number | null) => void }) {
  const label = g.threshold === null ? '— · aucun rythme connu' : `${hoursLabel(g.threshold)} · ${thresholdSourceLabel[g.thresholdSource]}`;
  if (!canManage) return <span className="text-xs text-zinc-400">{label}</span>;
  return (
    <select
      className="input h-8 w-40 py-1 text-xs"
      value={g.staleHours ?? ''}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      title="Âge au-delà duquel la sauvegarde est en retard. Automatique : la planification du job, sinon 1,5 × le rythme appris des derniers snapshots, sinon de la rétention du PBS ; sans aucun des trois, pas de retard signalé."
    >
      <option value="">{g.thresholdSource === 'manual' ? 'automatique' : label}</option>
      <option value="26">26 h</option>
      <option value="50">2 jours</option>
      <option value="194">8 jours</option>
      <option value="768">32 jours</option>
    </select>
  );
}

// Backups attached to the hosts: last snapshot, size, rhythm, verification, state.
export function Backups() {
  const { data, isLoading } = useBackups();
  const { data: hosts } = useHosts();
  const { canWrite, canManage, canSettings } = useMe();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const filter = (params.get('f') as Filter) || 'all';
  // type of backup (?t=image|directories|external), combined with the other filters
  const kindFilter = (Object.keys(backupKinds) as BackupKind[]).find((k) => k === params.get('t')) ?? null;
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const hostFilter = params.get('host');
  const [q, setQ] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [orphans, setOrphans] = useState(false);

  if (isLoading || !data) return <div className="flex justify-center p-20"><Spinner /></div>;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.refreshBackups();
      toast.success(data.clusters.length ? 'Sauvegardes relevées (PBS et Proxmox VE)' : 'Sauvegardes relevées sur le PBS');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  // reversible settings: applied at once (CLAUDE.md)
  const update = async (g: BackupGroup, patch: Parameters<typeof api.updateBackup>[1]) => {
    try {
      await api.updateBackup(g.id, patch);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const hostList: Host[] = hosts ?? [];
  const hostName = (id: string | null) => hostList.find((h) => h.id === id)?.name ?? '';
  const needle = q.toLowerCase();
  const list = data.groups
    .filter(
      (g) =>
        (hostFilter ? g.hostId === hostFilter : filter === 'late' ? g.state !== 'ok' : true) &&
        (!kindFilter || backupKindOf(g) === kindFilter) &&
        (!needle || g.backupId.toLowerCase().includes(needle) || (g.comment ?? '').toLowerCase().includes(needle) || hostName(g.hostId).toLowerCase().includes(needle)),
    )
    .sort((a, b) => hostName(a.hostId).localeCompare(hostName(b.hostId)) || a.backupId.localeCompare(b.backupId));
  const tiles = [
    { label: 'Sauvegardes suivies', value: data.groups.length },
    { label: 'À jour', value: data.groups.filter((g) => g.state === 'ok').length },
    { label: 'En retard', value: data.groups.filter((g) => g.state === 'stale').length },
    { label: 'Échec / disparues', value: data.groups.filter((g) => g.state === 'failed' || g.state === 'task_failed' || g.state === 'gone').length },
  ];
  const filteredHost = hostFilter && hostList.find((h) => h.id === hostFilter);

  return (
    <>
      <PageHeader
        icon={DatabaseBackup}
        title="Sauvegardes"
        actions={
          data.enabled && (
            <>
              <Button icon={Unlink} onClick={() => setOrphans(true)} title="Sauvegardes du PBS rattachées à aucun hôte">
                Orphelines ({data.orphans.length})
              </Button>
              {canWrite && <Button icon={RefreshCw} loading={refreshing} onClick={refresh}>Relever</Button>}
            </>
          )
        }
      >
        {data.enabled && (
          <span className="text-xs text-muted">
            Proxmox Backup Server · relevé {timeAgo(data.polledAt)}
            {data.clusters.map((c) => (
              <span key={c.id}> · PVE {c.name} {c.pollError ? <span className="text-red-400">en erreur</span> : `relevé ${timeAgo(c.polledAt)}`}</span>
            ))}
          </span>
        )}
      </PageHeader>

      {!data.enabled ? (
        <div className="panel">
          <Empty icon={DatabaseBackup} title="Suivi des sauvegardes désactivé">
            Renseigne l'adresse de ton Proxmox Backup Server et un jeton en lecture seule
            {canSettings ? <> dans <Link to="/settings?tab=backups" className="text-emerald-400 hover:underline">Paramètres › Sauvegardes</Link></> : ' (Paramètres › Sauvegardes, administrateur)'}.
          </Empty>
        </div>
      ) : (
        <>
          {data.pollError && (
            <div className="panel mb-5 border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-200">Dernier relevé en échec : {data.pollError}</div>
          )}
          {data.clusters.filter((c) => c.pollError).map((c) => (
            <div key={c.id} className="panel mb-5 border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-200">Relevé du cluster {c.name} en échec : {c.pollError}</div>
          ))}
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {tiles.map((t) => (
              <div key={t.label} className="panel px-5 py-4">
                <div className="text-2xl font-semibold tabular-nums text-zinc-100">{t.value}</div>
                <div className="text-xs text-muted">{t.label}</div>
              </div>
            ))}
          </div>
          {data.datastores.length > 0 && (
            <div className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {data.datastores.map((d) => {
                const pct = d.total ? Math.round((d.used / d.total) * 100) : 0;
                return (
                  <div key={d.store} className="panel px-5 py-4">
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2 text-zinc-200"><HardDrive className="h-4 w-4 text-muted" />{d.store}</span>
                      <span className="tabular-nums text-xs text-muted">{formatBytes(d.used)} / {formatBytes(d.total)}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-raised">
                      <div className={clsx('h-full rounded-full', pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-400' : 'bg-emerald-500')} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="mt-1 text-xs text-muted">{pct} % utilisé · {formatBytes(d.avail)} libres</div>
                  </div>
                );
              })}
            </div>
          )}

          {data.groups.length === 0 ? (
            <div className="panel">
              <Empty icon={DatabaseBackup} title="Aucune sauvegarde suivie">
                Seules les sauvegardes rattachées à un hôte sont suivies : rattache-les depuis la fiche de chaque hôte (carte Sauvegardes).
                {data.orphans.length > 0 && <> Le PBS en compte {data.orphans.length} non rattachée{data.orphans.length > 1 ? 's' : ''} (bouton Orphelines).</>}
              </Empty>
            </div>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <label className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted" />
                  <input className="input w-64 pl-8" placeholder="Sauvegarde ou hôte…" value={q} onChange={(e) => setQ(e.target.value)} />
                </label>
                {filteredHost ? (
                  <button onClick={() => setParam('host', null)} className="rounded-md border border-line bg-raised px-2.5 py-1 text-xs text-zinc-200 hover:text-white">
                    Hôte : {filteredHost.name} ✕
                  </button>
                ) : (
                  <div className="flex flex-wrap gap-1 rounded-md border border-line bg-panel p-1">
                    {filters.map((f) => (
                      <button
                        key={f.key}
                        onClick={() => setParam('f', f.key === 'all' ? null : f.key)}
                        className={clsx(
                          'rounded-sm px-2.5 py-1 text-xs font-medium transition',
                          filter === f.key ? 'bg-raised text-zinc-100 ring-1 ring-line' : 'text-muted hover:text-zinc-200',
                        )}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-1 rounded-md border border-line bg-panel p-1">
                  {([null, ...Object.keys(backupKinds)] as (BackupKind | null)[]).map((k) => (
                    <button
                      key={k ?? 'all'}
                      onClick={() => setParam('t', k)}
                      title={k ? backupKinds[k].title : undefined}
                      className={clsx(
                        'rounded-sm px-2.5 py-1 text-xs font-medium transition',
                        kindFilter === k ? 'bg-raised text-zinc-100 ring-1 ring-line' : 'text-muted hover:text-zinc-200',
                      )}
                    >
                      {k ? backupKinds[k].label : 'Tous types'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="panel overflow-x-auto">
                {list.length === 0 ? (
                  <p className="p-6 text-sm text-muted">Aucune sauvegarde pour ce filtre.</p>
                ) : (
                  <table className="w-full min-w-[1200px] text-sm">
                    <thead className="border-b border-line">
                      <tr>
                        <th className="th">Sauvegarde</th>
                        <th className="th">Type</th>
                        <th className="th">Hôte</th>
                        <th className="th">30 derniers jours</th>
                        <th className="th">Dernière</th>
                        <th className="th">Taille</th>
                        <th className="th">Vérif.</th>
                        <th className="th">État</th>
                        <th className="th">Seuil</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {list.map((g) => {
                        const meta = backupStateMeta[g.state];
                        const rhythm = rhythmLabel(g.interval);
                        return (
                          <tr key={g.id} className="hover:bg-raised/40">
                            <td className="td">
                              <div className="font-medium text-zinc-100">{groupLabel(g)}</div>
                              <div className="text-xs text-muted">
                                {g.store}{g.ns ? ` › ${g.ns}` : ''} · {g.count} snapshot{g.count > 1 ? 's' : ''}{!g.pve && !g.managed && !g.ha && rhythm && ` · ${rhythm}`}
                              </div>
                              {g.pve && (
                                <div className="text-xs text-muted">
                                  PVE {g.pve.cluster} · {scheduleLabel(g)}
                                  {g.pve.lastTask && !g.pve.lastTask.ok && <span className="text-red-400"> · {g.pve.lastTask.error}</span>}
                                </div>
                              )}
                              {g.ha && (
                                <div className="text-xs text-muted">
                                  Home Assistant · {scheduleLabel(g)}
                                  {g.ha.failedAt && g.ha.failedAt > g.lastBackup && <span className="text-red-400"> · non écrite {timeAgo(g.ha.failedAt)}</span>}
                                  {g.ha.error && <span className="text-amber-400"> · {g.ha.error}</span>}
                                </div>
                              )}
                              {g.managed && (
                                <div className="text-xs text-muted">
                                  agent · {g.managed.name} · {scheduleLabel(g)}
                                  {g.managed.lastRun && !g.managed.lastRun.ok && <span className="text-red-400"> · {g.managed.lastRun.error}</span>}
                                </div>
                              )}
                            </td>
                            <td className="td" title={backupKind(g).title}>
                              <Badge tone="neutral">{backupKind(g).label}</Badge>
                            </td>
                            <td className="td">
                              {g.source ? (
                                <Link
                                  to={`/hosts/${g.hostId}`}
                                  className="text-zinc-300 hover:text-emerald-300"
                                  title={g.source === 'vzdump' ? 'Rattachée automatiquement : le guest Proxmox de cet hôte' : g.source === 'haos' ? 'Sauvegarde Home Assistant de cet hôte HAOS' : 'Écrite par une sauvegarde définie sur cet hôte'}
                                >
                                  {hostName(g.hostId)} <span className="text-xs text-muted">· auto</span>
                                </Link>
                              ) : canManage ? (
                                <select
                                  className="input h-8 max-w-[11rem] py-1 text-xs"
                                  value={g.hostId ?? ''}
                                  onChange={(e) => update(g, { hostId: e.target.value || null })}
                                  title="Hôte de la sauvegarde (détacher : elle n'est plus suivie)"
                                >
                                  {hostList.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                                  <option value="">— détacher</option>
                                </select>
                              ) : (
                                <Link to={`/hosts/${g.hostId}`} className="text-zinc-300 hover:text-emerald-300">{hostName(g.hostId)}</Link>
                              )}
                            </td>
                            <td className="td"><BackupTimeline group={g} className="w-56" /></td>
                            <td className="td" title={g.lastBackup ? dateTime(g.lastBackup) : undefined}>{g.lastBackup ? timeAgo(g.lastBackup) : <span className="text-zinc-500">jamais</span>}</td>
                            <td className="td tabular-nums text-zinc-300">{formatBytes(g.size)}</td>
                            <td className="td text-xs">
                              {g.verify === 'ok' ? <span className="text-emerald-400">ok</span> : g.verify === 'failed' ? <span className="text-red-400">échec</span> : <span className="text-zinc-500">—</span>}
                            </td>
                            <td className="td"><Badge tone={meta.tone}>{meta.label}</Badge></td>
                            <td className="td"><ThresholdCell g={g} canManage={canManage} onChange={(staleHours) => update(g, { staleHours })} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </>
      )}
      {data.enabled && <OrphansModal data={data} open={orphans} onClose={() => setOrphans(false)} canManage={canManage} />}
    </>
  );
}
