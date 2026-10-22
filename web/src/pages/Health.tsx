import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, Clock3, Server } from 'lucide-react';
import { Link } from 'react-router';
import { HeaderTitle } from '../components/HeaderSlot';
import { Badge, Empty, Panel, Spinner } from '../components/ui';
import { api, type HealthOverviewHost } from '../lib/api';
import { dateTime } from '../lib/format';

function Chart({ samples }: { samples: HealthOverviewHost['samples'] }) {
  if (samples.length < 2) return <div className="flex h-24 items-center justify-center text-xs text-muted">En attente de mesures suffisantes.</div>;
  const path = (field: 'cpuPercent' | 'memPercent') => samples.map(({ report }, i) => {
    const x = (i / (samples.length - 1)) * 300;
    const y = 92 - (Math.max(0, Math.min(100, report[field])) / 100) * 84;
    return `${x},${y}`;
  }).join(' ');
  const last = samples[samples.length - 1].report;
  return (
    <div>
      <svg viewBox="0 0 300 100" role="img" aria-label="CPU et mémoire sur la dernière heure" className="h-24 w-full">
        {[0, 50, 100].map((n) => <line key={n} x1="0" x2="300" y1={92 - n * 0.84} y2={92 - n * 0.84} stroke="currentColor" className="text-line" strokeDasharray="3 5" />)}
        <polyline points={path('cpuPercent')} fill="none" stroke="#34d399" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        <polyline points={path('memPercent')} fill="none" stroke="#38bdf8" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[10px] text-muted">
        <span>{dateTime(Number(new Date(samples[0].sampledAt)))}</span>
        <span>{last.cpuPercent.toFixed(0)} % CPU · {last.memPercent.toFixed(0)} % RAM</span>
      </div>
      <div className="mt-1 flex gap-3 text-[10px] text-muted"><span className="text-emerald-300">● CPU</span><span className="text-sky-300">● Mémoire</span></div>
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex justify-between text-xs"><span className="text-muted">{label}</span><span className="font-mono text-zinc-200">{value.toFixed(1)} %</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-black/30"><div className={`h-full ${color}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>
    </div>
  );
}

function HostHealthCard({ host }: { host: HealthOverviewHost }) {
  const alerts = host.health?.alerts ?? [];
  const system = host.health?.system;
  const maxDisk = Math.max(0, ...(host.health?.disks?.volumes ?? []).map((v) => v.percent));
  return (
    <Panel
      title={<Link className="truncate hover:text-emerald-300" to={`/hosts/${host.id}`}>{host.name}</Link>}
      icon={Server}
      actions={
        <div className="flex items-center gap-2">
          {alerts.length > 0 && <Badge tone="bad"><AlertTriangle className="mr-1 h-3 w-3" />{alerts.length}</Badge>}
          <span className={`h-2 w-2 rounded-full ${host.online ? 'bg-emerald-400' : 'bg-zinc-600'}`} title={host.online ? 'En ligne' : 'Hors ligne'} />
        </div>
      }
    >
      {system ? (
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-3">
            <Metric label="CPU" value={system.cpuPercent} color="bg-emerald-400" />
            <Metric label="Mémoire" value={system.memPercent} color="bg-sky-400" />
            {host.health?.disks && <Metric label="Volume le plus chargé" value={maxDisk} color="bg-amber-400" />}
            {system.load1 !== undefined && (
              <div className="text-right text-xs text-muted">
                Charge 1 / 5 / 15 min<br /><span className="font-mono text-zinc-300">{system.load1.toFixed(2)} / {system.load5?.toFixed(2)} / {system.load15?.toFixed(2)}</span>
              </div>
            )}
          </div>
          <Chart samples={host.samples} />
          {alerts.length > 0 && (
            <ul className="space-y-1 border-t border-line pt-2">
              {alerts.slice(0, 3).map((a) => <li key={a.key} className="truncate text-xs text-amber-300" title={a.reason}>{a.reason}</li>)}
              {alerts.length > 3 && <li className="text-xs text-muted">… et {alerts.length - 3} autre(s)</li>}
            </ul>
          )}
        </div>
      ) : (
        <div className="p-4 text-sm text-muted">
          {!host.supported ? 'Agent non compatible avec la collecte Santé.' : !host.online ? 'Hôte hors ligne.' : 'En attente de la première collecte.'}
        </div>
      )}
    </Panel>
  );
}

export function Health() {
  const { data, isLoading, error } = useQuery({ queryKey: ['health', 'overview'], queryFn: api.healthOverview, refetchInterval: 30_000 });
  const list = data?.hosts ?? [];
  const supported = list.filter((h) => h.supported);
  const alerts = supported.reduce((count, h) => count + (h.health?.alerts?.length ?? 0), 0);
  const measured = supported.filter((h) => h.health?.system).length;
  return (
    <>
      <HeaderTitle icon={Activity} title="Santé" />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
        <p>Charge récente des hôtes, alertes et état des disques. Les courbes couvrent la dernière heure ; les mesures sont conservées 48 h.</p>
        <div className="flex items-center gap-3"><span><Server className="mr-1 inline h-4 w-4" />{measured}/{supported.length} suivis</span><span><AlertTriangle className="mr-1 inline h-4 w-4" />{alerts} alerte(s)</span><Link className="text-emerald-300 hover:text-emerald-200" to="/settings?tab=health">Réglages</Link></div>
      </div>
      {isLoading ? <div className="flex justify-center p-16"><Spinner /></div> : error ? <Panel title="Erreur de chargement" icon={AlertTriangle}><p className="p-4 text-sm text-red-300">{error.message}</p></Panel> : !list.length ? (
        <Empty icon={Server} title="Aucun hôte">Ajoute un agent pour commencer à suivre la santé des machines.</Empty>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-2 text-xs text-muted"><Clock3 className="h-4 w-4" />CPU et mémoire toutes les 30 s · volumes toutes les 5 min · SMART toutes les 24 h, sur les seuls disques choisis pour chaque hôte.</div>
          <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
            {list.map((host) => <HostHealthCard key={host.id} host={host} />)}
          </div>
        </>
      )}
    </>
  );
}
