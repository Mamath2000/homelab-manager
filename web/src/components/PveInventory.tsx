import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Server } from 'lucide-react';
import { Link } from 'react-router';
import { api, type PveInventory as Cluster } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';
import { Badge, Panel, ResponsiveList, Spinner } from './ui';

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

function HostCell({ g }: { g: Guest }) {
  if (g.host) return <Link className="underline" to={`/hosts/${g.host.id}`}>{g.host.name}</Link>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone="neutral">non géré</Badge>
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

function NodeBlock({ node, guests }: { node: Cluster['nodes'][number]; guests: Guest[] }) {
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
        <span className="ml-auto text-xs text-muted">{guests.length} VM / CT</span>
      </header>
      {guests.length > 0 && (
        <>
          <ResponsiveList mode="mobile">
            {guests.map((g) => (
              <article key={g.vmid} className="min-w-0 space-y-1.5 p-4">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <span className="min-w-0 truncate font-medium text-zinc-100">{guestLabel(g)} · {g.name || '—'}</span>
                  <Badge tone={statusOf(g.status).tone}>{statusOf(g.status).label}</Badge>
                </div>
                <div className="text-sm"><HostCell g={g} /></div>
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
                    <td className="td whitespace-nowrap font-mono text-xs text-zinc-300">{guestLabel(g)}</td>
                    <td className="td text-zinc-100">{g.name || '—'}</td>
                    <td className="td"><Badge tone={statusOf(g.status).tone}>{statusOf(g.status).label}</Badge></td>
                    <td className="td"><HostCell g={g} /></td>
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
        <NodeBlock key={n.node} node={n} guests={c.guests.filter((g) => g.node === n.node)} />
      ))}
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
