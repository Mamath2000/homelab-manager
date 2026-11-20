import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, Container, Plus, RefreshCw, ScrollText, Search, Trash2 } from 'lucide-react';
import { api, type DockerStack, type Host, type LogHost, type LogHostDocker, type LogHubRole } from '../lib/api';
import { useMe } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { lanAddress } from '../lib/roles';
import { keys, useHosts, useLogServers, useSites } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Button, Checkbox, ConfirmModal, Empty, IconGroup, Modal, Panel, Spinner, StatusDot } from './ui';
import type { Tone } from '../lib/status';
import type { IconAction } from './ui';

// Rôles › Logs: the hosts that send their journals to each log server, one card per host, green while journals
// arrive. Adding a host installs and configures rsyslog on it (option « Envoi des journaux » of the standardisation,
// applied at once); the bin stops it (the agent removes its file). A host with Docker stacks also sends the journals of
// its containers from its card (homelab#347): always to the server of the host, stopped with them.

// silent is a warning (nothing came for a while), not a failure: the configuration is in place
const STATE: Record<LogHost['state'], { tone: Tone; card: string; text: string }> = {
  ok: { tone: 'ok', card: 'border-emerald-500/50', text: 'text-zinc-400' },
  silent: { tone: 'warn', card: 'border-amber-500/40 bg-amber-500/5', text: 'text-amber-300' },
  error: { tone: 'bad', card: 'border-red-500/40 bg-red-500/5', text: 'text-red-300' },
  pending: { tone: 'warn', card: 'border-amber-500/40 bg-amber-500/5', text: 'text-amber-300' },
  drift: { tone: 'warn', card: 'border-amber-500/40 bg-amber-500/5', text: 'text-amber-300' },
};

// the last message received (the server is read over 7 days)
const lastText = (lastAt: number | null) => (lastAt ? `dernier message ${timeAgo(lastAt)}` : 'aucun message reçu (7 j)');
// beyond this, a host (or its containers) that sent nothing gets a warning
const silentText = (silentHours: number) => `rien depuis plus de ${silentHours || 24} h`;

function stateText(h: LogHost) {
  switch (h.state) {
    case 'pending':
      return 'mise en place en cours…';
    case 'drift':
      return h.detail ?? 'configuration à appliquer';
    case 'error':
      return h.detail ?? "l'agent ne peut pas l'appliquer";
    default:
      return lastText(h.lastAt);
  }
}

function dockerText(d: LogHostDocker) {
  switch (d.state) {
    case 'unavailable':
      return d.detail ?? 'indisponible';
    case 'off':
      return 'désactivés';
    case 'pending':
      return 'mise en place en cours…';
    case 'drift':
    case 'error':
      return d.detail ?? 'à réappliquer';
    default:
      return lastText(d.lastAt);
  }
}

const DOCKER_ICON: Record<LogHostDocker['state'], string> = { unavailable: 'text-zinc-600', off: 'text-zinc-500', pending: 'text-amber-400', ok: 'text-emerald-400', drift: 'text-amber-400', error: 'text-red-400', silent: 'text-amber-400' };

// Docker crossed out: the journals of the containers are not sent
function DockerOffIcon({ className }: { className?: string }) {
  return (
    <span className="relative inline-flex">
      <Container className={className} />
      <span aria-hidden className="absolute left-1/2 top-1/2 h-[1.5px] w-5 -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded bg-current" />
    </span>
  );
}

// The journals of the containers of the host, as an action of the icons next to the bin: crossed out = not sent, green =
// in place and received, orange = set up but nothing received (or to set up again), red = error. The click acts: set up /
// set up again when off or incomplete (drift / error), stop when in place. A silence alone is not a reason to set up again.
function dockerAction(h: LogHost, silentHours: number, onEnable: () => void, onDisable: () => void): IconAction {
  const d = h.docker!;
  const off = !d.enabled;
  const redo = d.enabled && (d.state === 'error' || d.state === 'drift');
  const why = !h.online ? 'hôte hors ligne' : h.running ? 'une tâche est en cours' : null;
  const action = d.state === 'unavailable' || d.state === 'pending' ? null : off ? "Cliquer pour envoyer aussi les journaux des conteneurs (redémarre Docker sur l'hôte)" : redo ? 'Cliquer pour refaire la mise en place' : "Cliquer pour arrêter l'envoi des journaux des conteneurs";
  const title = [`Conteneurs : ${dockerText(d)}`, d.state === 'silent' ? silentText(silentHours) : null, d.state === 'drift' || d.state === 'error' ? d.detail : null, why, action].filter(Boolean).join(' — ');
  return {
    icon: off ? DockerOffIcon : Container,
    title,
    iconClass: DOCKER_ICON[d.state],
    disabled: !!why || !action,
    onClick: off || redo ? onEnable : onDisable,
  };
}

// why a stack cannot be recreated with the setting up (null: it can)
function cannotRecreate(st: DockerStack, canRecreate: boolean) {
  if (!st.managed) return 'non managée';
  if (st.status === 'down' || st.status === 'stopped') return 'arrêtée';
  if (st.logs === 'followed') return 'déjà suivie';
  if (!canRecreate) return "agent à mettre à jour pour la recréer d'ici";
  return null;
}

// Setting up (or again) of the collector of the journals of the containers: Docker restarts when daemon.json changes, then
// the stacks ticked are created again so that their containers send.
function DockerLogsModal({ h, host, role, onClose }: { h: LogHost; host: Host | undefined; role: LogHubRole; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const stacks = host?.docker?.stacks ?? [];
  const canRecreate = !!host?.capabilities.includes('docker_recreate');
  const offered = stacks.map((st) => ({ st, why: cannotRecreate(st, canRecreate) }));
  const [picked, setPicked] = useState<Set<string>>(() => new Set(offered.filter((x) => !x.why && x.st.logs !== 'ignored').map((x) => x.st.name)));
  const [busy, setBusy] = useState(false);
  const state = host?.docker?.logs.state;
  // daemon.json in place: only the collector is set again
  const restart = !state || state.daemon !== 'ok';
  const toggle = (name: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(name);
    else next.delete(name);
    setPicked(next);
  };
  const confirm = async () => {
    setBusy(true);
    try {
      await api.setDockerLogs(h.hostId, true, offered.filter((x) => !x.why && picked.has(x.st.name)).map((x) => x.st.name),
        // unticked: left out on purpose, no longer « to recreate » (a stack already followed has nothing to leave out)
        offered.filter((x) => !x.why && !picked.has(x.st.name) && x.st.logs !== 'followed').map((x) => x.st.name),
      );
      await Promise.all([qc.invalidateQueries({ queryKey: ['settings', 'logs', role.id] }), qc.invalidateQueries({ queryKey: keys.hosts })]);
      toast.success(`${h.name} : journaux des conteneurs en cours de mise en place`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmModal open onClose={onClose} onConfirm={() => void confirm()} title={`Journaux des conteneurs · ${h.name}`} confirmLabel={h.docker?.enabled ? 'Réappliquer' : 'Activer'} danger loading={busy}>
      <div className="space-y-3">
        {restart ? (
          <p>
            <b>Docker va redémarrer sur {h.name}</b> : tous ses conteneurs sont arrêtés puis relancés, y compris ceux des stacks non managées et
            ceux créés hors compose.
          </p>
        ) : (
          <p>Docker ne redémarre pas : seul le collecteur est remis en place.</p>
        )}
        <p className="text-xs text-muted">
          Les journaux des conteneurs partent vers <span className="font-mono">{role.target || role.name}</span>, le serveur de l'hôte. Un collecteur
          Fluent Bit (stack <span className="font-mono">homelab-log-collector</span>) les lit sur l'hôte.
        </p>
        {offered.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs text-zinc-300">Stacks à recréer ensuite, pour que leurs conteneurs envoient :</p>
            <ul className="max-h-[40vh] space-y-1 overflow-y-auto">
              {offered.map(({ st, why }) => (
                <li key={st.name}>
                  <label className={clsx('flex items-center gap-3 rounded-md border px-3 py-1.5', why ? 'border-line opacity-50' : 'cursor-pointer border-line hover:bg-raised/40')}>
                    {why ? <span className="h-4 w-4 shrink-0" /> : <Checkbox checked={picked.has(st.name)} onChange={(on) => toggle(st.name, on)} label={st.name} />}
                    <span className="min-w-0 truncate font-medium text-zinc-100">{st.name}</span>
                    {why && <span className="ml-auto shrink-0 text-xs text-muted">{why}</span>}
                  </label>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted">Une stack décochée est marquée « non suivie » : elle n'est plus signalée « à recréer » (rien ne change sur l'hôte, elle n'envoie rien jusqu'à sa recréation).</p>
          </div>
        )}
      </div>
    </ConfirmModal>
  );
}

function HostCard({ h, site, silentHours, onRemove, onApply, applying, onDockerEnable, onDockerDisable }: { h: LogHost; site?: string; silentHours: number; onRemove: () => void; onApply: () => void; applying: boolean; onDockerEnable: () => void; onDockerDisable: () => void }) {
  const meta = STATE[h.state];
  // the rsyslog setting is not (or no longer) the expected one on the host: applying it again fixes it. Not for a silence:
  // the setting is in place, applying it again would change nothing.
  const reapply = h.online && !h.running && (h.state === 'drift' || h.state === 'error');
  return (
    <article className={clsx('min-w-0 rounded-lg border p-3.5', meta.card)}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={meta.tone} pulse={h.state === 'pending'} />
          <Link to={`/hosts/${h.hostId}`} className="truncate font-medium text-zinc-100 hover:underline" title={h.name}>{h.name}</Link>
        </div>
        <div className="flex shrink-0 items-center">
          <IconGroup
            actions={[
              ...(h.docker ? [dockerAction(h, silentHours, onDockerEnable, onDockerDisable)] : []),
              { icon: Trash2, title: 'Ne plus gérer les journaux de cet hôte', disabled: h.running, danger: true, onClick: onRemove },
            ]}
          />
        </div>
      </div>
      <p className={clsx('mt-1.5 line-clamp-2 text-xs', meta.text)} title={h.lastAt ? new Date(h.lastAt).toLocaleString('fr-FR') : (h.detail ?? undefined)}>
        {stateText(h)}
      </p>
      {h.state === 'silent' && (
        <p className="mt-1 inline-flex items-center gap-1 text-xs text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5" />
          {silentText(silentHours)}
        </p>
      )}
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="truncate text-[11px] text-muted">{[site, !h.online && 'hors ligne'].filter(Boolean).join(' · ')}</p>
        {reapply && (
          <Button size="sm" icon={RefreshCw} loading={applying} onClick={onApply} title="Réappliquer la configuration rsyslog sur l'hôte" className="shrink-0">
            Réappliquer
          </Button>
        )}
      </div>
    </article>
  );
}

// why the journals of a host cannot be sent from here (null: they can), as the hub checks it (routes/logs.ts cannotSend)
function cannotSend(h: Host, standardisation: boolean) {
  if (!standardisation) return 'standardisation désactivée sur le hub';
  if (!h.capabilities.includes('setup')) return 'pas de standardisation (Debian / Ubuntu seulement)';
  if (!h.capabilities.includes('log_forward')) return 'agent à mettre à jour';
  if (!h.online) return 'hors ligne';
  return null;
}

// The hosts that do not send yet, several chosen at once: rsyslog is installed and configured on each of them (one job per
// host, the hosts listed being the preview of the targets).
function AddHostModal({ role, listed, onClose }: { role: LogHubRole; listed: LogHost[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { features } = useMe();
  const { data: hosts = [] } = useHosts();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const sending = new Set(listed.map((h) => h.hostId));
  const all = hosts
    .filter((h) => !sending.has(h.id))
    .map((h) => ({ h, why: cannotSend(h, features.standardisation) }))
    .sort((a, b) => Number(!!a.why) - Number(!!b.why) || a.h.name.localeCompare(b.h.name, 'fr'));
  const list = all.filter(({ h }) => !q || h.name.toLowerCase().includes(q.toLowerCase()));
  const selectable = list.filter((x) => !x.why).map((x) => x.h.id);
  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  const allPicked = selectable.length > 0 && selectable.every((id) => picked.has(id));
  const add = async () => {
    setBusy(true);
    const targets = all.filter(({ h }) => picked.has(h.id)).map(({ h }) => h);
    const failed: string[] = [];
    for (const h of targets) {
      try {
        await api.addLogHost(role.id, h.id);
      } catch (err) {
        failed.push(`${h.name} : ${(err as Error).message}`);
      }
    }
    await qc.invalidateQueries({ queryKey: ['settings', 'logs', role.id] });
    const started = targets.length - failed.length;
    if (started) toast.success(`Envoi des journaux en cours d'installation sur ${started} hôte${started > 1 ? 's' : ''}`);
    for (const f of failed) toast.error(f);
    setBusy(false);
    if (!failed.length) onClose();
    else setPicked(new Set(targets.filter((h) => failed.some((f) => f.startsWith(`${h.name} :`))).map((h) => h.id)));
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Ajouter des hôtes · ${role.name}`}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Annuler</Button>
          <Button variant="primary" icon={Plus} loading={busy} disabled={!picked.size} onClick={() => void add()}>
            {picked.size ? `Ajouter ${picked.size} hôte${picked.size > 1 ? 's' : ''}` : 'Ajouter'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted">Les hôtes cochés reçoivent rsyslog, réglé pour envoyer leurs journaux vers <span className="font-mono">{role.target || role.name}</span>.</p>
        <div className="flex items-center gap-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input className="input pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un hôte" autoFocus />
          </div>
          {selectable.length > 1 && (
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-zinc-300">
              <Checkbox checked={allPicked} indeterminate={selectable.some((id) => picked.has(id))} onChange={(on) => setPicked(on ? new Set([...picked, ...selectable]) : new Set([...picked].filter((id) => !selectable.includes(id))))} label="Tout cocher" />
              Tout cocher
            </label>
          )}
        </div>
        {!list.length ? (
          <p className="py-4 text-center text-xs text-muted">Aucun autre hôte.</p>
        ) : (
          <ul className="max-h-[55vh] space-y-1.5 overflow-y-auto">
            {list.map(({ h, why }) => (
              <li key={h.id}>
                <label className={clsx('flex items-center gap-3 rounded-md border px-3 py-2 transition', why ? 'border-line opacity-50' : 'cursor-pointer hover:bg-raised/40', picked.has(h.id) ? 'border-emerald-500/60 bg-emerald-500/5' : 'border-line')}>
                  {why ? <span className="h-4 w-4 shrink-0" /> : <Checkbox checked={picked.has(h.id)} onChange={(on) => toggle(h.id, on)} label={h.name} />}
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-zinc-100">{h.name}</span>
                    <span className="block text-xs text-muted">
                      {why ?? (lanAddress(h.info?.ips) || 'adresse inconnue')}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// Stops the journals of the containers of a host (collector removed, Docker not restarted); or sets them up again instead.
function DockerDisableModal({ h, role, onClose, onReapply }: { h: LogHost; role: LogHubRole; onClose: () => void; onReapply: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const disable = async () => {
    setBusy(true);
    try {
      await api.setDockerLogs(h.hostId, false);
      await Promise.all([qc.invalidateQueries({ queryKey: ['settings', 'logs', role.id] }), qc.invalidateQueries({ queryKey: keys.hosts })]);
      toast.success(`${h.name} : envoi des journaux des conteneurs arrêté`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmModal
      open
      onClose={onClose}
      onConfirm={() => void disable()}
      title="Arrêter l'envoi des journaux des conteneurs"
      confirmLabel="Arrêter"
      danger
      loading={busy}
      extra={
        <Button icon={RefreshCw} disabled={busy} title="Refaire la mise en place du collecteur (sans redémarrer Docker)" onClick={onReapply}>
          Réappliquer
        </Button>
      }
    >
      <b>{h.name}</b> n'enverra plus les journaux de ses conteneurs : le collecteur est supprimé et les labels retirés de{' '}
      <code>/etc/docker/daemon.json</code>, sans redémarrer Docker. Les conteneurs restent en <code>json-file</code> : <code>docker logs</code> fonctionne
      toujours. Ce que le serveur a déjà reçu est gardé.
    </ConfirmModal>
  );
}

function HostDockerLogsOf({ role, host }: { role: LogHubRole; host: Host }) {
  const { data } = useQuery({ queryKey: ['settings', 'logs', role.id], queryFn: () => api.logHosts(role.id), refetchInterval: 30_000 });
  const [on, setOn] = useState(false);
  const [off, setOff] = useState(false);
  const h = data?.hosts.find((x) => x.hostId === host.id);
  if (!h?.docker) return null;
  return (
    <>
      <IconGroup actions={[dockerAction(h, data!.silentHours, () => setOn(true), () => setOff(true))]} />
      {on && <DockerLogsModal h={h} host={host} role={role} onClose={() => setOn(false)} />}
      {off && <DockerDisableModal h={h} role={role} onClose={() => setOff(false)} onReapply={() => { setOff(false); setOn(true); }} />}
    </>
  );
}

// The same icon and actions on the page of a host (card Docker). Nothing when the host is not in the list of a log
// server (it does not send its journals): the ones of its containers go with them.
export function HostDockerLogs({ host }: { host: Host }) {
  const { data: servers = [] } = useLogServers();
  return <>{servers.map((r) => <HostDockerLogsOf key={r.id} role={r} host={host} />)}</>;
}

function ServerPanel({ role }: { role: LogHubRole }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: sites = [] } = useSites();
  const { data: allHosts = [] } = useHosts();
  // a host being installed is followed closely, the others are read again every half minute
  const { data, isLoading, error } = useQuery({
    queryKey: ['settings', 'logs', role.id],
    queryFn: () => api.logHosts(role.id),
    refetchInterval: (q) => (q.state.data?.hosts.some((h) => h.state === 'pending' || h.running || h.docker?.state === 'pending') ? 5_000 : 30_000),
  });
  const [dockerOn, setDockerOn] = useState<LogHost | null>(null);
  const [dockerOff, setDockerOff] = useState<LogHost | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<LogHost | null>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const apply = async (h: LogHost) => {
    setApplying(h.hostId);
    try {
      await api.addLogHost(role.id, h.hostId);
      await qc.invalidateQueries({ queryKey: ['settings', 'logs', role.id] });
      toast.success(`${h.name} : configuration rsyslog réappliquée`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setApplying(null);
    }
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      const r = await api.removeLogHost(role.id, removing.hostId);
      await qc.invalidateQueries({ queryKey: ['settings', 'logs', role.id] });
      toast.success(r.applied ? `${removing.name} : envoi des journaux arrêté` : `${removing.name} : hors ligne, l'envoi sera arrêté à la prochaine application de sa standardisation`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRemoving(null);
      setBusy(false);
    }
  };
  const list = data?.hosts ?? [];
  const warned = list.filter((h) => h.state === 'silent').length;
  return (
    <Panel
      title={role.name}
      icon={ScrollText}
      actions={<Button size="sm" icon={Plus} onClick={() => setAdding(true)} disabled={!data}>Ajouter des hôtes</Button>}
    >
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted">
          Destination des hôtes : <span className="font-mono text-zinc-300">{role.target || 'inconnue'}</span>
          {data && list.length > 0 && <> · {list.length} hôte{list.length > 1 ? 's' : ''} géré{list.length > 1 ? 's' : ''}{warned ? ` · ${warned} sans message depuis plus de ${data.silentHours || 24} h` : ''}</>}
        </p>
        {data?.error && <p className="text-xs text-amber-300">Serveur de logs illisible ({data.error}) : les états sont inconnus.</p>}
        {isLoading ? (
          <div className="flex justify-center p-6"><Spinner /></div>
        ) : error ? (
          <p className="text-red-400">{(error as Error).message}</p>
        ) : !list.length ? (
          <Empty icon={ScrollText} title="Aucun hôte géré">« Ajouter des hôtes » installe rsyslog sur les hôtes choisis et le règle pour envoyer ses journaux à ce serveur.</Empty>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {list.map((h) => (
              <HostCard key={h.hostId} h={h} site={sites.find((s) => s.id === h.siteId)?.name} silentHours={data!.silentHours} onRemove={() => setRemoving(h)} onApply={() => void apply(h)} applying={applying === h.hostId} onDockerEnable={() => setDockerOn(h)} onDockerDisable={() => setDockerOff(h)} />
            ))}
          </div>
        )}
      </div>
      {adding && data && <AddHostModal role={role} listed={list} onClose={() => setAdding(false)} />}
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => void remove()} title="Arrêter l'envoi des journaux" confirmLabel="Arrêter" danger loading={busy}>
        <b>{removing?.name}</b> n'enverra plus ses journaux : l'agent retire <code>/etc/rsyslog.d/90-homelab.conf</code> et redémarre rsyslog (le paquet reste
        installé). Ce que le serveur a déjà reçu est gardé.
        {removing?.mode === 'standard' && <> L'hôte garde une valeur propre « aucun envoi » dans sa standardisation.</>}
        {removing?.docker?.enabled && <> Les journaux de ses conteneurs ne sont plus envoyés non plus : le collecteur est supprimé, sans redémarrer Docker.</>}
      </ConfirmModal>
      {dockerOn && <DockerLogsModal h={dockerOn} host={allHosts.find((x) => x.id === dockerOn.hostId)} role={role} onClose={() => setDockerOn(null)} />}
      {dockerOff && <DockerDisableModal h={dockerOff} role={role} onClose={() => setDockerOff(null)} onReapply={() => { setDockerOn(dockerOff); setDockerOff(null); }} />}
    </Panel>
  );
}

// roleId: only that server (the role the window is opened from), else all of them
export function LogHostsSettings({ roleId }: { roleId?: string }) {
  const { data: servers = [], isLoading } = useLogServers();
  if (isLoading) return <div className="flex justify-center p-10"><Spinner /></div>;
  return (
    <div className="space-y-4">
      {servers.filter((r) => !roleId || r.id === roleId).map((r) => <ServerPanel key={r.id} role={r} />)}
    </div>
  );
}
