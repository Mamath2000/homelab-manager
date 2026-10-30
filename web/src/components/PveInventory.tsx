import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Download, Search, Server } from 'lucide-react';
import { Link } from 'react-router';
import { api, type PveInstallTarget, type PveInventory as Cluster } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';
import { useToast } from '../lib/toast';
import { Badge, Button, Modal, Panel, ResponsiveList, Spinner } from './ui';

// Paramètres › Proxmox VE: the inventory of each cluster (pve-cluster role), node by node, read at each poll. A VM or a
// CT is a host of the hub when one of its MAC addresses is the one of an agent; otherwise it is unmanaged and only
// shown here. Nothing about health or backup results: that is the subject of the hosts.

type Guest = Cluster['guests'][number];

const guestLabel = (g: Pick<Guest, 'type' | 'vmid'>) => `${g.type === 'lxc' ? 'CT' : 'VM'} ${g.vmid}`;

const STATUS: Record<string, { label: string; tone: 'ok' | 'neutral' | 'warn' | 'unknown' }> = {
  running: { label: 'démarré', tone: 'ok' },
  stopped: { label: 'arrêté', tone: 'neutral' },
  paused: { label: 'en pause', tone: 'warn' },
};
const statusOf = (s: string) => STATUS[s] ?? { label: 'inconnu', tone: 'unknown' as const };

// Agent installation (homelab#259): a CT without host whose node has an agent can receive one. One CT: launched at once;
// several: the plan (dry-run, checked by the agent of the node) is shown first and confirmed.
interface Installer {
  selected: Set<number>;
  toggle: (vmid: number) => void;
  busy: Set<number>;
  install: (vmid: number) => void;
  preview: (vmids: number[]) => void;
}

function HostCell({ g, inst }: { g: Guest; inst?: Installer }) {
  if (g.host) return <Link className="underline" to={`/hosts/${g.host.id}`}>{g.host.name}</Link>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone="neutral">non géré</Badge>
      {g.installing && <Badge tone="warn">installation…</Badge>}
      {inst && g.install?.eligible && !g.installing && (
        <Button size="sm" icon={Download} loading={inst.busy.has(g.vmid)} onClick={() => inst.install(g.vmid)}>Installer l'agent</Button>
      )}
      {g.install && !g.install.eligible && g.type === 'lxc' && g.install.reasons.length > 0 && (
        <span className="text-xs text-muted" title={g.install.reasons.join(' · ')}>agent non installable : {g.install.reasons[0]}</span>
      )}
      {g.ambiguous && <span className="text-xs text-amber-300" title="Une adresse MAC de cette VM / ce CT est aussi celle d'une autre VM / d'un autre CT : aucun hôte n'y est relié">MAC ambiguë</span>}
    </span>
  );
}

function Jobs({ g }: { g: Guest }) {
  if (!g.jobs.length) return <span className="text-muted">aucune</span>;
  return (
    <ul className="space-y-0.5">
      {g.jobs.map((j) => (
        <li key={j.id} className={clsx('text-xs', j.enabled ? 'text-zinc-300' : 'text-muted line-through')} title={j.nextRun ? `prochaine : ${dateTime(j.nextRun)}` : undefined}>
          {j.scheduleText} · <span className="font-mono">{j.storage || '?'}</span>
          {!j.enabled && ' (désactivé)'}
        </li>
      ))}
    </ul>
  );
}

function InstallPlan({ cluster, plan, onClose, onDone }: { cluster: string; plan: PveInstallTarget[] | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const ok = plan?.filter((t) => t.eligible) ?? [];
  const run = async () => {
    setLoading(true);
    try {
      const r = await api.installPveAgents(cluster, ok.map((t) => t.vmid), false);
      const started = r.targets.filter((t) => t.jobId).length;
      toast.success(`Installation lancée sur ${started} CT`);
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Modal
      open={!!plan}
      onClose={onClose}
      title="Installer l'agent sur les CT sélectionnés"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Fermer</Button>
          {ok.length > 0 && <Button variant="primary" onClick={run} loading={loading}>Installer sur {ok.length} CT</Button>}
        </>
      }
    >
      <ul className="space-y-2 text-sm">
        {plan?.map((t) => (
          <li key={t.vmid} className={clsx(!t.eligible && 'opacity-70')}>
            <span className="font-medium text-zinc-100">CT {t.vmid} · {t.name || '—'}</span> <span className="text-xs text-muted">({t.node})</span>{' '}
            <Badge tone={t.eligible ? 'ok' : 'bad'}>{t.eligible ? 'installable' : 'non installable'}</Badge>
            {t.eligible && <span className="ml-2 text-xs text-muted">{t.mode === 'reuse' ? `hôte « ${t.hostName} » réutilisé` : `hôte « ${t.hostName} » créé, standardisation désactivée`}</span>}
            {t.reasons.length > 0 && <ul className="ml-4 list-disc text-xs text-muted">{t.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function NodeBlock({ node, guests, inst }: { node: Cluster['nodes'][number]; guests: Guest[]; inst: Installer }) {
  const installable = guests.filter((g) => g.install?.eligible && !g.installing);
  const chosen = installable.filter((g) => inst.selected.has(g.vmid)).map((g) => g.vmid);
  const check = (g: Guest) =>
    g.install?.eligible && !g.installing ? (
      <input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={inst.selected.has(g.vmid)} onChange={() => inst.toggle(g.vmid)} aria-label={`Sélectionner ${guestLabel(g)}`} />
    ) : null;
  return (
    <section className="border-t border-line">
      <header className="flex flex-wrap items-center gap-2 bg-raised/30 px-4 py-2.5 text-sm">
        <Server className="h-4 w-4 text-orange-400" />
        <span className="font-medium text-zinc-100">{node.node}</span>
        {!node.online && <Badge tone="bad">hors ligne</Badge>}
        {node.host ? (
          <span className="text-xs text-muted">
            agent : <Link className="underline" to={`/hosts/${node.host.id}`}>{node.host.name}</Link>
            {!node.host.online && <span className="text-amber-300"> (hors ligne)</span>}
          </span>
        ) : (
          <Badge tone="neutral">non géré</Badge>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted">
          {installable.length > 0 && (
            <Button size="sm" icon={Search} onClick={() => inst.preview(installable.map((g) => g.vmid))}>Vérifier</Button>
          )}
          {chosen.length > 0 && <Button size="sm" variant="primary" icon={Download} onClick={() => inst.preview(chosen)}>Installer sur la sélection ({chosen.length})</Button>}
          {guests.length} VM / CT
        </span>
      </header>
      {guests.length > 0 && (
        <>
          <ResponsiveList mode="mobile">
            {guests.map((g) => (
              <article key={g.vmid} className="min-w-0 space-y-1.5 p-4">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2 font-medium text-zinc-100">{check(g)}<span className="truncate">{guestLabel(g)} · {g.name || '—'}</span></span>
                  <Badge tone={statusOf(g.status).tone}>{statusOf(g.status).label}</Badge>
                </div>
                <div className="text-sm"><HostCell g={g} inst={inst} /></div>
                <Jobs g={g} />
              </article>
            ))}
          </ResponsiveList>
          <ResponsiveList mode="desktop">
            <table className="w-full text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className="th w-24">ID</th>
                  <th className="th">Nom</th>
                  <th className="th">État</th>
                  <th className="th">Hôte</th>
                  <th className="th">Sauvegardes programmées</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {guests.map((g) => (
                  <tr key={g.vmid} className="hover:bg-raised/40">
                    <td className="td whitespace-nowrap font-mono text-xs text-zinc-300"><span className="inline-flex items-center gap-2">{check(g)}{guestLabel(g)}</span></td>
                    <td className="td text-zinc-100">{g.name || '—'}</td>
                    <td className="td"><Badge tone={statusOf(g.status).tone}>{statusOf(g.status).label}</Badge></td>
                    <td className="td"><HostCell g={g} inst={inst} /></td>
                    <td className="td"><Jobs g={g} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveList>
        </>
      )}
    </section>
  );
}

function ClusterPanel({ c }: { c: Cluster }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [plan, setPlan] = useState<PveInstallTarget[] | null>(null);
  const [planning, setPlanning] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['settings', 'pve'] });
  const inst: Installer = {
    selected,
    busy,
    toggle: (vmid) => setSelected((s) => { const n = new Set(s); if (!n.delete(vmid)) n.add(vmid); return n; }),
    // one CT: launched at once, the hub checks it again before touching anything
    install: async (vmid) => {
      setBusy((b) => new Set(b).add(vmid));
      try {
        const t = (await api.installPveAgents(c.id, [vmid], false)).targets[0];
        if (t?.jobId) toast.success(`Installation de l'agent lancée sur CT ${vmid}`);
        else toast.error(`CT ${vmid} : ${t?.reasons.join(' · ') || 'non installable'}`);
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setBusy((b) => { const n = new Set(b); n.delete(vmid); return n; });
        refresh();
      }
    },
    preview: async (vmids) => {
      if (planning) return;
      setPlanning(true);
      try {
        setPlan((await api.installPveAgents(c.id, vmids, true)).targets);
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setPlanning(false);
      }
    },
  };
  const managed = c.guests.filter((g) => g.host).length;
  return (
    <Panel title={`Cluster ${c.name}`} icon={Server} bodyClassName="">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-xs text-muted">
        <span className="font-mono">{c.url}</span>
        {c.carrier && <span>lu par <Link className="underline" to={`/hosts/${c.carrier.id}`}>{c.carrier.name}</Link></span>}
        <span>{c.nodes.length} nœud{c.nodes.length > 1 ? 's' : ''} · {c.guests.length} VM / CT · {managed} avec agent, {c.guests.length - managed} non géré{c.guests.length - managed > 1 ? 's' : ''}</span>
        <span title={c.polledAt ? dateTime(c.polledAt) : undefined}>{c.polledAt ? `relevé ${timeAgo(c.polledAt)}` : 'jamais relevé'}</span>
      </div>
      {c.pollError && <p className="mx-4 mb-3 rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs text-red-200">Dernier relevé en échec : {c.pollError}</p>}
      {c.nodes.map((n) => (
        <NodeBlock key={n.node} node={n} guests={c.guests.filter((g) => g.node === n.node)} inst={inst} />
      ))}
      <InstallPlan cluster={c.id} plan={plan} onClose={() => setPlan(null)} onDone={() => { setPlan(null); setSelected(new Set()); refresh(); }} />
    </Panel>
  );
}

export function PveInventory() {
  const { data, isLoading, error } = useQuery({ queryKey: ['settings', 'pve', 'inventory'], queryFn: api.pveInventory });
  if (isLoading) return <div className="flex justify-center p-6"><Spinner /></div>;
  if (error) return <p className="p-4 text-sm text-red-400">{(error as Error).message}</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Inventaire relu à chaque relevé (toutes les 15 minutes). Une VM ou un CT est un hôte quand l'une de ses adresses MAC est celle d'un agent ; sinon il est{' '}
        <b className="text-zinc-300">non géré</b> et n'apparaît qu'ici. Le cluster se déclare et se modifie dans{' '}
        <Link to="/settings?tab=roles" className="text-emerald-400 hover:underline">Paramètres › Rôles</Link>.
      </p>
      {data?.clusters.map((c) => <ClusterPanel key={c.id} c={c} />)}
    </div>
  );
}
