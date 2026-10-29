import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import clsx from 'clsx';
import { ArrowLeft, ArrowUpCircle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, History, KeyRound, Loader2, Lock, Package, Power, RefreshCw, RotateCw, Search, Server, Settings, ShieldAlert, ShieldOff, Terminal } from 'lucide-react';
import { HostOptionsModal } from '../components/HostOptionsModal';
import { HostTagList, SiteChip } from '../components/HostTags';
import { InstallInstructions, WINDOWS_UNINSTALL } from '../components/InstallInstructions';
import { JobConsole, JobStatusIcon } from '../components/JobConsole';
import { RebootTag } from '../components/Reboot';
import { CleanupButton } from '../components/CleanupPanel';
import { DockerPanel } from '../components/Docker';
import { UpsPanel } from '../components/UpsPanel';
import { HealthPanel } from '../components/HealthPanel';
import { SessionsPanel } from '../components/SessionsPanel';
import { SetupModal, SetupStatus } from '../components/SetupPanel';
import { showSetup } from '../lib/setup';
import { AgentBadge, ReinstallBadge, UpdateAgentButton } from '../components/Agent';
import { useToast } from '../lib/toast';
import { HeaderExtra, HeaderTitle } from '../components/HeaderSlot';
import { Badge, Button, Checkbox, ConfirmModal, Empty, Modal, Panel, Spinner, StatusDot, Tag } from '../components/ui';
import { api, type Host, type InstallInfo, type Job } from '../lib/api';
import { dateTime, groupIps, jobTitle, timeAgo, uptime } from '../lib/format';
import { keys, useBackups, useHost, useHostJobs, useRunJob, useUpdateHostCache } from '../lib/queries';
import { useHosts, useSites, useTags } from '../lib/queries';
import { filterHosts, hostMatchesSearch, parseHostFilter } from '../lib/hostFilters';
import { HostBackups } from '../components/HostBackups';
import { HostRolesPanel } from '../components/MqttBrokers';
import { ProbesPanel } from '../components/Probes';
import { AlertTimeline } from '../components/AlertTimeline';
import { agentRevoked, connection, hasApt, connectionMeta, isHaos, isWindows, listsStale, needsReinstall, osLabel, toneBadge, type Tone } from '../lib/status';
import { useAgentTls } from '../lib/agentTls';
import { useMe } from '../lib/auth';

// One fact of the system strip: label above, value below; `grow` takes the rest of the line (IP list).
// Colour of the hostname in the system strip, by connection state
const nameTone: Record<Tone, string> = {
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  bad: 'text-red-300',
  unknown: 'text-violet-300',
  info: 'text-sky-300',
  neutral: 'text-zinc-400',
};

// One cell of the system strip: the label on one line, the value on two lines at most (the full text in the tooltip).
function StripItem({ label, grow, plain, children }: { label: string; grow?: boolean; plain?: boolean; children: ReactNode }) {
  return (
    <div className={clsx('min-w-0 shrink border-r border-line px-4 py-2.5 last:border-r-0', grow && 'flex-1 basis-40')}>
      <dt className="truncate text-[11px] font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd
        onMouseEnter={(e) => { const el = e.currentTarget; el.title = el.scrollHeight > el.clientHeight + 1 ? (el.textContent ?? '') : ''; }}
        className={clsx('mt-0.5 text-sm text-zinc-200', plain ? 'flex max-h-[3.25rem] flex-wrap gap-1 overflow-hidden' : 'line-clamp-2 break-words')}
      >
        {children}
      </dd>
    </div>
  );
}

// Height of an element, followed while it resizes.
function useHeight(el: HTMLElement | null) {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return height;
}

// Large screens: detect scroll to keep the sticky host header compact.
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
        <div className="flex flex-wrap items-center gap-2">
          <CleanupButton host={host} running={running} onStarted={onStarted} />
          <Button
            size="sm"
            icon={RefreshCw}
            disabled={!canWrite || !host.online || running}
            loading={run.isPending && run.variables?.action === 'apt_update'}
            onClick={() => start('apt_update')}
          >
            Rechercher
          </Button>
          <Button
            size="sm"
            icon={ArrowUpCircle}
            disabled={!canWrite || !host.online || running || (!selected.size && !host.aptSummary?.upgradable)}
            loading={run.isPending && run.variables?.action === 'apt_upgrade'}
            onClick={() => selected.size
              ? run.mutate({ hostId: host.id, action: 'apt_upgrade', packages: [...selected] }, { onSuccess: () => setSelected(new Set()) })
              : start('apt_upgrade')}
          >
            {selected.size ? `Mettre à jour (${selected.size})` : 'Tout mettre à jour'}
          </Button>
        </div>
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
  const queryClient = useQueryClient();
  const run = useRunJob();
  const refreshRun = useRunJob();
  const { canWrite, canManage, features } = useMe();
  const navigate = useNavigate();
  const toast = useToast();
  const [jobId, setJobId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const backupsData = useBackups().data;
  // something to follow: the main PBS, backups of Home Assistant, Proxmox VE clusters
  const backupsOn = !!backupsData && (backupsData.connected || backupsData.groups.length > 0 || backupsData.clusters.length > 0);
  const [deleting, setDeleting] = useState(false);
  const [install, setInstall] = useState<InstallInfo | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const tls = useAgentTls();
  const upsert = useUpdateHostCache();
  const [confirmReboot, setConfirmReboot] = useState(false);
  const [confirmShutdown, setConfirmShutdown] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const scrolled = useScrolled();
  const [stripEl, setStripEl] = useState<HTMLDivElement | null>(null);
  const stripHeight = useHeight(stripEl);
  const [hostPickerOpen, setHostPickerOpen] = useState(false);
  const [hostSearch, setHostSearch] = useState('');
  const hostPickerRef = useRef<HTMLSpanElement>(null);

  const hostList = useMemo(
    () => filterHosts(hosts ?? [], params.get('q') ?? '', parseHostFilter(params.get('f')), params.get('site') ?? '', params.get('tag') ?? '', sites ?? [], tags ?? [], params.get('kind') ?? ''),
    [hosts, params, sites, tags],
  );
  const currentIndex = hostList.findIndex((item) => item.id === id);
  const listSearch = params.toString();
  // previous / next host replace the entry: "back" returns to the screen the host was opened from (dashboard, list...)
  const goToHost = useCallback((hostId: string) => navigate(`/hosts/${hostId}${listSearch ? `?${listSearch}` : ''}`, { replace: true }), [navigate, listSearch]);
  const location = useLocation();
  const goBack = useCallback(() => {
    // no history inside the app (page opened directly): the list of hosts
    if (location.key === 'default') navigate(`/hosts${listSearch ? `?${listSearch}` : ''}`);
    else navigate(-1);
  }, [location.key, listSearch, navigate]);

  // ← / → : previous / next host of the list (not while typing or with a dialog open)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Backspace') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('[data-modal]')) return;
      if (event.key === 'Backspace') {
        event.preventDefault();
        goBack();
        return;
      }
      const next = hostList[currentIndex + (event.key === 'ArrowRight' ? 1 : -1)];
      if (currentIndex < 0 || !next) return;
      event.preventDefault();
      goToHost(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hostList, currentIndex, goBack, goToHost]);

  const pickerHosts = hostList.filter((item) => hostMatchesSearch(item, hostSearch, sites ?? [], tags ?? []));

  const canRefreshAgent = !!host?.online && !!host.capabilities?.includes('refresh');
  const refreshData = async () => {
    if (!host) return;
    setRefreshing(true);
    try {
      const actions: ('apt_update' | 'docker_check')[] = [];
      if (host.online) {
        if (hasApt(host)) actions.push('apt_update');
        if (host.docker) actions.push('docker_check');
      }
      const checksPromise = Promise.allSettled(actions.map((action) => refreshRun.mutateAsync({ hostId: host.id, action })));
      const backupsPromise = Promise.allSettled([backupsOn ? api.refreshBackups().then(() => true) : Promise.resolve(false)]);
      // the agent reads its local state again (system, health measures, Docker stacks, Home Assistant backups, UPS)
      const agentPromise = canRefreshAgent ? api.refreshHost(host.id).then(() => true, () => false) : Promise.resolve(false);
      const [checkResults, backupResults, agentRefreshed] = await Promise.all([checksPromise, backupsPromise, agentPromise]);
      const started = checkResults.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      if (started.length) setJobId(started[0].id);
      await queryClient.invalidateQueries({ queryKey: keys.hostJobs(id) });
      // the agent has just sent new health measures (chart history of the panel)
      if (agentRefreshed) await queryClient.invalidateQueries({ queryKey: ['health', host.id] });
      if (backupsOn) await queryClient.invalidateQueries({ queryKey: keys.backups });

      const backupResult = backupResults[0];
      if (backupResult.status === 'rejected') toast.error(`Actualisation des sauvegardes : ${(backupResult.reason as Error).message}`);
      const backupsUpdated = backupResult.status === 'fulfilled' && backupResult.value;
      const details = [
        agentRefreshed && 'agent actualisé',
        started.length > 0 && `${started.length} vérification${started.length > 1 ? 's' : ''} lancée${started.length > 1 ? 's' : ''}`,
        backupsUpdated && 'sauvegardes actualisées',
        !host.online && (hasApt(host) || !!host.docker) && 'hôte hors ligne : vérifications APT/Docker ignorées',
      ].filter((detail): detail is string => typeof detail === 'string');
      if (details.length) toast.success(details.join(' · '));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

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

  // Ordered cards flow into balanced columns when there is enough room.
  const blocks: ReactNode[] = [];
  if (host.capabilities.includes('health')) blocks.push(<HealthPanel key="health" host={host} canManage={canManage} />);
  if (host.ups) blocks.push(<UpsPanel key="ups" hostId={host.id} ups={host.ups} canControl={!!host.capabilities?.includes('ups_control')} />);
  if (hasApt(host)) blocks.push(<PackagesPanel key="apt" host={host} upgrading={jobs?.find((j) => j.status === 'running' && j.action === 'apt_upgrade')} running={!!running} onStarted={setJobId} />);
  if (host.docker) blocks.push(<DockerPanel key="docker" host={host} running={!!running} onStarted={setJobId} />);
  blocks.push(<HostRolesPanel key="roles" host={host} />);
  blocks.push(<ProbesPanel key="probes" owner={{ kind: 'host', host }} />);
  if (isWindows(host)) blocks.push(<SessionsPanel key="sessions" host={host} />);
  else if (!hasApt(host) && !host.docker) {
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
  // Windows: only once the agent found the backup CLI set in the options of the host (homelab#208)
  if (backupsOn && (!isWindows(host) || host.capabilities.includes('backup:cli'))) blocks.push(<HostBackups key="backups" host={host} onStarted={setJobId} />);

  return (
    <>
      {/* the system strip spans the page and stays on top while the content scrolls (below the 3.5rem bar of the layout) */}
          <HeaderExtra><SiteChip host={host} prominent /></HeaderExtra>
          <HeaderTitle
            icon={Server}
            overflow
            back={
              <button
                type="button"
                onClick={goBack}
                title="Retour à l'écran précédent (Retour arrière)"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-2 text-sm text-muted transition hover:bg-raised hover:text-zinc-100"
              >
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">Retour</span>
              </button>
            }
            status={
              <span className={clsx('inline-flex shrink-0 items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset', toneBadge[connectionMeta(host).tone])}>
                <StatusDot tone={connectionMeta(host).tone} pulse={connectionMeta(host).label === 'En ligne'} />
                {connectionMeta(host).label}
              </span>
            }
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
                  title={currentIndex > 0 ? `Précédent : ${hostList[currentIndex - 1].name} (←)` : 'Aucun hôte précédent'}
                  disabled={currentIndex <= 0}
                  onClick={() => goToHost(hostList[currentIndex - 1].id)}
                  className="rounded-sm p-1 text-muted hover:bg-raised hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label="Hôte suivant"
                  title={currentIndex >= 0 && currentIndex < hostList.length - 1 ? `Suivant : ${hostList[currentIndex + 1].name} (→)` : 'Aucun hôte suivant'}
                  disabled={currentIndex < 0 || currentIndex >= hostList.length - 1}
                  onClick={() => goToHost(hostList[currentIndex + 1].id)}
                  className="rounded-sm p-1 text-muted hover:bg-raised hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </span>
            }
          >
            {host.roaming && <Tag>Itinérant</Tag>}
            {host.accessNetwork === 'tailscale' && <Tag>Réseau Tailscale</Tag>}
            {host.haExcluded && <Badge tone="info">Hors Home Assistant</Badge>}
          </HeaderTitle>

      <div
        ref={setStripEl}
        className={clsx('2xl:sticky 2xl:top-14 2xl:z-20 2xl:-mt-6 2xl:bg-bg 2xl:pt-6', scrolled ? 'pb-3 shadow-[0_14px_18px_-12px_rgb(0_0_0/0.7)]' : 'pb-5')}
      >
          <section className="panel">
          <dl className="flex flex-wrap lg:flex-nowrap">
            <StripItem label="Hostname"><span className={clsx('font-medium', nameTone[connectionMeta(host).tone])}>{host.info?.hostname ?? '—'}</span></StripItem>
            <StripItem label="OS">{osLabel(host) ?? '—'}</StripItem>
            <StripItem label={isWindows(host) ? 'Version' : 'Noyau'}><span className="font-mono text-xs">{host.info?.kernel ?? '—'}</span></StripItem>
            <StripItem label="Architecture">{host.info?.arch ?? '—'}</StripItem>
            {host.health?.system?.cpuCount !== undefined && <StripItem label="CPU">{Number(host.health.system.cpuCount.toFixed(1))}</StripItem>}
            {!isWindows(host) && <StripItem label="Virtualisation">{host.info?.virt ?? '—'}</StripItem>}
            <StripItem label="Uptime">{host.info ? uptime(host.info.uptime) : '—'}</StripItem>
            <StripItem label="Agent">{host.agentVersion ?? '—'}</StripItem>
            <StripItem label="Certificat">
              {host.certIssuedAt ? `émis le ${dateTime(host.certIssuedAt)}` : needsReinstall(host) ? <span className="text-red-300">ancien jeton</span> : '—'}
            </StripItem>
            <StripItem label="Vu">{host.online ? 'connecté' : timeAgo(host.lastSeenAt)}</StripItem>
            {!isWindows(host) && <StripItem label="Listes apt">{host.apt ? dateTime(host.apt.listsUpdatedAt) : '—'}</StripItem>}
            {features.standardisation && showSetup(host) && <StripItem label="Standard"><SetupStatus host={host} onOpen={() => setSetupOpen(true)} /></StripItem>}
            {(() => {
              const { lan, tailscale } = groupIps(host.info?.ips);
              return (
                <>
                  <StripItem label="IP LAN" grow><span className="font-mono text-xs">{lan.join(', ') || '—'}</span></StripItem>
                  {tailscale.length > 0 && <StripItem label="IP Tailscale"><span className="font-mono text-xs">{tailscale.join(', ')}</span></StripItem>}
                </>
              );
            })()}
            {host.tags.length > 0 && <StripItem label="Tags" plain><HostTagList host={host} /></StripItem>}
            {(canWrite || canManage) && (
              <div className="flex shrink-0 items-center gap-2 self-center px-4 py-2.5">
                {canWrite && (
                  <Button
                    icon={RefreshCw}
                    loading={refreshing}
                    disabled={!canRefreshAgent && ((!host.online && !backupsOn) || (!hasApt(host) && !host.docker && !backupsOn))}
                    title="Actualiser : relire l'état de l'agent, rechercher les mises à jour APT, vérifier les images Docker et actualiser les sauvegardes"
                    aria-label="Actualiser"
                    className="h-11! w-11! px-0! [&>svg]:h-5 [&>svg]:w-5"
                    onClick={refreshData}
                  />
                )}
                {canManage && (
                  <Button icon={Settings} title="Options" aria-label="Options" className="h-11! w-11! px-0! [&>svg]:h-5 [&>svg]:w-5" onClick={() => setEditing(true)} />
                )}
              </div>
            )}
          </dl>
        </section>
      </div>

      {/* large screens: the content on the left, history and console on the right, fixed */}
      <div style={{ '--sh': `${stripHeight}px` } as CSSProperties} className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_480px] 2xl:items-start min-[2200px]:grid-cols-[minmax(0,1fr)_640px]">
        <div className="min-w-0 @container">
          <div className={clsx('2xl:sticky 2xl:top-[calc(3.5rem+var(--sh))] 2xl:z-10 2xl:bg-bg', scrolled ? 'pb-2.5' : 'pb-4')}>
            <AlertTimeline id={host.id} />
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

          <div className="columns-1 gap-5 @xl:columns-2">
            {blocks.map((block, index) => (
              <div key={index} className="mb-5 inline-block w-full break-inside-avoid align-top">
                {block}
              </div>
            ))}
          </div>
        </div>

        {/* below the bar of the layout and the top padding of the page, up to the bottom of the window */}
        <aside className="flex min-w-0 flex-col gap-5 2xl:sticky 2xl:top-[calc(3.5rem+var(--sh))] 2xl:h-[calc(100vh-5rem-var(--sh))]">
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
                      <span className="text-xs text-muted">{timeAgo(j.createdAt)}{j.trigger === 'schedule' && ' · planifiée'}{j.trigger === 'retry' && ' · rejeu'}{j.trigger === 'homeassistant' && ' · Home Assistant'}{j.trigger === 'enroll' && " · à l'ajout"}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
          <Panel
            title="Console"
            icon={Terminal}
            className="2xl:relative 2xl:flex 2xl:min-h-0 2xl:flex-1 2xl:flex-col 2xl:transition-[width,transform] 2xl:duration-200 2xl:focus-within:z-30 2xl:focus-within:w-[800px] 2xl:focus-within:-translate-x-[320px] min-[2200px]:focus-within:w-[960px]"
            bodyClassName="p-4 2xl:flex 2xl:min-h-0 2xl:flex-1 2xl:flex-col"
          >
            {shownJob ? (
              <JobConsole jobId={shownJob} className="2xl:flex 2xl:min-h-0 2xl:flex-1 2xl:flex-col" height="h-[360px] 2xl:h-auto 2xl:min-h-0 2xl:flex-1" />
            ) : (
              <p className="text-sm text-muted">Les sorties des tâches s'affichent ici en direct.</p>
            )}
          </Panel>
        </aside>
      </div>

      {editing && (
        <HostOptionsModal
          host={host}
          onClose={() => setEditing(false)}
          danger={{
            onReboot: host.capabilities.includes('reboot') ? () => { setEditing(false); setConfirmReboot(true); } : undefined,
            onShutdown: canManage && host.capabilities.includes('shutdown') ? () => { setEditing(false); setConfirmShutdown(true); } : undefined,
            rebootDisabled: !host.online || !!running,
            onRevoke: () => { setEditing(false); setConfirmRevoke(true); },
            onDelete: () => { setEditing(false); setDeleting(true); },
          }}
        />
      )}
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
        L'hôte redémarre dans les secondes qui suivent{isWindows(host) ? '' : <> (<code className="text-zinc-100">systemctl reboot</code>)</>}. Il repasse « En ligne » dès que l'agent se reconnecte.
        {host.info?.virt === 'none' || !host.info?.virt ? null : <p className="mt-2 text-xs text-muted">Virtualisation : {host.info.virt} (seul ce conteneur ou cette VM redémarre).</p>}
      </ConfirmModal>
      <ConfirmModal
        open={confirmShutdown}
        onClose={() => setConfirmShutdown(false)}
        title={`Éteindre ${host.name}`}
        confirmLabel="Éteindre"
        danger
        loading={run.isPending}
        onConfirm={() => run.mutate({ hostId: host.id, action: 'shutdown' }, { onSuccess: (j) => { setJobId(j.id); setConfirmShutdown(false); } })}
      >
        L'hôte s'éteint dans les secondes qui suivent{isWindows(host) ? '' : <> (<code className="text-zinc-100">systemctl poweroff</code>)</>}. Il ne redémarre pas seul : il faut le rallumer sur place ou par Wake-on-LAN.
        {host.online && host.sessionSummary?.interactive && <p className="mt-2 text-xs text-amber-300">Une session est en cours d'utilisation (activité clavier/souris).</p>}
        {host.info?.virt === 'none' || !host.info?.virt ? null : <p className="mt-2 text-xs text-muted">Virtualisation : {host.info.virt} (seul ce conteneur ou cette VM s'éteint).</p>}
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
        {isHaos(host)
          ? "Pour désinstaller l'agent, supprime l'application Homelab Manager Agent dans Home Assistant."
          : isWindows(host)
            ? "Pour désinstaller l'agent, dans PowerShell en administrateur sur le poste :"
            : "Pour désinstaller l'agent, en root sur l'hôte :"}
        {isWindows(host) && (
          <pre className="mt-2 overflow-x-auto rounded-sm border border-line bg-black/40 p-2 font-mono text-xs text-zinc-300">{WINDOWS_UNINSTALL}</pre>
        )}
        {!isHaos(host) && !isWindows(host) && tls?.uninstallCommand && (
          <pre className="mt-2 overflow-x-auto rounded-sm border border-line bg-black/40 p-2 font-mono text-xs text-zinc-300">{tls.uninstallCommand}</pre>
        )}
      </ConfirmModal>
      <Modal open={!!install} onClose={() => setInstall(null)} title={`Installer l'agent sur ${host.name}`} wide>
        {install && <InstallInstructions install={install} />}
      </Modal>
    </>
  );
}
