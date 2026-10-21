import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
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
import { HeaderTitle } from '../components/HeaderSlot';
import { HostsOverview } from '../components/HostsOverview';
import { Badge, Button, Checkbox, ConfirmModal, Empty, ResponsiveList, Spinner, StatusDot, Tag } from '../components/ui';
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
  const os = params.get('os') ?? '';
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

  const setMany = (values: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(values)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const setParam = (k: string, v: string) => setMany({ [k]: v });

  // agents out of sync with the binary served by the hub, able to update themselves now
  const outdatedAgents = (hosts ?? []).filter((h) => h.agentOutdated && h.online && canSelfUpdate(h));

  const list = useMemo(
    () => filterHosts(hosts ?? [], q, filter, site, tag, sites ?? [], tags ?? [], os),
    [hosts, q, filter, site, tag, os, sites, tags],
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
      <HeaderTitle icon={Server} title="Hôtes" />

      <HostsOverview
        hosts={hosts}
        sites={sites ?? []}
        filter={filter}
        site={site}
        os={os}
        onFilter={(key) => setParam('f', key === filter ? '' : key)}
        onSite={(id) => setParam('site', id)}
        onOs={(key) => setParam('os', key)}
        onSiteOs={(id, key) => setMany({ site: id, os: key })}
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
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {canWrite && outdatedAgents.length > 0 && (
            <Button icon={CircleArrowUp} onClick={() => setAllAgentsModal(true)}>Mettre à jour les agents ({outdatedAgents.length})</Button>
          )}
          {canManage && <Button icon={Plus} variant="primary" onClick={() => setAdding(true)}>Ajouter un hôte</Button>}
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

      <div className="panel overflow-hidden">
        {list.length === 0 ? (
          <Empty icon={Server} title={hosts.length ? 'Aucun hôte ne correspond' : 'Aucun hôte'} />
        ) : (
          <>
            <ResponsiveList mode="mobile">
              {canWrite && (
                <label className="flex items-center gap-2 px-4 py-3 text-xs text-muted">
                  <Checkbox
                    label="Tout sélectionner"
                    checked={allChecked}
                    indeterminate={visibleSelected.length > 0}
                    onChange={(on) => setSelected(on ? new Set(list.map((h) => h.id)) : new Set())}
                  />
                  Tout sélectionner
                </label>
              )}
              {list.map((h) => {
                const s = h.aptSummary;
                const status = connectionMeta(h);
                const backup = hostBackups(backups?.groups, h.id);
                return (
                  <article key={h.id} className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-2">
                        {canWrite && <Checkbox label={`Sélectionner ${h.name}`} checked={selected.has(h.id)} onChange={(on) => toggle(h.id, on)} />}
                        <StatusDot tone={status.tone} />
                        <div className="min-w-0">
                          <Link
                            to={`/hosts/${h.id}${params.size ? `?${params.toString()}` : ''}`}
                            className="break-all font-medium text-zinc-100 hover:text-emerald-300"
                          >
                            {h.name}
                          </Link>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            <Badge tone={status.tone}>{status.label}</Badge>
                            <HostTagList host={h} />
                            {h.accessNetwork === 'tailscale' && <Tag>Tailscale</Tag>}
                          </div>
                        </div>
                      </div>
                      {h.siteId ? <SiteChip host={h} /> : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {!hasApt(h) ? <Badge tone="neutral">MAJ non prises en charge</Badge> : !s ? <Badge tone="unknown">MAJ inconnues</Badge> : s.upgradable === 0 ? <Badge tone="ok">À jour</Badge> : (
                        <>
                          {s.security > 0 && <Badge tone="bad">{s.security} sécu</Badge>}
                          <Badge tone="warn">{s.upgradable} MAJ</Badge>
                        </>
                      )}
                      {h.dockerSummary?.updates ? <Badge tone="warn"><Container className="h-3 w-3" />{h.dockerSummary.updates} Docker</Badge> : null}
                      <RebootStatus summary={s} compact />
                      {h.agentOutdated && <AgentBadge short />}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {canWrite && (
                        <Button
                          size="sm"
                          icon={RefreshCw}
                          loading={run.isPending}
                          disabled={!h.online}
                          title="Rechercher les mises à jour"
                          onClick={() => run.mutate({ hostId: h.id, action: 'apt_update' })}
                        >
                          Rechercher les MAJ
                        </Button>
                      )}
                      {canManage && (
                        <Button size="sm" icon={Settings} title="Options" onClick={() => setOptionsHostId(h.id)}>
                          Options
                        </Button>
                      )}
                    </div>

                    <details className="border-t border-line pt-2">
                      <summary className="cursor-pointer text-xs text-muted hover:text-zinc-200">Détails système et activité</summary>
                      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                        <dt className="text-muted">Système</dt>
                        <dd className="text-zinc-300">
                          {osLabel(h) ?? '—'}{h.info?.virt && h.info.virt !== 'none' ? ` · ${h.info.virt}` : ''}
                        </dd>
                        <dt className="text-muted">IP</dt>
                        <dd className="break-all font-mono text-zinc-400">{h.info?.ips?.[0] ?? '—'}</dd>
                        <dt className="text-muted">Dernière vérif.</dt>
                        <dd className={listsStale(h) ? 'text-violet-300' : 'text-zinc-400'}>{h.apt ? timeAgo(h.apt.listsUpdatedAt) : '—'}</dd>
                        <dt className="text-muted">Vu</dt>
                        <dd className="text-zinc-400">{h.online ? 'Maintenant' : timeAgo(h.lastSeenAt)}</dd>
                        <dt className="text-muted">Agent</dt>
                        <dd className="text-zinc-400">{h.agentVersion ?? '—'}</dd>
                        {h.setup?.drift ? (
                          <>
                            <dt className="text-muted">Standardisation</dt>
                            <dd><Badge tone="warn" className="gap-1"><Wand2 className="h-3 w-3" />Non standard</Badge></dd>
                          </>
                        ) : null}
                        {backup && backup.state !== 'ok' ? (
                          <>
                            <dt className="text-muted">Sauvegarde</dt>
                            <dd>
                              <Badge tone={backup.state === 'failed' || backup.state === 'task_failed' ? 'bad' : 'warn'} className="gap-1">
                                <DatabaseBackup className="h-3 w-3" />
                                {backup.state === 'failed' || backup.state === 'task_failed' ? 'En échec' : backup.state === 'disabled' ? 'Désactivée' : 'En retard'}
                              </Badge>
                            </dd>
                          </>
                        ) : null}
                        {needsReinstall(h) && (
                          <>
                            <dt className="text-muted">Agent</dt>
                            <dd><ReinstallBadge short /></dd>
                          </>
                        )}
                      </dl>
                    </details>
                  </article>
                );
              })}
            </ResponsiveList>
            <ResponsiveList mode="desktop">
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
            </ResponsiveList>
          </>
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
