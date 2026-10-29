import { useMemo, useState } from 'react';
import { AlertTriangle, Globe, Network } from 'lucide-react';
import clsx from 'clsx';
import { Link } from 'react-router';
import { HeaderTitle } from '../components/HeaderSlot';
import { ProbeActions, ProbeTimeline, ProbeTypeLabel, StateBadge, targetText } from '../components/Probes';
import { ProbesOverviewHeader, type ProbeItem, type ProbeRow } from '../components/ProbesOverviewHeader';
import { Empty, Panel, Spinner } from '../components/ui';
import { elapsed } from '../lib/format';
import { useMe } from '../lib/auth';
import { useAllProbes, useEquipments, useHosts, useSites } from '../lib/queries';

// Every probe of the hub, hosts and equipments: matrix on top (sites × types, or hosts / equipments when there is a single
// site), one card per probe below.
export function Probes() {
  const { data: probes, isLoading, error } = useAllProbes();
  const { data: hosts } = useHosts();
  const { data: equipments } = useEquipments();
  const { data: sites } = useSites();
  const { canManage } = useMe();
  const [{ row, type }, setSel] = useState({ row: '', type: '' });

  const { items, rows } = useMemo(() => {
    const siteOf = (id: string | null) => (id && sites?.some((s) => s.id === id) ? id : 'none');
    type Item = ProbeItem & { site: string; kind: 'host' | 'equipment' };
    const list = (probes ?? []).flatMap((p): Item[] => {
      const host = p.hostId ? hosts?.find((h) => h.id === p.hostId) : undefined;
      const equipment = p.equipmentId ? equipments?.find((e) => e.id === p.equipmentId) : undefined;
      if (host) return [{ probe: p, ownerName: host.name, ownerPath: `/hosts/${host.id}`, owner: { kind: 'host', host }, site: siteOf(host.siteId), kind: 'host' }];
      if (equipment) return [{ probe: p, ownerName: equipment.name, ownerPath: `/equipments/${equipment.id}`, owner: { kind: 'equipment', equipment }, site: siteOf(equipment.siteId), kind: 'equipment' }];
      return [];
    });
    const used = new Set(list.map((i) => i.site));
    const multi = used.size > 1;
    const model: ProbeRow[] = multi
      ? [...(sites ?? []).map((s) => ({ id: s.id, name: s.name })), { id: 'none', name: 'Sans site' }].map((r) => ({ ...r, items: list.filter((i) => i.site === r.id) }))
      : [{ id: 'hosts', name: 'Hôtes', items: list.filter((i) => i.kind === 'host') }, { id: 'equipments', name: 'Équipements', items: list.filter((i) => i.kind === 'equipment') }];
    return { items: list, rows: model.filter((r) => r.items.length > 0) };
  }, [probes, hosts, equipments, sites]);

  const shown = useMemo(() => {
    const ids = new Set(rows.filter((r) => !row || r.id === row).flatMap((r) => r.items.map((i) => i.probe.id)));
    return items.filter((i) => ids.has(i.probe.id) && (!type || i.probe.target.type === type));
  }, [items, rows, row, type]);

  return (
    <>
      <HeaderTitle icon={Globe} title="Sondes" />
      <p className="mb-4 text-sm text-muted">Services suivis depuis le hub, sur les hôtes et les équipements. Une sonde se crée sur la fiche de son hôte ou de son équipement.</p>
      {isLoading ? <div className="flex justify-center p-16"><Spinner /></div> : error ? <Panel title="Erreur de chargement" icon={AlertTriangle}><p className="p-4 text-sm text-red-300">{error.message}</p></Panel> : !items.length ? (
        <Empty icon={Network} title="Aucune sonde">Ajoute une sonde depuis la fiche d'un hôte ou d'un équipement.</Empty>
      ) : (
        <>
          <ProbesOverviewHeader rows={rows} items={items} row={row} type={type} onSel={(r, t) => setSel({ row: r, type: t })} />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {shown.map(({ probe: p, ownerName, ownerPath, owner }) => {
              return (
                <article key={p.id} className={clsx('panel flex min-w-0 flex-col gap-1.5 px-3 py-2.5', p.state === 'down' && '!border-red-500/60 bg-red-500/5', p.state === 'unknown' && '!border-amber-500/50 bg-amber-500/5')}>
                  <div className="flex min-w-0 items-center gap-2">
                    <b className="min-w-0 truncate text-sm font-medium text-zinc-100" title={p.name}>{p.name}</b>
                    <ProbeTypeLabel type={p.target.type} />
                    <span className="flex-1" />
                    <StateBadge p={p} />
                    {canManage && <ProbeActions probe={p} owner={owner} />}
                  </div>
                  <p className="truncate font-mono text-[11px] text-zinc-400" title={targetText(p.target)}>{targetText(p.target)}</p>
                  <p className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted">
                    <Link className="truncate font-medium text-zinc-300 hover:text-emerald-300" to={ownerPath}>{ownerName}</Link>
                    <span className="shrink-0">{p.since ? `depuis ${elapsed(p.since)}` : 'pas encore mesurée'}</span>
                  </p>
                  <ProbeTimeline probeId={p.id} />
                  {p.message && p.state !== 'up' && <p className="truncate text-[11px] text-amber-300" title={p.message}>{p.message}</p>}
                </article>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
