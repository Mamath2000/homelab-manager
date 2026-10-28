import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { MapPin, Plus, Router, Search } from 'lucide-react';
import { EquipmentModal, ProbeSquares } from '../components/Equipment';
import { EQUIPMENT_TYPES, SOURCE_LABELS, TYPE_LABELS, equipmentTone } from '../lib/equipment';
import { HeaderTitle } from '../components/HeaderSlot';
import { Badge, Button, Empty, Panel, ResponsiveList, Spinner, StatusDot } from '../components/ui';
import type { Equipment, EquipmentSource, SiteConfig, StatusView } from '../lib/api';
import { useMe } from '../lib/auth';
import { useEquipments, useSites, useStatus } from '../lib/queries';
import { NO_SITE } from '../lib/sites';

// Sites in the order of the settings, equipment without (known) site last; empty sites are left out.
function bySite(list: Equipment[], config: SiteConfig[]) {
  const known = new Set(config.map((c) => c.id));
  return [
    ...config.map((c) => ({ id: c.id, name: c.name, items: list.filter((e) => e.siteId === c.id) })),
    { id: 'none', name: NO_SITE, items: list.filter((e) => !e.siteId || !known.has(e.siteId)) },
  ].filter((s) => s.items.length > 0);
}

function SiteEquipment({ name, items, all, status }: { name: string; items: Equipment[]; all: Equipment[]; status: StatusView | undefined }) {
  const upName = (e: Equipment) => all.find((x) => x.id === e.uplinkId)?.name ?? null;
  return (
    <Panel title={<>{name} <span className="text-muted">({items.length})</span></>} icon={MapPin} bodyClassName="">
      <ResponsiveList mode="mobile">
        {items.map((e) => (
          <Link key={e.id} to={`/equipments/${e.id}`} className="block min-w-0 space-y-1.5 p-4 hover:bg-raised/40">
            <span className="flex min-w-0 items-center gap-2.5">
              <StatusDot tone={equipmentTone(status, e)} />
              <span className="min-w-0 truncate font-medium text-zinc-100">{e.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted">{TYPE_LABELS[e.type]}</span>
            </span>
            <span className="flex items-center justify-between gap-3 text-xs text-muted">
              <span className="font-mono">{e.ip ?? '—'}</span>
              <ProbeSquares equipment={e} status={status} />
            </span>
          </Link>
        ))}
      </ResponsiveList>
      <ResponsiveList mode="desktop">
        <table className="w-full text-sm">
          <thead className="border-b border-line">
            <tr>
              <th className="th">Équipement</th>
              <th className="th">Type</th>
              <th className="th">Adresse</th>
              <th className="th">Amont</th>
              <th className="th">Sondes</th>
              <th className="th">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((e) => (
              <tr key={e.id} className="hover:bg-raised/40">
                <td className="td">
                  <Link to={`/equipments/${e.id}`} className="flex items-center gap-2.5 font-medium text-zinc-100 hover:text-emerald-300">
                    <StatusDot tone={equipmentTone(status, e)} />
                    {e.name}
                  </Link>
                </td>
                <td className="td text-muted">{TYPE_LABELS[e.type]}</td>
                <td className="td font-mono text-xs text-zinc-300">{e.ip ?? '—'}</td>
                <td className="td text-muted">{upName(e) ?? '—'}</td>
                <td className="td"><ProbeSquares equipment={e} status={status} /></td>
                <td className="td"><Badge>{SOURCE_LABELS[e.source]}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveList>
    </Panel>
  );
}

// Equipment by site, filtered by source and type. Admins add the manual ones.
export function Equipments() {
  const { data: equipments, isLoading } = useEquipments();
  const { data: sites } = useSites();
  const { data: status } = useStatus();
  const { canManage } = useMe();
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const q = params.get('q') ?? '';
  const source = params.get('source') ?? '';
  const type = params.get('type') ?? '';
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const list = useMemo(() => {
    const words = q.trim().toLowerCase();
    return (equipments ?? []).filter(
      (e) => (!source || e.source === source) && (!type || e.type === type) && (!words || `${e.name} ${e.ip ?? ''}`.toLowerCase().includes(words)),
    );
  }, [equipments, q, source, type]);
  // the source filter only matters once an automatic source exists
  const sources = [...new Set((equipments ?? []).map((e) => e.source))] as EquipmentSource[];

  if (isLoading || !equipments) return <div className="flex justify-center p-20"><Spinner /></div>;

  return (
    <>
      <HeaderTitle icon={Router} title="Équipements" />

      {equipments.length === 0 ? (
        <div className="panel">
          <Empty icon={Router} title="Aucun équipement pour l'instant">
            Un équipement est suivi sans agent : switch, point d'accès, passerelle, coordinateur Zigbee, module domotique… Ses sondes vérifient
            depuis le hub qu'il répond.
            {canManage && <div className="mt-4"><Button icon={Plus} variant="primary" onClick={() => setAdding(true)}>Ajouter un équipement</Button></div>}
          </Empty>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input className="input h-9 py-0 pl-9" placeholder="Nom, IP…" value={q} onChange={(e) => setParam('q', e.target.value)} />
            </div>
            <select className="input h-9 w-auto py-0" value={type} onChange={(e) => setParam('type', e.target.value)} aria-label="Type">
              <option value="">Tous les types</option>
              {EQUIPMENT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select>
            {(sources.length > 1 || source) && (
              <select className="input h-9 w-auto py-0" value={source} onChange={(e) => setParam('source', e.target.value)} aria-label="Source">
                <option value="">Toutes les sources</option>
                {(Object.keys(SOURCE_LABELS) as EquipmentSource[]).map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
              </select>
            )}
            {canManage && <div className="ml-auto"><Button icon={Plus} variant="primary" onClick={() => setAdding(true)}>Ajouter un équipement</Button></div>}
          </div>
          {list.length === 0 ? (
            <div className="panel"><Empty icon={Search} title="Aucun équipement ne correspond aux filtres" /></div>
          ) : (
            <div className="space-y-4">
              {bySite(list, sites ?? []).map((s) => <SiteEquipment key={s.id} name={s.name} items={s.items} all={equipments} status={status} />)}
            </div>
          )}
        </>
      )}
      {adding && <EquipmentModal equipment={null} onClose={() => setAdding(false)} />}
    </>
  );
}
