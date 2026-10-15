import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import clsx from 'clsx';
import { ArrowLeft, ArrowUpCircle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, History, KeyRound, Loader2, Lock, Package, Pencil, Power, RefreshCw, RotateCw, Search, Server, ShieldAlert, ShieldOff, Terminal, Trash2 } from 'lucide-react';
import { HaExcludedField } from '../components/HaExcludedField';
import { HostTagList, SiteChip, SiteSelect, TagPicker } from '../components/HostTags';
import { RoamingField } from '../components/RoamingField';
import { InstallInstructions } from '../components/InstallInstructions';
import { JobConsole, JobStatusIcon } from '../components/JobConsole';
import { RebootTag } from '../components/Reboot';
import { CleanupButton } from '../components/CleanupPanel';
import { DockerPanel } from '../components/Docker';
import { SetupButton, SetupModal, SetupStatus } from '../components/SetupPanel';
import { showSetup } from '../lib/setup';
import { AgentBadge, ReinstallBadge, UpdateAgentButton } from '../components/Agent';
import { useToast } from '../lib/toast';
import { Badge, Button, Checkbox, ConfirmModal, Empty, IconGroup, Modal, PageHeader, Panel, Spinner, Tag } from '../components/ui';
import { api, type Host, type InstallInfo, type Job } from '../lib/api';
import { dateTime, jobTitle, timeAgo, uptime } from '../lib/format';
import { useBackups, useHost, useHostJobs, useRunJob, useUpdateHostCache } from '../lib/queries';
import { useHosts, useSites, useTags } from '../lib/queries';
import { filterHosts, hostMatchesSearch, parseHostFilter } from '../lib/hostFilters';
import { HostBackups } from '../components/HostBackups';
import { AlertTimeline } from '../components/AlertTimeline';
import { agentRevoked, connection, hasApt, connectionMeta, isHaos, listsStale, needsReinstall, osLabel } from '../lib/status';
import { useAgentTls } from '../lib/agentTls';
import { useMe } from '../lib/auth';

// One fact of the system strip: label above, value below; `grow` takes the rest of the line (IP list).
function StripItem({ label, grow, children }: { label: string; grow?: boolean; children: ReactNode }) {
  return (
    <div className={clsx('min-w-0 border-r border-line px-4 py-2.5 last:border-r-0', grow && 'flex-1 basis-72')}>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className={clsx('mt-0.5 text-sm text-zinc-200', grow ? 'wrap-break-word' : 'whitespace-nowrap')}>{children}</dd>
    </div>
  );
}

// Large screens (fixed header): true once the page is scrolled, the alert timeline then shrinks to its
// rows; two thresholds so that the change of height does not make it flicker.
function useScrolled() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 1536px)');
    const update = () => setScrolled((s) => wide.matches && (s ? window.scrollY > 8 : window.scrollY > 60));
    window.addEventListener('scroll', update, { passive: true });
    wide.addEventListener('change', update);
    return () => {
      window.removeEventListener('scroll', update);
      wide.removeEventListener('change', update);
    };
  }, []);
  return scrolled;
}

// mounted only while open: its state starts from the current host
function EditModal({ host, onClose }: { host: Host; onClose: () => void }) {
  const [name, setName] = useState(host.name);
  const [siteId, setSiteId] = useState(host.siteId ?? '');
  const [tags, setTags] = useState(host.tags);
  const [roaming, setRoaming] = useState(host.roaming);
  const [haExcluded, setHaExcluded] = useState(host.haExcluded);
  const [busy, setBusy] = useState(false);
  const upsert = useUpdateHostCache();
  const toast = useToast();
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      upsert(await api.updateHost(host.id, { name, siteId, tags, roaming, haExcluded }));
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Modifier l'hôte">
      <form onSubmit={save} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Nom</span>
          <input className="input" required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <SiteSelect value={siteId} onChange={setSiteId} />
        <TagPicker value={tags} onChange={setTags} />
        <RoamingField checked={roaming} onChange={setRoaming} />
        <HaExcludedField checked={haExcluded} onChange={setHaExcluded} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
          <Button type="submit" variant="primary" loading={busy}>Enregistrer</Button>
        </div>
      </form>
    </Modal>
  );
}

// running: a job of the host is in progress; onStarted: the job started here (its console opens)
function PackagesPanel({ host, upgrading, running, onStarted }: { host: Host; upgrading: Job | undefined; running: boolean; onStarted: (jobId: string) => void }) {
  const run = useRunJob();
  const start = (action: 'apt_update' | 'apt_upgrade') => run.mutate({ hostId: host.id, action }, { onSuccess: (j) => onStarted(j.id) });
  const { canWrite } = useMe();
  const [picked, setSelected] = useState<Set<string>>(new Set());
  const pkgs = host.apt?.upgradable ?? [];
  const installed = host.recentlyInstalled;
  // packages of the running upgrade job (all of them for a full upgrade)
  const inProgress = (name: string) => !!upgrading && (upgrading.packages.length === 0 || upgrading.packages.includes(name));
  // drop selections that are no longer upgradable after a refresh
  const selected = new Set([...picked].filter((n) => pkgs.some((p) => p.name === n)));
  const rebootPkgs = pkgs.filter((p) => p.reboot).map((p) => p.name);

  const all = pkgs.length > 0 && selected.size === pkgs.length;
  const toggle = (n: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(n);
      else next.delete(n);
      return next;
    });

  return (
    <Panel
      title={<>Paquets à mettre à jour <span className="text-muted">({pkgs.length})</span>{installed.length > 0 && <span className="text-muted"> · {installed.length} installé(s) sur 24 h</span>}</>}
      icon={Package}
      bodyClassName=""
      actions={
        // upgrade: the selection when packages are ticked, everything otherwise
        <>
        <CleanupButton host={host} running={running} onStarted={onStarted} />
        <IconGroup
          actions={[
            {
              icon: RefreshCw,
              title: 'Rechercher les mises à jour',
              disabled: !canWrite || !host.online || running,
              loading: run.isPending && run.variables?.action === 'apt_update',
              onClick: () => start('apt_update'),
            },
            selected.size > 0
              ? {
                  icon: ArrowUpCircle,
                  title: `Mettre à jour la sélection (${selected.size})`,
                  disabled: !canWrite || !host.online || running,
                  loading: run.isPending && run.variables?.action === 'apt_upgrade',
                  onClick: () => run.mutate({ hostId: host.id, action: 'apt_upgrade', packages: [...selected] }, { onSuccess: () => setSelected(new Set()) }),
                }
              : {
                  icon: ArrowUpCircle,
                  title: 'Tout mettre à jour',
                  disabled: !canWrite || !host.online || running || !host.aptSummary?.upgradable,
                  loading: run.isPending && run.variables?.action === 'apt_upgrade',
                  onClick: () => start('apt_upgrade'),
                },
          ]}
        />
        </>
      }
    >
      {(rebootPkgs.length > 0 || (host.apt?.held.length ?? 0) > 0 || listsStale(host)) && (
        <div className="space-y-2 border-b border-line px-4 py-3 text-sm">
          {rebootPkgs.length > 0 && (
            <p className="flex flex-wrap items-center gap-2 text-amber-300">
              <RotateCw className="h-4 w-4" /> Redémarrage à prévoir après la mise à jour de : {rebootPkgs.join(', ')}
            </p>
          )}
          {(host.apt?.held.length ?? 0) > 0 && (
            <p className="flex flex-wrap items-center gap-2 text-zinc-300">
              <Lock className="h-4 w-4 text-muted" /> Paquets bloqués (hold) :
              {host.apt!.held.map((p) => <Tag key={p}>{p}</Tag>)}
            </p>
          )}
          {listsStale(host) && (
            <p className="flex items-center gap-2 text-violet-300">
              <ShieldAlert className="h-4 w-4" /> Listes de paquets périmées ({timeAgo(host.apt?.listsUpdatedAt)}) : lance une recherche.
            </p>
          )}
        </div>
      )}
      {!host.apt ? (
        <Empty icon={Package} title="Pas encore de relevé">L'agent n'a pas encore envoyé l'état des paquets.</Empty>
      ) : pkgs.length === 0 && installed.length === 0 ? (
        <Empty icon={Package} title="Tout est à jour">Dernière vérification {timeAgo(host.apt.listsUpdatedAt)}.</Empty>
      ) : (
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 border-b border-line bg-panel">
              <tr>
                <th className="th w-10">{pkgs.length > 0 && <Checkbox label="Tout sélectionner" checked={all} indeterminate={selected.size > 0} onChange={(on) => setSelected(on ? new Set(pkgs.map((p) => p.name)) : new Set())} />}</th>
                <th className="th">Paquet</th>
                <th className="th">Version</th>
                <th className="th">État</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {installed.map((p) => (
                <tr key={`installed-${p.name}`} className="bg-emerald-500/[0.03]">
                  <td className="td"><CheckCircle2 className="h-4 w-4 text-emerald-400" /></td>
                  <td className="td">
                    <span className="font-medium text-zinc-300">{p.name}</span>
                    <span className="block text-xs text-muted">installé {timeAgo(p.at)}</span>
                  </td>
                  <td className="td max-w-[200px] font-mono text-xs">
                    <span className="block truncate text-zinc-500 line-through" title={p.from}>{p.from}</span>
                    <span className="block truncate text-emerald-300" title={p.to}>{p.to}</span>
                  </td>
                  <td className="td">
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone="ok">Installé</Badge>
                      {p.rebootRequired && <Badge tone="bad" className="gap-1"><RotateCw className="h-3 w-3" />redémarrage requis</Badge>}
                    </div>
                  </td>
                </tr>
              ))}
              {pkgs.map((p) => (
                <tr key={p.name} className="cursor-pointer hover:bg-raised/50" onClick={() => toggle(p.name, !selected.has(p.name))}>
                  <td className="td"><Checkbox label={p.name} checked={selected.has(p.name)} onChange={(on) => toggle(p.name, on)} /></td>
                  <td className="td">
                    <span className="font-medium text-zinc-100">{p.name}</span>
                    {p.security && <Badge tone="bad" className="ml-2">sécurité</Badge>}
                    {p.reboot && <RebootTag />}
                    <span className="block max-w-[220px] truncate text-xs text-muted" title={p.repo}>{p.repo}</span>
                  </td>
                  <td className="td max-w-[200px] font-mono text-xs">
                    <span className="block truncate text-zinc-500" title={p.current}>{p.current}</span>
                    <span className="block truncate text-emerald-300" title={p.candidate}>{p.candidate}</span>
                  </td>
                  <td className="td">
                    {inProgress(p.name) ? (
                      <Badge tone="info" className="gap-1"><Loader2 className="h-3 w-3 animate-spin" />En cours</Badge>
                    ) : (
                      <span className="whitespace-nowrap text-xs text-muted">À installer</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function HostDetail() {
  const { id = '' } = useParams();
  return <HostDetailPage key={id} id={id} />;
}

function HostDetailPage({ id }: { id: string }) {
  const { data: host, isLoading } = useHost(id);
  const { data: hosts } = useHosts();
  const { data: sites } = useSites();
  const { data: tags } = useTags();
  const [params] = useSearchParams();
  const { data: jobs } = useHostJobs(id);
  const run = useRunJob();
  const { canWrite, canManage } = useMe();
  const navigate = useNavigate();
  const toast = useToast();
  const [jobId, setJobId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const backupsOn = !!useBackups().data?.enabled;
  const [deleting, setDeleting] = useState(false);
  const [install, setInstall] = useState<InstallInfo | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const tls = useAgentTls();
  const upsert = useUpdateHostCache();
  const [confirmReboot, setConfirmReboot] = useState(false);
  const scrolled = useScrolled();
  const [hostPickerOpen, setHostPickerOpen] = useState(false);
  const [hostSearch, setHostSearch] = useState('');
  const hostPickerRef = useRef<HTMLSpanElement>(null);

  const hostList = useMemo(
    () => filterHosts(hosts ?? [], params.get('q') ?? '', parseHostFilter(params.get('f')), params.get('site') ?? '', params.get('tag') ?? '', sites ?? [], tags ?? []),
    [hosts, params, sites, tags],
  );
  const currentIndex = hostList.findIndex((item) => item.id === id);
  const listSearch = params.toString();
  const hostPath = (hostId: string) => `/hosts/${hostId}${listSearch ? `?${listSearch}` : ''}`;
  const goToHost = (hostId: string) => navigate(hostPath(hostId));
  const pickerHosts = hostList.filter((item) => hostMatchesSearch(item, hostSearch, sites ?? [], tags ?? []));

  useEffect(() => {
    if (!hostPickerOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!hostPickerRef.current?.contains(event.target as Node)) setHostPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHostPickerOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [hostPickerOpen]);

  const shownJob = jobId ?? jobs?.[0]?.id ?? null;
  const running = useMemo(() => jobs?.some((j) => j.status === 'running'), [jobs]);

  if (isLoading) return <div className="flex justify-center p-20"><Spinner /></div>;
  if (!host) return <Empty icon={Server} title="Hôte introuvable"><Link className="text-emerald-400" to={`/hosts${listSearch ? `?${listSearch}` : ''}`}>Retour aux hôtes</Link></Empty>;

  const c = connection(host);

  // new single-use code; the current agent keeps working until the new installation enrolls
  const newInstall = async () => {
    try {
      setInstall(await api.enrollHost(host.id));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const revoke = async () => {
    try {
      upsert(await api.revokeHost(host.id));
      setConfirmRevoke(false);
      toast.success(`Agent de ${host.name} révoqué`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  // content in a fixed order (packages, Docker, then backups), a missing block letting the next one
  // move up: the backups get their own column, otherwise two blocks share the two columns
  const blocks: ReactNode[] = [];
  if (hasApt(host)) blocks.push(<PackagesPanel key="apt" host={host} upgrading={jobs?.find((j) => j.status === 'running' && j.action === 'apt_upgrade')} running={!!running} onStarted={setJobId} />);
  if (host.docker) blocks.push(<DockerPanel key="docker" host={host} running={!!running} onStarted={setJobId} />);
  if (!hasApt(host) && !host.docker) {
    blocks.push(
      <Panel key="system" title="Système" icon={Package}>
        <p className="text-sm text-muted">
          {isHaos(host)
            ? "Home Assistant OS : système, Core et applications se mettent à jour dans Home Assistant. L'agent tourne dans une application et décrit l'hôte ; sa sauvegarde Proxmox VE s'y rattache par l'adresse MAC."
            : "Pas de gestionnaire de paquets APT sur cet hôte : seul l'état du système et de Docker est suivi."}
        </p>
      </Panel>,
    );
  }
  const columns: ReactNode[][] = backupsOn ? [blocks, [<HostBackups key="backups" host={host} onStarted={setJobId} />]] : blocks.length > 1 ? blocks.map((b) => [b]) : [blocks];

  return (
    <>
      {/* large screens: the content on the left, history and console on the right, fixed */}
      <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_480px] 2xl:items-start min-[2200px]:grid-cols-[minmax(0,1fr)_640px]">
        <div className="min-w-0">
          {/* title, system strip and alert timeline stay on top while the content scrolls (below the 3.5rem bar of the layout) */}
          <div className={clsx('2xl:sticky 2xl:top-14 2xl:z-20 2xl:-mt-6 2xl:bg-bg 2xl:pt-6', scrolled ? 'pb-3 shadow-[0_14px_18px_-12px_rgb(0_0_0/0.7)]' : 'pb-5')}>
            <Link to={`/hosts${listSearch ? `?${listSearch}` : ''}`} className={clsx('mb-3 items-center gap-1.5 text-sm text-muted hover:text-zinc-200', scrolled ? 'hidden' : 'inline-flex')}>
              <ArrowLeft className="h-4 w-4" /> Hôtes
            </Link>
            <PageHeader
              icon={Server}
              titleOverflow
              title={
                <span ref={hostPickerRef} className="relative inline-flex items-center gap-1">
                  <button
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={hostPickerOpen}
                    onClick={() => {
                      setHostSearch('');
                      setHostPickerOpen((open) => !open);
                    }}
                    className="inline-flex items-center gap-1 rounded-sm text-left hover:text-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                  >
                    {host.name}
                    <ChevronDown className={clsx('h-4 w-4 text-muted transition-transform', hostPickerOpen && 'rotate-180')} />
                  </button>
                  {hostPickerOpen && (
                    <span role="dialog" aria-label="Sélectionner un hôte" className="absolute left-0 top-full z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-line bg-panel p-2 text-left shadow-xl">
                      <span className="relative mb-2 block">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                        <input
                          autoFocus
                          aria-label="Filtrer les hôtes"
                          className="input h-9 py-0 pl-9"
                          placeholder="Filtrer les hôtes…"
                          value={hostSearch}
                          onChange={(event) => setHostSearch(event.target.value)}
                        />
                      </span>
                      <span role="listbox" aria-label="Hôtes disponibles" className="block max-h-72 overflow-y-auto">
                        {pickerHosts.length ? pickerHosts.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            role="option"
                            aria-selected={item.id === id}
                            onClick={() => {
                              setHostPickerOpen(false);
                              if (item.id !== id) goToHost(item.id);
                            }}
                            className={clsx('flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm hover:bg-raised', item.id === id ? 'bg-raised text-emerald-300' : 'text-zinc-200')}
                          >
                            <span className={clsx('h-2 w-2 shrink-0 rounded-full', item.online ? 'bg-emerald-400' : 'bg-zinc-600')} />
                            <span className="min-w-0 flex-1 truncate">{item.name}</span>
                            {item.id === id && <span className="text-xs text-muted">Actuel</span>}
                          </button>
                        )) : (
                          <span className="block px-2.5 py-3 text-sm text-muted">Aucun hôte ne correspond aux filtres.</span>
                        )}
                      </span>
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label="Hôte précédent"
                    title={currentIndex > 0 ? `Précédent : ${hostList[currentIndex - 1].name}` : 'Aucun hôte précédent'}
                    disabled={currentIndex <= 0}
                    onClick={() => goToHost(hostList[currentIndex - 1].id)}
                    className="rounded-sm p-1 text-muted hover:bg-raised hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label="Hôte suivant"
                    title={currentIndex >= 0 && currentIndex < hostList.length - 1 ? `Suivant : ${hostList[currentIndex + 1].name}` : 'Aucun hôte suivant'}
                    disabled={currentIndex < 0 || currentIndex >= hostList.length - 1}
                    onClick={() => goToHost(hostList[currentIndex + 1].id)}
                    className="rounded-sm p-1 text-muted hover:bg-raised hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </span>
              }
              actions={
                canWrite && <>
                  <SetupButton host={host} onOpen={() => setSetupOpen(true)} />
                  {canManage && <Button icon={Pencil} variant="ghost" title="Modifier" onClick={() => setEditing(true)} />}
                  {host.capabilities.includes('reboot') && (
                    <Button
                      icon={Power}
                      variant={host.aptSummary?.rebootRequired ? 'danger' : 'secondary'}
                      disabled={!host.online || running}
                      onClick={() => setConfirmReboot(true)}
                    >
                      Redémarrer
                    </Button>
                  )}
                  {canManage && (
                    <>
                      <Button icon={KeyRound} variant="ghost" title="Nouvelle commande d'installation" onClick={newInstall} />
                      {host.agentAuth !== 'none' && (
                        <Button icon={ShieldOff} variant="ghost" title="Révoquer l'agent" className="hover:text-red-400" onClick={() => setConfirmRevoke(true)} />
                      )}
                      <Button icon={Trash2} variant="ghost" title="Supprimer" className="hover:text-red-400" onClick={() => setDeleting(true)} />
                    </>
                  )}
                </>
              }
            >
              <Badge tone={connectionMeta[c].tone}>{connectionMeta[c].label}</Badge>
              <SiteChip host={host} />
              <HostTagList host={host} />
              {host.roaming && <Tag>Itinérant</Tag>}
              {host.accessNetwork === 'tailscale' && <Tag>Réseau Tailscale</Tag>}
              {host.haExcluded && <Badge tone="info">Hors Home Assistant</Badge>}
            </PageHeader>

            <section className="panel">
              <dl className="flex flex-wrap">
                <StripItem label="Hostname">{host.info?.hostname ?? '—'}</StripItem>
                <StripItem label="OS">{osLabel(host) ?? '—'}</StripItem>
                <StripItem label="Noyau"><span className="font-mono text-xs">{host.info?.kernel ?? '—'}</span></StripItem>
                <StripItem label="Architecture">{host.info?.arch ?? '—'}</StripItem>
                <StripItem label="Virtualisation">{host.info?.virt ?? '—'}</StripItem>
                <StripItem label="Uptime">{host.info ? uptime(host.info.uptime) : '—'}</StripItem>
                <StripItem label="Agent">{host.agentVersion ?? '—'}</StripItem>
                <StripItem label="Certificat">
                  {host.certIssuedAt ? `émis le ${dateTime(host.certIssuedAt)}` : needsReinstall(host) ? <span className="text-red-300">ancien jeton</span> : '—'}
                </StripItem>
                <StripItem label="Vu">{host.online ? 'connecté' : timeAgo(host.lastSeenAt)}</StripItem>
                <StripItem label="Listes apt">{host.apt ? dateTime(host.apt.listsUpdatedAt) : '—'}</StripItem>
                {showSetup(host) && <StripItem label="Standard"><SetupStatus host={host} onOpen={() => setSetupOpen(true)} /></StripItem>}
                <StripItem label="IP" grow><span className="font-mono text-xs">{host.info?.ips?.join(', ') || '—'}</span></StripItem>
              </dl>
            </section>
            <div className={scrolled ? 'mt-2.5' : 'mt-4'}>
              <AlertTimeline hostId={host.id} compact={scrolled} />
            </div>
          </div>

          {host.aptSummary?.rebootRequired && (
            <div className="panel mb-5 flex flex-wrap items-center gap-3 border-red-500/50 bg-red-500/10 px-4 py-3 text-sm">
              <RotateCw className="h-5 w-5 text-red-400" />
              <span className="font-medium text-red-200">Redémarrage requis</span>
              {(host.apt?.rebootPkgs.length ?? 0) > 0 && <span className="text-xs text-red-200/80">pour appliquer : {host.apt!.rebootPkgs.join(', ')}</span>}
              {canWrite && host.capabilities.includes('reboot') && (
                <span className="ml-auto">
                  <Button size="sm" variant="danger" icon={Power} disabled={!host.online || running} onClick={() => setConfirmReboot(true)}>Redémarrer maintenant</Button>
                </span>
              )}
            </div>
          )}
          {(needsReinstall(host) || agentRevoked(host)) && (
            <div className="panel mb-5 flex flex-wrap items-center gap-3 border-red-500/50 bg-red-500/10 px-4 py-3 text-sm">
              {needsReinstall(host) ? <ReinstallBadge /> : <Badge tone="bad" className="gap-1"><ShieldOff className="h-3 w-3" />Agent révoqué</Badge>}
              <span className="text-red-100/90">
                {needsReinstall(host)
                  ? "Cet agent s'authentifie avec l'ancien jeton en clair, que le hub refuse désormais. Réinstalle-le avec une nouvelle commande d'installation."
                  : "Son certificat a été révoqué : l'agent ne peut plus se connecter. Réinstalle-le pour le reconnecter."}
              </span>
              {canManage && (
                <span className="ml-auto">
                  <Button size="sm" icon={KeyRound} onClick={newInstall}>Commande d'installation</Button>
                </span>
              )}
            </div>
          )}
          {host.agentOutdated && (
            <div className="panel mb-5 flex flex-wrap items-center gap-3 border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
              <AgentBadge />
              <span className="text-zinc-200">
                Agent {host.agentVersion ?? 'inconnu'}
                {host.latestAgentVersion && host.latestAgentVersion !== host.agentVersion && <> → {host.latestAgentVersion}</>}
              </span>
              {isHaos(host) ? (
                <span className="text-xs text-muted">mise à jour de l'application Homelab Manager Agent dans Home Assistant</span>
              ) : (
                <span className="ml-auto">{host.online && <UpdateAgentButton hosts={[host]} />}</span>
              )}
            </div>
          )}
          {canManage && c === 'pending' && (
            <Panel title="Installer l'agent" icon={Terminal} className="mb-5">
              <p className="mb-3 text-sm text-zinc-300">
                Cet hôte n'a encore jamais contacté le hub.{' '}
                {host.enrollExpiresAt
                  ? `Une commande d'installation est valable jusqu'au ${dateTime(host.enrollExpiresAt)} ; elle n'est affichée qu'une fois, génère-en une nouvelle si besoin.`
                  : "Aucune commande d'installation en cours de validité : génère-en une."}
              </p>
              <Button icon={KeyRound} onClick={newInstall}>Générer la commande d'installation</Button>
            </Panel>
          )}

          <div className={clsx('grid items-start gap-5', columns.length > 1 && 'min-[2200px]:grid-cols-2')}>
            {columns.map((col, i) => (
              <div key={i} className="flex min-w-0 flex-col gap-5">{col}</div>
            ))}
          </div>
        </div>

        {/* below the bar of the layout and the top padding of the page, up to the bottom of the window */}
        <aside className="flex min-w-0 flex-col gap-5 2xl:sticky 2xl:top-20 2xl:h-[calc(100vh-6.5rem)]">
        <Panel title="Historique" icon={History} className="2xl:flex 2xl:max-h-[35%] 2xl:shrink-0 2xl:flex-col" bodyClassName="max-h-[420px] overflow-auto 2xl:max-h-none 2xl:min-h-0">
          {!jobs?.length ? (
            <p className="p-4 text-sm text-muted">Aucune tâche.</p>
          ) : (
            <ul className="divide-y divide-line">
              {jobs.map((j) => (
                <li key={j.id}>
                  <button onClick={() => setJobId(j.id)} className={clsx('flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition hover:bg-raised/50', shownJob === j.id && 'bg-raised')}>
                    <JobStatusIcon status={j.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-zinc-200">{jobTitle(j)}{j.packages.length > 0 && ` (${j.packages.length})`}</span>
                      <span className="text-xs text-muted">{timeAgo(j.createdAt)}{j.trigger === 'schedule' && ' · planifiée'}{j.trigger === 'homeassistant' && ' · Home Assistant'}{j.trigger === 'enroll' && " · à l'ajout"}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
          <Panel title="Console" icon={Terminal} className="2xl:flex 2xl:min-h-0 2xl:flex-1 2xl:flex-col" bodyClassName="p-4 2xl:flex 2xl:min-h-0 2xl:flex-1 2xl:flex-col">
            {shownJob ? (
              <JobConsole jobId={shownJob} className="2xl:flex 2xl:min-h-0 2xl:flex-1 2xl:flex-col" height="h-[360px] 2xl:h-auto 2xl:min-h-0 2xl:flex-1" />
            ) : (
              <p className="text-sm text-muted">Les sorties des tâches s'affichent ici en direct.</p>
            )}
          </Panel>
        </aside>
      </div>

      {editing && <EditModal host={host} onClose={() => setEditing(false)} />}
      <SetupModal host={host} open={setupOpen} onClose={() => setSetupOpen(false)} running={!!running} onStarted={setJobId} />
      <ConfirmModal
        open={confirmReboot}
        onClose={() => setConfirmReboot(false)}
        title={`Redémarrer ${host.name}`}
        confirmLabel="Redémarrer"
        danger
        loading={run.isPending}
        onConfirm={() => run.mutate({ hostId: host.id, action: 'reboot' }, { onSuccess: (j) => { setJobId(j.id); setConfirmReboot(false); } })}
      >
        L'hôte redémarre dans les secondes qui suivent (<code className="text-zinc-100">systemctl reboot</code>). Il repasse « En ligne » dès que l'agent se reconnecte.
        {host.info?.virt === 'none' || !host.info?.virt ? null : <p className="mt-2 text-xs text-muted">Virtualisation : {host.info.virt} (seul ce conteneur ou cette VM redémarre).</p>}
      </ConfirmModal>
      <ConfirmModal open={confirmRevoke} onClose={() => setConfirmRevoke(false)} title={`Révoquer l'agent de ${host.name}`} confirmLabel="Révoquer" danger onConfirm={revoke}>
        L'agent est déconnecté immédiatement et son certificat est refusé, de même que toute commande d'installation en attente.
        L'hôte reste dans la liste avec son historique ; pour le reconnecter, réinstalle l'agent avec une nouvelle commande d'installation.
      </ConfirmModal>
      <ConfirmModal
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Supprimer ${host.name}`}
        confirmLabel="Supprimer"
        danger
        onConfirm={async () => {
          try {
            await api.deleteHost(host.id);
            navigate(`/hosts${listSearch ? `?${listSearch}` : ''}`);
          } catch (err) {
            toast.error((err as Error).message);
          }
        }}
      >
        L'hôte et son historique seront supprimés et l'agent déconnecté.{' '}
        {isHaos(host) ? "Pour désinstaller l'agent, supprime l'application Homelab Manager Agent dans Home Assistant." : "Pour désinstaller l'agent, en root sur l'hôte :"}
        {!isHaos(host) && tls?.uninstallCommand && (
          <pre className="mt-2 overflow-x-auto rounded-sm border border-line bg-black/40 p-2 font-mono text-xs text-zinc-300">{tls.uninstallCommand}</pre>
        )}
      </ConfirmModal>
      <Modal open={!!install} onClose={() => setInstall(null)} title={`Installer l'agent sur ${host.name}`} wide>
        {install && <InstallInstructions install={install} />}
      </Modal>
    </>
  );
}
