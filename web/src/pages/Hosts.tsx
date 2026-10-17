import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import clsx from 'clsx';
import { ArrowUpCircle, Brush, CircleArrowUp, Container, DatabaseBackup, Plus, RefreshCw, Search, Server, Settings, Wand2 } from 'lucide-react';
import { hostBackups } from '../lib/backups';
import { filterHosts, hostFilters, parseHostFilter } from '../lib/hostFilters';
import { AddHostModal } from '../components/AddHostModal';
import { CleanupModal } from '../components/CleanupPanel';
import { HostOptionsModal } from '../components/HostOptionsModal';
import { RebootStatus } from '../components/Reboot';
import { AgentBadge, ReinstallBadge, UpdateAgentsModal } from '../components/Agent';
import { BulkSetupModal } from '../components/SetupPanel';
import { Badge, Button, Checkbox, ConfirmModal, Empty, PageHeader, Spinner, StatusDot, Tag } from '../components/ui';
import { timeAgo } from '../lib/format';
import { useBackups, useHosts, useRunBulk, useRunJob, useSites, useTags } from '../lib/queries';
import { HostTagList, SiteChip } from '../components/HostTags';
import { canSelfUpdate, connectionMeta, hasApt, listsStale, needsReinstall, osLabel } from '../lib/status';
import { useMe } from '../lib/auth';
import type { Host } from '../lib/api';

export function Hosts() {
  const { data: hosts, isLoading } = useHosts();
  const { data: backups } = useBackups();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get('q') ?? '';
  const filter = parseHostFilter(params.get('f'));
  const site = params.get('site') ?? '';
  const tag = params.get('tag') ?? '';
  const { data: sites } = useSites();
  const { data: tags } = useTags();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [confirmUpgrade, setConfirmUpgrade] = useState(false);
  const [agentModal, setAgentModal] = useState(false);
  const [allAgentsModal, setAllAgentsModal] = useState(false);
  const [setupModal, setSetupModal] = useState(false);
  const [cleanupHost, setCleanupHost] = useState<Host | null>(null);
  const [optionsHostId, setOptionsHostId] = useState<string | null>(null);
  const bulk = useRunBulk();
  const { canWrite, canManage } = useMe();
  const run = useRunJob();

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  // agents out of sync with the binary served by the hub, able to update themselves now
  const outdatedAgents = (hosts ?? []).filter((h) => h.agentOutdated && h.online && canSelfUpdate(h));

  const list = useMemo(
    () => filterHosts(hosts ?? [], q, filter, site, tag, sites ?? [], tags ?? []),
    [hosts, q, filter, site, tag, sites, tags],
  );

  const optionsHost = hosts?.find((h) => h.id === optionsHostId);
  const visibleSelected = list.filter((h) => selected.has(h.id));
  const allChecked = list.length > 0 && visibleSelected.length === list.length;
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  if (isLoading || !hosts) return <div className="flex justify-center p-20"><Spinner /></div>;

  return (
    <>
      <PageHeader
        icon={Server}
        title="Hôtes"
        actions={
          <>
            {canWrite && outdatedAgents.length > 0 && (
              <Button icon={CircleArrowUp} onClick={() => setAllAgentsModal(true)}>Mettre à jour les agents ({outdatedAgents.length})</Button>
            )}
            {canManage && <Button icon={Plus} variant="primary" onClick={() => setAdding(true)}>Ajouter un hôte</Button>}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input className="input h-9 py-0 pl-9" placeholder="Nom, IP, site, tag…" value={q} onChange={(e) => setParam('q', e.target.value)} />
        </div>
        {!!sites?.length && (
          <select className="input h-9 w-auto py-0" value={site} onChange={(e) => setParam('site', e.target.value)} aria-label="Site">
            <option value="">Tous les sites</option>
            {sites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            <option value="none">Sans site</option>
          </select>
        )}
        {!!tags?.length && (
          <select className="input h-9 w-auto py-0" value={tag} onChange={(e) => setParam('tag', e.target.value)} aria-label="Tag">
            <option value="">Tous les tags</option>
            {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <div className="flex flex-wrap gap-1 rounded-md border border-line bg-panel p-1">
          {/* the reinstall filter only matters while old agents remain */}
          {hostFilters.filter((f) => f.key !== 'reinstall' || filter === 'reinstall' || hosts?.some(needsReinstall)).map((f) => (
            <button key={f.key} onClick={() => setParam('f', f.key === 'all' ? '' : f.key)}
              className={clsx('rounded-sm px-2.5 py-1 text-xs font-medium transition', filter === f.key ? 'bg-raised text-zinc-100 ring-1 ring-line' : 'text-muted hover:text-zinc-200')}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {canWrite && visibleSelected.length > 0 && (
        <div className="panel mb-3 flex flex-wrap items-center gap-3 border-emerald-500/30 bg-emerald-500/5 px-4 py-2.5 text-sm">
          <span className="text-zinc-200">{visibleSelected.length} sélectionné(s)</span>
          <Button size="sm" icon={RefreshCw} loading={bulk.isPending} onClick={() => bulk.mutate({ hostIds: visibleSelected.map((h) => h.id), action: 'apt_update' })}>
            Rechercher les MAJ
          </Button>
          <Button size="sm" icon={ArrowUpCircle} variant="primary" onClick={() => setConfirmUpgrade(true)}>Tout mettre à jour</Button>
          {visibleSelected.some((h) => h.agentOutdated) && (
            <Button size="sm" onClick={() => setAgentModal(true)}>Mettre à jour les agents</Button>
          )}
          {visibleSelected.some((h) => h.capabilities.includes('setup')) && (
            <Button size="sm" icon={Wand2} onClick={() => setSetupModal(true)}>Standardisation</Button>
          )}
          <button className="ml-auto text-xs text-muted hover:text-zinc-200" onClick={() => setSelected(new Set())}>Désélectionner</button>
        </div>
      )}

      <div className="panel overflow-x-auto">
        {list.length === 0 ? (
          <Empty icon={Server} title={hosts.length ? 'Aucun hôte ne correspond' : 'Aucun hôte'} />
        ) : (
          <table className="w-full min-w-[1200px] text-sm">
            <thead className="border-b border-line">
              <tr>
                {canWrite && <th className="th w-10"><Checkbox label="Tout sélectionner" checked={allChecked} indeterminate={visibleSelected.length > 0} onChange={(on) => setSelected(on ? new Set(list.map((h) => h.id)) : new Set())} /></th>}
                <th className="th">Hôte</th>
                <th className="th">Site</th>
                <th className="th">Système</th>
                <th className="th">IP</th>
                <th className="th">Mises à jour</th>
                <th className="th">Redémarrage</th>
                <th className="th">Dernière vérif.</th>
                <th className="th">Agent</th>
                <th className="th">Vu</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((h) => {
                const s = h.aptSummary;
                return (
                  <tr key={h.id} onClick={() => navigate(`/hosts/${h.id}${params.size ? `?${params.toString()}` : ''}`)} className="cursor-pointer transition hover:bg-raised/50">
                    {canWrite && <td className="td"><Checkbox label={`Sélectionner ${h.name}`} checked={selected.has(h.id)} onChange={(on) => toggle(h.id, on)} /></td>}
                    <td className="td">
                      <div className="flex items-center gap-2.5">
                        <StatusDot tone={connectionMeta(h).tone} />
                        <span className="whitespace-nowrap font-medium text-zinc-100">{h.name}</span>
                        <HostTagList host={h} />
                        {h.accessNetwork === 'tailscale' && <Tag>Tailscale</Tag>}
                      </div>
                    </td>
                    <td className="td">
                      {h.siteId ? <SiteChip host={h} /> : <span className="text-muted">—</span>}
                    </td>
                    <td className="td text-zinc-300">
                      {osLabel(h) ?? <span className="text-muted">—</span>}
                      {h.info?.virt && h.info.virt !== 'none' && <span className="ml-2 text-xs text-muted">{h.info.virt}</span>}
                    </td>
                    <td className="td font-mono text-xs text-zinc-400">{h.info?.ips?.[0] ?? '—'}</td>
                    <td className="td">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {!hasApt(h) ? <Badge tone="neutral">non pris en charge</Badge> : !s ? <Badge tone="unknown">inconnu</Badge> : s.upgradable === 0 ? <Badge tone="ok">à jour</Badge> : (
                          <>
                            {s.security > 0 && <Badge tone="bad">{s.security} sécu</Badge>}
                            <Badge tone="warn">{s.upgradable}</Badge>
                          </>
                        )}
                        {!!s?.autoremovable && (canWrite && h.online && h.apt?.autoremovable?.length ? (
                          <button type="button" title="Nettoyer (apt autoremove)" className="rounded-sm transition hover:brightness-125"
                            onClick={(e) => { e.stopPropagation(); setCleanupHost(h); }}>
                            <Badge tone="neutral" className="gap-1"><Brush className="h-3 w-3" />{s.autoremovable} à nettoyer</Badge>
                          </button>
                        ) : (
                          <Badge tone="neutral" className="gap-1"><Brush className="h-3 w-3" />{s.autoremovable} à nettoyer</Badge>
                        ))}
                        {!!h.dockerSummary?.updates && (
                          <span title="Stacks Docker avec une image à mettre à jour">
                            <Badge tone="warn" className="gap-1"><Container className="h-3 w-3" />{h.dockerSummary.updates} docker</Badge>
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="td" title={s?.rebootRequired ? "L'hôte attend un redémarrage" : s?.rebootPending ? 'Des mises à jour en attente nécessiteront un redémarrage' : undefined}>
                      <RebootStatus summary={s} />
                    </td>
                    <td className={clsx('td text-xs', listsStale(h) ? 'text-violet-300' : 'text-zinc-400')}>{h.apt ? timeAgo(h.apt.listsUpdatedAt) : '—'}</td>
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-zinc-400">{h.agentVersion ?? '—'}</span>
                        {h.agentOutdated && <AgentBadge short />}
                        {!!h.setup?.drift && <Badge tone="warn" className="gap-1"><Wand2 className="h-3 w-3" />non standard</Badge>}
                        {(() => {
                          const b = hostBackups(backups?.groups, h.id);
                          return b && b.state !== 'ok' && (
                            <Badge tone={b.state === 'failed' || b.state === 'task_failed' ? 'bad' : 'warn'} className="gap-1">
                              <DatabaseBackup className="h-3 w-3" />sauvegarde {b.state === 'failed' || b.state === 'task_failed' ? 'en échec' : b.state === 'disabled' ? 'désactivée' : 'en retard'}
                            </Badge>
                          );
                        })()}
                        {needsReinstall(h) && <ReinstallBadge short />}
                      </div>
                    </td>
                    <td className="td text-xs text-zinc-400">{h.online ? 'maintenant' : timeAgo(h.lastSeenAt)}</td>
                    <td className="td text-right" onClick={(e) => e.stopPropagation()}>
                      {canWrite && <Button size="sm" variant="ghost" icon={RefreshCw} disabled={!h.online} title="Rechercher les mises à jour"
                        onClick={() => run.mutate({ hostId: h.id, action: 'apt_update' })} />}
                      {canManage && <Button size="sm" variant="ghost" icon={Settings} title="Options" onClick={() => setOptionsHostId(h.id)} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <CleanupModal host={cleanupHost} onClose={() => setCleanupHost(null)} />
      {optionsHost && <HostOptionsModal host={optionsHost} onClose={() => setOptionsHostId(null)} />}

      <ConfirmModal
        open={confirmUpgrade}
        onClose={() => setConfirmUpgrade(false)}
        title="Mettre à jour les hôtes sélectionnés"
        confirmLabel="Lancer les mises à jour"
        loading={bulk.isPending}
        onConfirm={() => bulk.mutate({ hostIds: visibleSelected.map((h) => h.id), action: 'apt_upgrade' }, { onSuccess: () => setConfirmUpgrade(false) })}
      >
        <p className="mb-3"><code className="text-zinc-100">apt-get upgrade</code> va être lancé sur :</p>
        <div className="flex flex-wrap gap-1.5">{visibleSelected.map((h) => <Tag key={h.id}>{h.name}</Tag>)}</div>
        {visibleSelected.some((h) => h.aptSummary?.rebootPending) && (
          <p className="mt-3 text-sm text-amber-300">
            Redémarrage à prévoir ensuite : {visibleSelected.filter((h) => h.aptSummary?.rebootPending).map((h) => h.name).join(', ')}.
          </p>
        )}
        <p className="mt-3 text-xs text-muted">Les configurations locales modifiées sont conservées (--force-confold). Aucun redémarrage n'est effectué.</p>
      </ConfirmModal>
      <BulkSetupModal hosts={visibleSelected} open={setupModal} onClose={() => setSetupModal(false)} />
      <AddHostModal open={adding} onClose={() => setAdding(false)} />
      <UpdateAgentsModal hosts={visibleSelected.filter((h) => h.agentOutdated)} open={agentModal} onClose={() => setAgentModal(false)} />
      <UpdateAgentsModal hosts={outdatedAgents} open={allAgentsModal} onClose={() => setAllAgentsModal(false)} />
    </>
  );
}
