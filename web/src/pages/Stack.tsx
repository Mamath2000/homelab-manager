import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpCircle, Boxes, Container, Eye, EyeOff, FileCode, History, RefreshCw, ScrollText, ShieldAlert, Trash2 } from 'lucide-react';
import { CheckImagesButton, ImageUpdateBadge, StackActions, StackStatusBadge } from '../components/Docker';
import { JobConsole, JobStatusIcon } from '../components/JobConsole';
import { Badge, Button, Checkbox, ConfirmModal, Empty, PageHeader, Panel, Spinner, Tabs, Tag } from '../components/ui';
import { api, type DockerStack, type Host } from '../lib/api';
import { useMe } from '../lib/auth';
import { jobTitle, timeAgo } from '../lib/format';
import { useHost, useHostJobs } from '../lib/queries';
import { imageUpdateMeta } from '../lib/status';
import { useToast } from '../lib/toast';

type Tab = 'services' | 'logs' | 'compose' | 'history';

const stateTone = (state: string, health?: string) =>
  health === 'unhealthy' || state === 'restarting' || state === 'dead' ? 'bad' : state === 'running' ? 'ok' : state === 'paused' ? 'warn' : 'neutral';

const short = (d: string | null) => (d ? d.replace('sha256:', '').slice(0, 12) : '—');

function ServiceName({ service }: { service: DockerStack['services'][number] }) {
  return (
    <>
      {service.name}
      {service.external && (
        <span className="ml-2" title="Conteneur créé par un autre conteneur de la stack, hors du fichier compose : logs seulement, aucune action">
          <Badge tone="neutral">hors compose</Badge>
        </span>
      )}
    </>
  );
}

function ServicesTab({ host, stack, running, onStarted }: { host: Host; stack: DockerStack; running: boolean; onStarted: (id: string) => void }) {
  if (!stack.managed) {
    return (
      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line">
            <tr>
              <th className="th">Service</th>
              <th className="th">Image</th>
              <th className="th">Mise à jour</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {stack.services.map((s) => (
              <tr key={s.name} className="align-top hover:bg-raised/40">
                <td className="td font-medium text-zinc-100"><ServiceName service={s} /></td>
                <td className="td">
                  <span className="font-mono text-xs text-zinc-300">{s.image || '—'}</span>
                  {s.update === 'available' && (
                    <p className="mt-0.5 font-mono text-[11px] text-muted">
                      {short(s.localDigest)} → <span className="text-amber-300">{short(s.remoteDigest)}</span>
                    </p>
                  )}
                </td>
                <td className="td">
                  <ImageUpdateBadge update={s.update} />
                  {s.checkError && s.update === 'unknown' && <p className="mt-0.5 text-[11px] text-muted">{s.checkError}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full min-w-[820px] text-sm">
        <thead className="border-b border-line">
          <tr>
            <th className="th">Service</th>
            <th className="th">Image</th>
            <th className="th">Conteneurs</th>
            <th className="th">Mise à jour</th>
            <th className="th text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {stack.services.map((s) => (
            <tr key={s.name} className="align-top hover:bg-raised/40">
              <td className="td font-medium text-zinc-100"><ServiceName service={s} /></td>
              <td className="td">
                <span className="font-mono text-xs text-zinc-300">{s.image || '—'}</span>
                {s.update === 'available' && (
                  <p className="mt-0.5 font-mono text-[11px] text-muted">
                    {short(s.localDigest)} → <span className="text-amber-300">{short(s.remoteDigest)}</span>
                  </p>
                )}
              </td>
              <td className="td">
                {s.containers.length === 0 ? (
                  <span className="text-xs text-muted">aucun</span>
                ) : (
                  <ul className="space-y-1">
                    {s.containers.map((c) => (
                      <li key={c.id} className="flex flex-wrap items-center gap-2">
                        <Badge tone={stateTone(c.state, c.health)}>{c.health ? `${c.state} · ${c.health}` : c.state}</Badge>
                        <span className="text-xs text-zinc-400">{c.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </td>
              <td className="td">
                <ImageUpdateBadge update={s.update} />
                {s.checkError && s.update === 'unknown' && <p className="mt-0.5 text-[11px] text-muted">{s.checkError}</p>}
              </td>
              <td className="td">
                <div className="flex justify-end">
                  {stack.status !== 'down' && !s.external && <StackActions host={host} stack={stack} service={s.name} disabled={running} compact onStarted={onStarted} />}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LogsTab({ host, stack }: { host: Host; stack: DockerStack }) {
  const [service, setService] = useState('');
  const [tail, setTail] = useState(200);
  const [follow, setFollow] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const q = useQuery({
    queryKey: ['stack-logs', host.id, stack.name, service, tail],
    queryFn: () => api.stackLogs(host.id, stack.name, service || undefined, tail),
    enabled: host.online,
    refetchInterval: follow ? 5000 : false,
    retry: false,
  });
  // newest lines at the bottom: keep them in view
  useEffect(() => {
    const el = pre.current;
    if (el) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
  }, [q.dataUpdatedAt]);

  return (
    <Panel
      title="Logs"
      icon={ScrollText}
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <select className="input h-8 w-auto py-0 text-xs" value={service} onChange={(e) => setService(e.target.value)}>
            <option value="">Tous les services</option>
            {stack.services.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
          <select className="input h-8 w-auto py-0 text-xs" value={tail} onChange={(e) => setTail(Number(e.target.value))}>
            {[100, 200, 500, 1000, 2000].map((n) => <option key={n} value={n}>{n} lignes</option>)}
          </select>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
            <Checkbox checked={follow} onChange={setFollow} label="Suivre" />
            Suivre (5 s)
          </label>
          <Button size="sm" icon={RefreshCw} loading={q.isFetching} onClick={() => q.refetch()}>Rafraîchir</Button>
        </div>
      }
    >
      {!host.online ? (
        <p className="text-sm text-muted">Hôte hors ligne.</p>
      ) : q.isError ? (
        <p className="text-sm text-red-400">{(q.error as Error).message}</p>
      ) : (
        <pre ref={pre} className="h-[520px] overflow-auto rounded-md border border-line bg-black/60 p-3 font-mono text-xs leading-relaxed text-zinc-300">
          {q.isLoading ? 'Chargement…' : q.data?.logs || 'Aucune ligne.'}
        </pre>
      )}
    </Panel>
  );
}

function ComposeTab({ host, stack }: { host: Host; stack: DockerStack }) {
  const q = useQuery({
    queryKey: ['stack-compose', host.id, stack.name],
    queryFn: () => api.stackCompose(host.id, stack.name),
    enabled: host.online,
    retry: false,
  });
  if (!host.online) return <p className="text-sm text-muted">Hôte hors ligne.</p>;
  if (q.isLoading) return <div className="flex justify-center p-10"><Spinner /></div>;
  if (q.isError) return <p className="text-sm text-red-400">{(q.error as Error).message}</p>;
  return (
    <div className="space-y-5">
      <p className="text-xs text-muted">
        Lecture seule : l'hôte reste la source de vérité. Les valeurs des fichiers d'environnement sont masquées.
      </p>
      {q.data?.files.map((f) => (
        <Panel
          key={f.path}
          title={f.path}
          icon={FileCode}
          actions={f.masked ? <Badge tone="neutral">valeurs masquées</Badge> : undefined}
        >
          <pre className="max-h-[600px] overflow-auto rounded-md border border-line bg-black/60 p-3 font-mono text-xs leading-relaxed text-zinc-300">
            {f.content}
          </pre>
        </Panel>
      ))}
    </div>
  );
}

function HistoryTab({ host, stack, jobId, setJobId }: { host: Host; stack: DockerStack; jobId: string | null; setJobId: (id: string) => void }) {
  const { data: jobs } = useHostJobs(host.id);
  const list = (jobs ?? []).filter((j) => j.stack === stack.name || j.action === 'docker_check');
  const shown = jobId ?? list[0]?.id ?? null;
  return (
    <div className="grid gap-5 xl:grid-cols-[340px_1fr]">
      <Panel title="Historique" icon={History} bodyClassName="max-h-[460px] overflow-auto">
        {!list.length ? (
          <p className="p-4 text-sm text-muted">Aucune tâche.</p>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((j) => (
              <li key={j.id}>
                <button
                  onClick={() => setJobId(j.id)}
                  className={clsx('flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition hover:bg-raised/50', shown === j.id && 'bg-raised')}
                >
                  <JobStatusIcon status={j.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-zinc-200">{jobTitle(j)}</span>
                    <span className="text-xs text-muted">
                      {timeAgo(j.createdAt)}
                      {j.trigger === 'schedule' && ' · planifiée'}
                      {j.trigger === 'homeassistant' && ' · Home Assistant'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Console" icon={ScrollText}>
        {shown ? <JobConsole jobId={shown} height="h-[400px]" /> : <p className="text-sm text-muted">Les sorties des tâches s'affichent ici en direct.</p>}
      </Panel>
    </div>
  );
}

export function Stack() {
  const { hostId, stack: name } = useParams();
  const { data: host, isLoading } = useHost(hostId);
  const { data: jobs } = useHostJobs(hostId ?? '');
  const { canWrite, canManage } = useMe();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [jobId, setJobId] = useState<string | null>(null);
  const [forget, setForget] = useState(false);
  const [unmanage, setUnmanage] = useState(false);
  const tab = (params.get('tab') as Tab) || 'services';
  const stack = host?.docker?.stacks.find((s) => s.name === name);
  const running = useMemo(() => !!jobs?.some((j) => j.status === 'running'), [jobs]);

  if (isLoading) return <div className="flex justify-center p-20"><Spinner /></div>;
  if (!host || !stack) {
    return (
      <Empty icon={Container} title="Stack introuvable">
        <Link className="text-emerald-400" to="/docker">Retour à Docker</Link>
      </Empty>
    );
  }

  const setTab = (t: Tab) => setParams(t === 'services' ? {} : { tab: t }, { replace: true });
  // a job started from this page: show it live
  const started = (id: string) => {
    setJobId(id);
    setTab('history');
  };
  const tabs: { id: Tab; label: string; icon: typeof Boxes }[] = [
    { id: 'services', label: 'Services', icon: Boxes },
    ...(canWrite
      ? [
          { id: 'logs' as const, label: 'Logs', icon: ScrollText },
          { id: 'compose' as const, label: 'Compose', icon: FileCode },
        ]
      : []),
    { id: 'history', label: 'Historique', icon: History },
  ];
  const pending = stack.services.filter((s) => s.update === 'available' || s.update === 'recreate');
  const setManaged = async (managed: boolean) => {
    try {
      await api.setStackManaged(host.id, stack.name, managed);
      toast.success(managed ? `${stack.name} est de nouveau gérée` : `${stack.name} n'est plus gérée`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <>
      <Link to="/docker" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-zinc-200">
        <ArrowLeft className="h-4 w-4" /> Docker
      </Link>
      <PageHeader
        icon={Container}
        title={stack.name}
        actions={
          <>
            <StackActions host={host} stack={stack} disabled={running} onStarted={started} />
            <CheckImagesButton host={host} disabled={running} onStarted={started} />
            {canManage &&
              (stack.managed ? (
                <Button size="sm" variant="ghost" icon={EyeOff} title="Stack gérée par ailleurs : lecture seule, sans état ni mise à jour" onClick={() => setUnmanage(true)}>
                  Ne plus gérer
                </Button>
              ) : (
                <Button size="sm" icon={Eye} onClick={() => setManaged(true)}>
                  Gérer
                </Button>
              ))}
            {canManage && stack.status === 'down' && (
              <Button size="sm" variant="ghost" icon={Trash2} className="hover:text-red-400" onClick={() => setForget(true)}>
                Oublier
              </Button>
            )}
          </>
        }
      >
        <StackStatusBadge stack={stack} />
        <ImageUpdateBadge update={stack.update} count={stack.updates} />
        <Link to={`/hosts/${host.id}`}><Tag>{host.name}</Tag></Link>
        {!host.online && <Badge tone="bad">hôte hors ligne</Badge>}
      </PageHeader>

      {!stack.managed && (
        <div className="panel mb-5 flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
          <EyeOff className="h-5 w-5 text-muted" />
          <span className="text-zinc-300">
            Stack non managée : elle est gérée en dehors de Homelab Manager (son propre système de mise à jour…). Lecture seule : les mises à
            jour d'image sont affichées pour information, sans état ni action, et elle n'est pas publiée dans Home Assistant.
          </span>
        </div>
      )}
      {stack.problems.length > 0 && (
        <div className="panel mb-5 flex flex-wrap items-center gap-3 border-red-500/50 bg-red-500/10 px-4 py-3 text-sm">
          <ShieldAlert className="h-5 w-5 text-red-400" />
          <span className="text-red-100">{stack.problems.join(' · ')}</span>
        </div>
      )}
      {pending.length > 0 && (
        <div className="panel mb-5 flex flex-wrap items-center gap-3 border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
          <ArrowUpCircle className="h-5 w-5 text-amber-400" />
          <span className="text-zinc-200">
            {pending.length} service(s) à mettre à jour{!stack.managed && ' (par son propre système)'} :{' '}
            {pending.map((s) => `${s.name} (${imageUpdateMeta[s.update].label.toLowerCase()})`).join(', ')}
          </span>
        </div>
      )}

      <p className="mb-4 text-xs text-muted">
        <span className="font-mono">{stack.workingDir}</span>
        {' · '}
        {stack.configFiles.map((f) => f.replace(`${stack.workingDir}/`, '')).join(', ')}
        {' · '}images vérifiées {host.docker?.updatesCheckedAt ? timeAgo(host.docker.updatesCheckedAt) : 'jamais'}
      </p>

      <Tabs tabs={tabs} value={tabs.some((t) => t.id === tab) ? tab : 'services'} onChange={setTab} />
      {tab === 'logs' && canWrite ? (
        <LogsTab host={host} stack={stack} />
      ) : tab === 'compose' && canWrite ? (
        <ComposeTab host={host} stack={stack} />
      ) : tab === 'history' ? (
        <HistoryTab host={host} stack={stack} jobId={jobId} setJobId={setJobId} />
      ) : (
        <ServicesTab host={host} stack={stack} running={running} onStarted={started} />
      )}

      <ConfirmModal
        open={forget}
        onClose={() => setForget(false)}
        title={`Oublier ${stack.name}`}
        confirmLabel="Oublier"
        danger
        onConfirm={async () => {
          try {
            await api.forgetStack(host.id, stack.name);
            toast.success(`${stack.name} n'est plus suivie`);
            navigate('/docker');
          } catch (err) {
            toast.error((err as Error).message);
          }
        }}
      >
        La stack n'a plus de conteneur : elle cesse d'être suivie. Ses fichiers sur l'hôte ne sont pas touchés ; elle réapparaîtra si elle est relancée.
      </ConfirmModal>
      <ConfirmModal
        open={unmanage}
        onClose={() => setUnmanage(false)}
        title={`Ne plus gérer ${stack.name}`}
        confirmLabel="Ne plus gérer"
        onConfirm={async () => {
          await setManaged(false);
          setUnmanage(false);
        }}
      >
        Pour une stack qui a son propre système de mise à jour. Elle reste listée en lecture seule (services, mises à jour d'image pour
        information, logs, compose) mais n'a plus d'état, de problème ni d'action, et disparaît de Home Assistant. Réversible avec « Gérer ».
      </ConfirmModal>
    </>
  );
}
