import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import clsx from 'clsx';
import { DatabaseBackup, HardDrive, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Badge, Button, Empty, PageHeader, Spinner } from '../components/ui';
import { api, type BackupGroup, type Host } from '../lib/api';
import { useMe } from '../lib/auth';
import { backupStateMeta, formatBytes, groupLabel } from '../lib/backups';
import { dateTime, timeAgo } from '../lib/format';
import { useBackups, useHosts } from '../lib/queries';
import { useToast } from '../lib/toast';

type Filter = 'all' | 'late' | 'nohost' | 'ignored';

const filters: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Toutes' },
  { key: 'late', label: 'En retard / échec' },
  { key: 'nohost', label: 'Sans hôte' },
  { key: 'ignored', label: 'Ignorées' },
];

const match: Record<Filter, (g: BackupGroup) => boolean> = {
  all: (g) => !g.ignored,
  late: (g) => g.state === 'stale' || g.state === 'failed',
  nohost: (g) => !g.hostId && !g.ignored,
  ignored: (g) => !!g.ignored || !!g.gone,
};

// Host of a group: chosen by an admin, otherwise shown read-only.
function HostCell({ g, hosts, canManage, onChange }: { g: BackupGroup; hosts: Host[]; canManage: boolean; onChange: (hostId: string | null) => void }) {
  const host = hosts.find((h) => h.id === g.hostId);
  if (!canManage) {
    return host ? <Link to={`/hosts/${host.id}`} className="text-zinc-300 hover:text-emerald-300">{host.name}</Link> : <span className="text-zinc-500">sans hôte</span>;
  }
  return (
    <select
      className="input h-8 max-w-[11rem] py-1 text-xs"
      value={g.hostPinned ? (g.hostId ?? '') : 'auto'}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      title={g.hostPinned ? 'Rattachée à la main' : 'Rattachement automatique (nom ou hostname de l’hôte)'}
    >
      <option value="auto">{host ? `${host.name} (auto)` : 'sans hôte (auto)'}</option>
      <option value="">sans hôte</option>
      {hosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
    </select>
  );
}

// Backup groups of the Proxmox Backup Server: last snapshot, size, verification, state.
export function Backups() {
  const { data, isLoading } = useBackups();
  const { data: hosts } = useHosts();
  const { canWrite, canManage, canSettings } = useMe();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const filter = (params.get('f') as Filter) || 'all';
  const hostFilter = params.get('host');
  const [q, setQ] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  if (isLoading || !data) return <div className="flex justify-center p-20"><Spinner /></div>;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.refreshBackups();
      toast.success('Sauvegardes relevées sur le PBS');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  // settings of a group: applied at once (reversible), see CLAUDE.md
  const update = async (g: BackupGroup, patch: Parameters<typeof api.updateBackup>[1]) => {
    try {
      await api.updateBackup(g.id, patch);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const forget = async (g: BackupGroup) => {
    try {
      await api.forgetBackup(g.id);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const hostList = hosts ?? [];
  const needle = q.toLowerCase();
  const list = data.groups.filter(
    (g) =>
      (hostFilter ? g.hostId === hostFilter : (match[filter] ?? match.all)(g)) &&
      (!needle || g.backupId.toLowerCase().includes(needle) || (g.comment ?? '').toLowerCase().includes(needle) ||
        (hostList.find((h) => h.id === g.hostId)?.name.toLowerCase().includes(needle) ?? false)),
  );
  const tracked = data.groups.filter((g) => !g.ignored && !g.gone);
  const tiles = [
    { label: 'Sauvegardes suivies', value: tracked.length },
    { label: 'À jour', value: tracked.filter((g) => g.state === 'ok').length },
    { label: 'En retard', value: tracked.filter((g) => g.state === 'stale').length },
    { label: 'Vérification en échec', value: tracked.filter((g) => g.state === 'failed').length },
  ];
  const filteredHost = hostFilter && hostList.find((h) => h.id === hostFilter);

  return (
    <>
      <PageHeader
        icon={DatabaseBackup}
        title="Sauvegardes"
        actions={canWrite && data.enabled && <Button icon={RefreshCw} loading={refreshing} onClick={refresh}>Relever</Button>}
      >
        {data.enabled && <span className="text-xs text-muted">Proxmox Backup Server · relevé {timeAgo(data.polledAt)}</span>}
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
            <div className="panel mb-5 border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              Dernier relevé en échec : {data.pollError}
            </div>
          )}
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

          <div className="mb-3 flex flex-wrap items-center gap-3">
            <label className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted" />
              <input className="input w-64 pl-8" placeholder="Sauvegarde ou hôte…" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            {filteredHost ? (
              <button onClick={() => setParams({}, { replace: true })} className="rounded-md border border-line bg-raised px-2.5 py-1 text-xs text-zinc-200 hover:text-white">
                Hôte : {filteredHost.name} ✕
              </button>
            ) : (
              <div className="flex flex-wrap gap-1 rounded-md border border-line bg-panel p-1">
                {filters.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setParams(f.key === 'all' ? {} : { f: f.key }, { replace: true })}
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
          </div>

          <div className="panel overflow-x-auto">
            {list.length === 0 ? (
              <p className="p-6 text-sm text-muted">{data.groups.length ? 'Aucune sauvegarde pour ce filtre.' : 'Aucune sauvegarde sur le PBS (ou pas encore relevée).'}</p>
            ) : (
              <table className="w-full min-w-[1000px] text-sm">
                <thead className="border-b border-line">
                  <tr>
                    <th className="th">Sauvegarde</th>
                    <th className="th">Hôte</th>
                    <th className="th">Dernière</th>
                    <th className="th">Taille</th>
                    <th className="th">Vérif.</th>
                    <th className="th">État</th>
                    {canManage && <th className="th">Seuil</th>}
                    {canManage && <th className="th text-right">Suivi</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {list.map((g) => {
                    const meta = backupStateMeta[g.state];
                    return (
                      <tr key={g.id} className={clsx('hover:bg-raised/40', (g.ignored || g.gone) && 'opacity-60')}>
                        <td className="td">
                          <div className="font-medium text-zinc-100">{groupLabel(g)}</div>
                          <div className="text-xs text-muted">{g.store}{g.ns ? ` › ${g.ns}` : ''} · {g.count} snapshot{g.count > 1 ? 's' : ''}</div>
                        </td>
                        <td className="td">
                          <HostCell g={g} hosts={hostList} canManage={canManage} onChange={(hostId) => update(g, { hostId: hostId ?? null })} />
                        </td>
                        <td className="td" title={dateTime(g.lastBackup)}>{timeAgo(g.lastBackup)}</td>
                        <td className="td tabular-nums text-zinc-300">{formatBytes(g.size)}</td>
                        <td className="td text-xs">
                          {g.verify === 'ok' ? <span className="text-emerald-400">ok</span> : g.verify === 'failed' ? <span className="text-red-400">échec</span> : <span className="text-zinc-500">—</span>}
                        </td>
                        <td className="td"><Badge tone={meta.tone}>{meta.label}</Badge></td>
                        {canManage && (
                          <td className="td">
                            <select
                              className="input h-8 w-32 py-1 text-xs"
                              value={g.staleHours ?? ''}
                              onChange={(e) => update(g, { staleHours: e.target.value ? Number(e.target.value) : null })}
                              title="Âge au-delà duquel la sauvegarde est en retard"
                            >
                              <option value="">défaut ({data.staleHours} h)</option>
                              <option value="26">quotidienne</option>
                              <option value="50">2 jours</option>
                              <option value="194">hebdomadaire</option>
                              <option value="768">mensuelle</option>
                            </select>
                          </td>
                        )}
                        {canManage && (
                          <td className="td">
                            <div className="flex items-center justify-end gap-2">
                              {g.gone ? (
                                <Button size="sm" variant="ghost" icon={Trash2} title="Oublier ce groupe disparu du PBS" onClick={() => forget(g)} />
                              ) : (
                                <label className="flex items-center gap-1.5 text-xs text-zinc-300" title="Une sauvegarde ignorée n'a ni état ni alerte">
                                  <input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={!g.ignored} onChange={(e) => update(g, { ignored: !e.target.checked })} />
                                  suivie
                                </label>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <p className="mt-3 text-xs text-muted">
            Rattachement automatique : l'identifiant de la sauvegarde (ou les notes d'une VM / d'un CT) est le nom ou le hostname d'un hôte, éventuellement suivi de <code>_…</code> ou <code>-…</code>.
          </p>
        </>
      )}
    </>
  );
}
