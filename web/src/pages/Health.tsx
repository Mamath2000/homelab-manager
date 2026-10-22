import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, ChartLine, Clock3, Server } from 'lucide-react';
import { Link } from 'react-router';
import { HeaderTitle } from '../components/HeaderSlot';
import { Badge, Button, Empty, Panel, Spinner } from '../components/ui';
import { HealthDetailModal } from '../components/HealthDetailModal';
import { HealthOverviewHeader } from '../components/HealthOverviewHeader';
import { inColumn, kindColumns } from '../lib/hostOverview';
import { useHosts, useSites } from '../lib/queries';
import { api, visibleHealthVolumes, type HealthOverviewHost, type HealthSettings } from '../lib/api';

function Metric({ label, value, color, warning, alert, durationMinutes }: { label: string; value: number; color: string; warning?: number; alert?: number; durationMinutes?: number }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex justify-between text-xs"><span className="text-muted">{label}</span><span className="font-mono text-zinc-200">{value.toFixed(1)} %</span></div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-black/30">
        <div className={`h-full ${color}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
        {warning !== undefined && <span className="absolute -top-0.5 h-2.5 w-px bg-amber-300" style={{ left: `${warning}%` }} title={`Warning ${warning}%${durationMinutes === undefined ? '' : ` · ${durationMinutes} min`}`} />}
        {alert !== undefined && <span className="absolute -top-0.5 h-2.5 w-px bg-red-400" style={{ left: `${alert}%` }} title={`Alerte ${alert}%${durationMinutes === undefined ? '' : ` · ${durationMinutes} min`}`} />}
      </div>
      {warning !== undefined && alert !== undefined && <div className="mt-1 flex flex-wrap justify-between gap-x-2 text-[10px] text-muted"><span>Warning {warning}%</span><span>Alerte {alert}%</span>{durationMinutes !== undefined && <span>{durationMinutes ? `après ${durationMinutes} min` : 'immédiat'}</span>}</div>}
    </div>
  );
}

function HostHealthCard({ host, settings }: { host: HealthOverviewHost; settings?: HealthSettings }) {
  const [chartOpen, setChartOpen] = useState(false);
  const alerts = host.health?.alerts ?? [];
  const hasCriticalAlert = alerts.some((alert) => alert.level === 'alert');
  const system = host.health?.system;
  const maxDisk = Math.max(0, ...visibleHealthVolumes(host.health?.disks?.volumes ?? []).map((v) => v.percent));
  return (
    <Panel
      title={<Link className="truncate hover:text-emerald-300" to={`/hosts/${host.id}`}>{host.name}</Link>}
      icon={Server}
      actions={
        <div className="flex items-center gap-2">
          {system && <Button size="sm" variant="ghost" title={`Afficher le graphique CPU et mémoire de ${host.name}`} aria-label={`Afficher le graphique CPU et mémoire de ${host.name}`} onClick={() => setChartOpen(true)}><ChartLine className="h-4 w-4" /></Button>}
          {alerts.length > 0 && <Badge tone={hasCriticalAlert ? 'bad' : 'warn'}><AlertTriangle className="mr-1 h-3 w-3" />{alerts.length}</Badge>}
          <span className={`h-2 w-2 rounded-full ${host.online ? 'bg-emerald-400' : 'bg-zinc-600'}`} title={host.online ? 'En ligne' : 'Hors ligne'} />
        </div>
      }
    >
      {system ? (
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-3">
            <Metric label="CPU" value={system.cpuPercent} color="bg-emerald-400" warning={settings?.cpuWarningThreshold} alert={settings?.cpuAlertThreshold} durationMinutes={settings?.systemSustainedMinutes} />
            <Metric label="Mémoire" value={system.memPercent} color="bg-sky-400" warning={settings?.memoryWarningThreshold} alert={settings?.memoryAlertThreshold} durationMinutes={settings?.systemSustainedMinutes} />
            {!host.noDisks && host.health?.disks && <Metric label="Volume le plus chargé" value={maxDisk} color="bg-amber-400" warning={settings?.diskWarningThreshold} alert={settings?.diskAlertThreshold} />}
            {system.load1 !== undefined && (
              <div className="text-right text-xs text-muted">
                Charge 1 / 5 / 15 min<br /><span className="font-mono">
                  {([['1', system.load1], ['5', system.load5], ['15', system.load15]] as const).map(([period, value]) => value !== undefined && <span key={period} className={value > 1 ? 'text-red-400' : 'text-zinc-300'}>{value.toFixed(2)} </span>)}
                </span>
              </div>
            )}
          </div>
          {alerts.length > 0 && (
            <ul className="space-y-1 border-t border-line pt-2">
              {alerts.slice(0, 3).map((a) => <li key={a.key} className={`truncate text-xs ${a.level === 'alert' ? 'text-red-300' : 'text-amber-300'}`} title={a.reason}>{a.reason}</li>)}
              {alerts.length > 3 && <li className="text-xs text-muted">… et {alerts.length - 3} autre(s)</li>}
            </ul>
          )}
        </div>
      ) : (
        <div className="p-4 text-sm text-muted">
          {!host.supported ? 'Agent non compatible avec la collecte Santé.' : !host.online ? 'Hôte hors ligne.' : 'En attente de la première collecte.'}
        </div>
      )}
      <HealthDetailModal open={chartOpen} onClose={() => setChartOpen(false)} hostName={host.name} health={host.health} samples={host.samples} settings={settings} virtualized={host.virtualized} noDisks={host.noDisks} />
    </Panel>
  );
}

export function Health() {
  const { data, isLoading, error } = useQuery({ queryKey: ['health', 'overview'], queryFn: api.healthOverview, refetchInterval: 30_000 });
  const { data: settings } = useQuery({ queryKey: ['settings', 'health'], queryFn: api.healthSettings });
  const { data: hostList } = useHosts();
  const { data: siteConfig } = useSites();
  const [{ site, kind }, setSel] = useState({ site: '', kind: '' });
  const list = useMemo(() => (data?.hosts ?? []).filter((h) => h.health?.system), [data]);
  const items = useMemo(() => list.flatMap((health) => { const host = hostList?.find((h) => h.id === health.id); return host ? [{ host, health }] : []; }), [list, hostList]);
  const shown = useMemo(() => {
    const col = kindColumns(items.map((i) => i.host)).find((c) => c.key === kind);
    const ids = new Set(items.filter(({ host }) => (!site || (host.siteId || 'none') === site) && (!col || inColumn(host, col))).map((i) => i.host.id));
    return !site && !kind ? list : list.filter((h) => ids.has(h.id));
  }, [items, list, site, kind]);
  const supported = list;
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
          <HealthOverviewHeader items={items} sites={siteConfig ?? []} site={site} kind={kind} onSiteKind={(s, k) => setSel({ site: s, kind: k })} />
          <div className="mb-4 flex items-center gap-2 text-xs text-muted"><Clock3 className="h-4 w-4" />CPU et mémoire toutes les 30 s · volumes toutes les 5 min · SMART toutes les 24 h, sur les seuls disques choisis pour chaque hôte.</div>
          <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
            {shown.map((host) => <HostHealthCard key={host.id} host={host} settings={settings} />)}
          </div>
        </>
      )}
    </>
  );
}
