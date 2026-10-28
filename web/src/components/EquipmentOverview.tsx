import { Link } from 'react-router';
import clsx from 'clsx';
import { Router } from 'lucide-react';
import type { Equipment, StatusView } from '../lib/api';
import { cellCls } from '../lib/monitoring';
import { useEquipments, useSites, useStatus } from '../lib/queries';
import { NO_SITE } from '../lib/sites';
import { toneStroke } from '../lib/status';
import { SOURCE_LABELS, equipmentTone, probeCls, probeText } from '../lib/equipment';
import { Panel } from './ui';

// One column per equipment, like the hosts of the sites, but one square per probe (top to bottom) instead of one per
// domain; the connection reported by an automatic source comes first. Nothing to follow: an outlined square.
function Tile({ equipment: e, status }: { equipment: Equipment; status: StatusView | undefined }) {
  const native = status?.equipments[e.id]?.domains.system;
  const squares = [
    ...(native ? [{ key: 'native', cls: cellCls[native.level], text: `connexion (${SOURCE_LABELS[e.source]})` }] : []),
    ...e.probes.map((p) => ({ key: p.id, cls: probeCls[p.state], text: probeText(p) })),
  ];
  const title = [e.name, ...(squares.length ? squares.map((s) => s.text) : ['aucune sonde'])].join(' · ');
  return (
    <Link
      to={`/equipments/${e.id}`}
      title={title}
      aria-label={title}
      className="flex w-[30px] flex-col gap-px transition hover:brightness-125 focus-visible:outline-2 focus-visible:outline-emerald-400"
      style={{ height: `${15 * Math.max(squares.length, 1)}px` }}
    >
      {squares.length ? squares.map((s) => <span key={s.key} className={clsx('flex-1 rounded-[3px]', s.cls)} />) : <span className="flex-1 rounded-[3px] ring-1 ring-inset ring-zinc-600" />}
    </Link>
  );
}

// Equipment of the dashboard, by site (order of the settings, without site last).
export function EquipmentOverview() {
  const { data: equipments } = useEquipments();
  const { data: sites } = useSites();
  const { data: status } = useStatus();
  if (!equipments?.length) return null;
  const known = new Set((sites ?? []).map((s) => s.id));
  const groups = [
    ...(sites ?? []).map((s) => ({ id: s.id, name: s.name, items: equipments.filter((e) => e.siteId === s.id) })),
    { id: 'none', name: NO_SITE, items: equipments.filter((e) => !e.siteId || !known.has(e.siteId)) },
  ].filter((g) => g.items.length > 0);
  // worst first: a red dot when one of them is
  const dot = (items: Equipment[]) => {
    const tones = items.map((e) => equipmentTone(status, e));
    return toneStroke[tones.includes('bad') ? 'bad' : tones.includes('warn') ? 'warn' : tones.includes('ok') ? 'ok' : 'neutral'];
  };
  return (
    <Panel title="Équipements" icon={Router}>
      <p className="mb-4 text-[11px] text-muted">Un carré par sonde, de haut en bas ; la connexion remontée par la source en premier.</p>
      <div className="grid gap-x-6 gap-y-5 md:grid-cols-[repeat(auto-fit,minmax(260px,1fr))]">
        {groups.map((g) => (
          <div key={g.id} className="flex min-w-0 flex-col gap-3">
            <header className="flex items-center gap-2.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: status ? dot(g.items) : toneStroke.neutral }} />
              <b className="text-[15px] font-medium text-zinc-100">{g.name}</b>
              <span className="text-xs text-muted">{g.items.length} équipement{g.items.length > 1 ? 's' : ''}</span>
            </header>
            <div className="flex flex-wrap items-start gap-x-1.5 gap-y-2">
              {g.items.map((e) => <Tile key={e.id} equipment={e} status={status} />)}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
