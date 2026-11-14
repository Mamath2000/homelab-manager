import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Plus, RefreshCw, ScrollText, Search, Trash2 } from 'lucide-react';
import { api, type Host, type LogHost, type LogHubRole } from '../lib/api';
import { useMe } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { lanAddress } from '../lib/roles';
import { useHosts, useLogServers, useSites } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Button, Checkbox, ConfirmModal, Empty, Modal, Panel, Spinner, StatusDot } from './ui';
import type { Tone } from '../lib/status';

// Paramètres › Logs: the hosts that send their journals to each log server, one card per host, green while journals
// arrive. Adding a host installs and configures rsyslog on it (option « Envoi des journaux » of the standardisation,
// applied at once); the bin stops it (the agent removes its file).

const STATE: Record<LogHost['state'], { tone: Tone; card: string }> = {
  ok: { tone: 'ok', card: 'border-emerald-500/40 bg-emerald-500/5' },
  silent: { tone: 'bad', card: 'border-red-500/40 bg-red-500/5' },
  error: { tone: 'bad', card: 'border-red-500/40 bg-red-500/5' },
  pending: { tone: 'warn', card: 'border-amber-500/40 bg-amber-500/5' },
  drift: { tone: 'warn', card: 'border-amber-500/40 bg-amber-500/5' },
};

const MODE_LABEL: Record<LogHost['mode'], string> = { standard: 'standard', custom: 'valeur propre', manual: 'réglé à la main' };

function stateText(h: LogHost, silentHours: number) {
  switch (h.state) {
    case 'ok':
      return `reçu ${timeAgo(h.lastAt)}`;
    case 'pending':
      return 'installation en cours…';
    case 'drift':
      return h.detail ?? 'configuration à appliquer';
    case 'error':
      return h.detail ?? "l'agent ne peut pas l'appliquer";
    case 'silent':
      return h.lastAt ? `rien reçu depuis ${timeAgo(h.lastAt).replace(/^il y a /, '')}` : `aucun journal reçu${silentHours ? '' : ' (7 j)'}`;
  }
}

function HostCard({ h, site, silentHours, onRemove, onApply, applying }: { h: LogHost; site?: string; silentHours: number; onRemove: () => void; onApply: () => void; applying: boolean }) {
  const meta = STATE[h.state];
  // pushed again after a change of the server (destination), or when the host does not send
  const reapply = h.mode !== 'manual' && h.online && !h.running && (h.state === 'drift' || h.state === 'silent' || h.state === 'error');
  return (
    <article className={clsx('min-w-0 rounded-lg border p-3.5', meta.card)}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={meta.tone} pulse={h.state === 'pending'} />
          <Link to={`/hosts/${h.hostId}`} className="truncate font-medium text-zinc-100 hover:underline" title={h.name}>{h.name}</Link>
        </div>
        {h.mode !== 'manual' && (
          <button type="button" onClick={onRemove} disabled={h.running} title="Arrêter l'envoi des journaux" aria-label={`Arrêter l'envoi des journaux de ${h.name}`} className="shrink-0 rounded p-1 text-zinc-500 hover:bg-raised hover:text-red-300 disabled:opacity-40">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <p className={clsx('mt-1.5 line-clamp-2 text-xs', h.state === 'ok' ? 'text-emerald-300' : h.state === 'silent' || h.state === 'error' ? 'text-red-300' : 'text-amber-300')} title={h.detail ?? undefined}>
        {stateText(h, silentHours)}
      </p>
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="truncate text-[11px] text-muted">{[site, !h.online && 'hors ligne', MODE_LABEL[h.mode]].filter(Boolean).join(' · ')}</p>
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
  const sending = new Set(listed.filter((h) => h.mode !== 'manual').map((h) => h.hostId));
  const manual = new Set(listed.filter((h) => h.mode === 'manual').map((h) => h.hostId));
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
          <Button disabled={busy} onClick={onClose}>Annuler</Button>
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
                      {manual.has(h.id) && !why && <span className="text-amber-300"> · envoie déjà, réglé à la main : retirer ce réglage, sinon chaque ligne arrivera en double</span>}
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

function ServerPanel({ role }: { role: LogHubRole }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: sites = [] } = useSites();
  // a host being installed is followed closely, the others are read again every half minute
  const { data, isLoading, error } = useQuery({
    queryKey: ['settings', 'logs', role.id],
    queryFn: () => api.logHosts(role.id),
    refetchInterval: (q) => (q.state.data?.hosts.some((h) => h.state === 'pending' || h.running) ? 5_000 : 30_000),
  });
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
  const ok = list.filter((h) => h.state === 'ok').length;
  return (
    <Panel
      title={role.name}
      icon={ScrollText}
      actions={<Button size="sm" icon={Plus} onClick={() => setAdding(true)} disabled={!data}>Ajouter des hôtes</Button>}
    >
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted">
          Destination des hôtes : <span className="font-mono text-zinc-300">{role.target || 'inconnue'}</span>
          {data && list.length > 0 && <> · {ok} / {list.length} hôte{list.length > 1 ? 's' : ''} reçu{list.length > 1 ? 's' : ''} {data.silentHours ? `sur les ${data.silentHours} dernières heures` : 'sur 24 h'}</>}
        </p>
        {data?.error && <p className="text-xs text-amber-300">Serveur de logs illisible ({data.error}) : les états sont inconnus.</p>}
        {isLoading ? (
          <div className="flex justify-center p-6"><Spinner /></div>
        ) : error ? (
          <p className="text-red-400">{(error as Error).message}</p>
        ) : !list.length ? (
          <Empty icon={ScrollText} title="Aucun hôte n'envoie ses journaux">« Ajouter des hôtes » installe rsyslog sur les hôtes choisis et le règle pour envoyer ses journaux à ce serveur.</Empty>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {list.map((h) => (
              <HostCard key={h.hostId} h={h} site={sites.find((s) => s.id === h.siteId)?.name} silentHours={data!.silentHours} onRemove={() => setRemoving(h)} onApply={() => void apply(h)} applying={applying === h.hostId} />
            ))}
          </div>
        )}
        {!!data?.others.length && (
          <p className="text-xs text-muted">
            Reçus aussi d'émetteurs inconnus du hub (7 j) : {data.others.map((o) => o.hostname).join(', ')}. <Link to="/logs" className="text-emerald-400 hover:underline">Voir dans Logs</Link>
          </p>
        )}
      </div>
      {adding && data && <AddHostModal role={role} listed={list} onClose={() => setAdding(false)} />}
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => void remove()} title="Arrêter l'envoi des journaux" confirmLabel="Arrêter" danger loading={busy}>
        <b>{removing?.name}</b> n'enverra plus ses journaux : l'agent retire <code>/etc/rsyslog.d/90-homelab.conf</code> et redémarre rsyslog (le paquet reste
        installé). Ce que le serveur a déjà reçu est gardé.
        {removing?.mode === 'standard' && <> L'hôte garde une valeur propre « aucun envoi » dans sa standardisation.</>}
      </ConfirmModal>
    </Panel>
  );
}

export function LogHostsSettings() {
  const { data: servers = [], isLoading } = useLogServers();
  if (isLoading) return <div className="flex justify-center p-10"><Spinner /></div>;
  return (
    <div className="space-y-4">
      {servers.map((r) => <ServerPanel key={r.id} role={r} />)}
    </div>
  );
}
