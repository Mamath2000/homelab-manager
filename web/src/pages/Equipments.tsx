import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Router, Search, Trash2 } from 'lucide-react';
import { EquipmentModal, ProbeSquares, VpnProbesWarning } from '../components/Equipment';
import { EQUIPMENT_TYPES, SOURCE_LABELS, TYPE_LABELS, equipmentTone } from '../lib/equipment';
import { EquipmentsOverview } from '../components/EquipmentsOverview';
import { HeaderTitle } from '../components/HeaderSlot';
import { equipmentTodo, inSite } from '../lib/equipmentOverview';
import { Badge, Button, ConfirmModal, Empty, Panel, ResponsiveList, Spinner, StatusDot, Tag } from '../components/ui';
import type { Equipment, EquipmentSource, SiteConfig, StatusView } from '../lib/api';
import { useMe } from '../lib/auth';
import { api } from '../lib/api';
import { keys, useEquipments, useSites, useStatus } from '../lib/queries';
import { useToast } from '../lib/toast';
import { NO_SITE } from '../lib/sites';

// selection: ticked equipments (admins only, absent: no tick boxes), toggled one by one or for the whole list
interface Selection {
  ids: Set<string>;
  toggle: (ids: string[], on: boolean) => void;
}

// The equipments the filters keep, one list (the site filter at the top replaces the grouping by site)
function EquipmentList({ items, all, sites, status, selection }: { items: Equipment[]; all: Equipment[]; sites: SiteConfig[]; status: StatusView | undefined; selection?: Selection }) {
  const siteName = (e: Equipment) => sites.find((s) => s.id === e.siteId)?.name ?? NO_SITE;
  const ticked = selection ? items.filter((e) => selection.ids.has(e.id)).length : 0;
  const upName = (e: Equipment) => all.find((x) => x.id === e.uplinkId)?.name ?? null;
  return (
    <Panel title={<>Équipements <span className="text-muted">({items.length})</span></>} icon={Router} bodyClassName="">
      <ResponsiveList mode="mobile">
        {items.map((e) => (
          <Link key={e.id} to={`/equipments/${e.id}`} className="block min-w-0 space-y-1.5 p-4 hover:bg-raised/40">
            <span className="flex min-w-0 items-center gap-2.5">
              <StatusDot tone={equipmentTone(status, e)} />
              <span className="min-w-0 truncate font-medium text-zinc-100">{e.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted">{TYPE_LABELS[e.type]} · {siteName(e)}</span>
            </span>
            <span className="flex items-center justify-between gap-3 text-xs text-muted">
              <span className="font-mono">{e.ip ?? '—'}</span>
              <ProbeSquares equipment={e} status={status} />
            </span>
          </Link>
        ))}
      </ResponsiveList>
      <ResponsiveList mode="desktop">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            {selection && <col className="w-10" />}
            <col className="w-[22%]" />
            <col className="w-[12%]" />
            <col className="w-[13%]" />
            <col className="w-[14%]" />
            <col className="w-[14%]" />
            <col className="w-[13%]" />
            <col className="w-[12%]" />
          </colgroup>
          <thead className="border-b border-line">
            <tr>
              {selection && (
                <th className="th">
                  <input
                    type="checkbox"
                    aria-label="Tout sélectionner"
                    checked={ticked === items.length}
                    ref={(el) => {
                      if (el) el.indeterminate = ticked > 0 && ticked < items.length;
                    }}
                    onChange={(e) => selection.toggle(items.map((x) => x.id), e.target.checked)}
                  />
                </th>
              )}
              <th className="th">Équipement</th>
              <th className="th">Type</th>
              <th className="th">Site</th>
              <th className="th">Adresse</th>
              <th className="th">Amont</th>
              <th className="th">Sondes</th>
              <th className="th">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((e) => (
              <tr key={e.id} className="hover:bg-raised/40">
                {selection && (
                  <td className="td">
                    <input type="checkbox" aria-label={`Sélectionner ${e.name}`} checked={selection.ids.has(e.id)} onChange={(ev) => selection.toggle([e.id], ev.target.checked)} />
                  </td>
                )}
                <td className="td">
                  <Link to={`/equipments/${e.id}`} className="flex items-center gap-2.5 font-medium text-zinc-100 hover:text-emerald-300">
                    <StatusDot tone={equipmentTone(status, e)} />
                    {e.name}
                  </Link>
                </td>
                <td className="td text-muted">{TYPE_LABELS[e.type]}</td>
                <td className="td text-muted">{siteName(e)}</td>
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

// Equipment, filtered by site, source and type. Admins add the manual ones.
export function Equipments() {
  const { data: equipments, isLoading } = useEquipments();
  const { data: sites } = useSites();
  const { data: status } = useStatus();
  const { canManage } = useMe();
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  // bulk deletion: the ticked equipments, then the confirmation that lists them
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const q = params.get('q') ?? '';
  const source = params.get('source') ?? '';
  const type = params.get('type') ?? '';
  const site = params.get('site') ?? '';
  const filter = params.get('f') ?? '';
  const setMany = (values: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(values)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const setParam = (k: string, v: string) => setMany({ [k]: v });

  const list = useMemo(() => {
    const words = q.trim().toLowerCase();
    const todo = equipmentTodo.find((t) => t.key === filter);
    return (equipments ?? []).filter(
      (e) =>
        (!source || e.source === source) &&
        (!type || e.type === type) &&
        (!site || inSite(e, site, sites ?? [])) &&
        (!todo || todo.test(e, status)) &&
        (!words || `${e.name} ${e.ip ?? ''}`.toLowerCase().includes(words)),
    );
  }, [equipments, q, source, type, site, filter, sites, status]);
  // a filter that hides a ticked equipment unticks it: only what is shown is deleted
  const shown = new Set(list.map((e) => e.id));
  const chosen = (equipments ?? []).filter((e) => ticked.has(e.id) && shown.has(e.id));
  const selection: Selection | undefined = canManage
    ? {
        ids: new Set(chosen.map((e) => e.id)),
        toggle: (ids, on) =>
          setTicked((prev) => {
            const next = new Set(prev);
            for (const id of ids) {
              if (on) next.add(id);
              else next.delete(id);
            }
            return next;
          }),
      }
    : undefined;
  const removeChosen = async () => {
    setDeleting(true);
    try {
      const r = await api.deleteEquipments(chosen.map((e) => e.id));
      await qc.invalidateQueries({ queryKey: keys.equipments });
      setTicked(new Set(r.skipped.map((x) => x.id)));
      if (r.skipped.length) toast.error(`${r.deleted} supprimé${r.deleted > 1 ? 's' : ''}, ${r.skipped.length} refusé${r.skipped.length > 1 ? 's' : ''} : ${r.skipped.map((x) => `${x.name ?? x.id} (${x.error})`).join(' ; ')}`);
      else toast.success(`${r.deleted} équipement${r.deleted > 1 ? 's' : ''} supprimé${r.deleted > 1 ? 's' : ''}`);
      setConfirming(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };
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
          <EquipmentsOverview
            equipments={equipments}
            sites={sites ?? []}
            status={status}
            filter={filter}
            site={site}
            type={type}
            onFilter={(key) => setParam('f', key === filter ? '' : key)}
            onSite={(id) => setParam('site', id)}
            onType={(key) => setParam('type', key)}
            onSiteType={(id, key) => setMany({ site: id, type: key })}
          />
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input className="input h-9 py-0 pl-9" placeholder="Nom, IP…" value={q} onChange={(e) => setParam('q', e.target.value)} />
            </div>
            <select className="input h-9 w-auto py-0" value={type} onChange={(e) => setParam('type', e.target.value)} aria-label="Type">
              <option value="">Tous les types</option>
              {EQUIPMENT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select>
            {!!sites?.length && (
              <select className="input h-9 w-auto py-0" value={site} onChange={(e) => setParam('site', e.target.value)} aria-label="Site">
                <option value="">Tous les sites</option>
                {sites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                <option value="none">Sans site</option>
              </select>
            )}
            {(sources.length > 1 || source) && (
              <select className="input h-9 w-auto py-0" value={source} onChange={(e) => setParam('source', e.target.value)} aria-label="Source">
                <option value="">Toutes les sources</option>
                {(Object.keys(SOURCE_LABELS) as EquipmentSource[]).map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
              </select>
            )}
            {canManage && (
              <div className="ml-auto flex items-center gap-2">
                {chosen.length > 0 && (
                  <Button icon={Trash2} variant="danger" onClick={() => setConfirming(true)}>Supprimer ({chosen.length})</Button>
                )}
                <Button icon={Plus} variant="primary" onClick={() => setAdding(true)}>Ajouter un équipement</Button>
              </div>
            )}
          </div>
          {list.length === 0 ? (
            <div className="panel"><Empty icon={Search} title="Aucun équipement ne correspond aux filtres" /></div>
          ) : (
            <EquipmentList items={list} all={equipments} sites={sites ?? []} status={status} selection={selection} />
          )}
        </>
      )}
      <ConfirmModal
        open={confirming}
        onClose={() => !deleting && setConfirming(false)}
        onConfirm={() => void removeChosen()}
        title="Supprimer des équipements"
        confirmLabel={`Supprimer ${chosen.length} équipement${chosen.length > 1 ? 's' : ''}`}
        danger
        loading={deleting}
      >
        <p className="mb-2">Les équipements, leurs sondes et leur historique sont supprimés. Un équipement d'une source automatique (Omada, ESPHome) réapparaît à la prochaine synchronisation s'il y est encore listé.</p>
        <div className="flex max-h-60 flex-wrap gap-1.5 overflow-y-auto">{chosen.map((e) => <Tag key={e.id}>{e.name}</Tag>)}</div>
        <VpnProbesWarning items={chosen} />
      </ConfirmModal>
      {adding && <EquipmentModal equipment={null} onClose={() => setAdding(false)} />}
    </>
  );
}
