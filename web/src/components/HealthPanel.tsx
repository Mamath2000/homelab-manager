import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, ChartLine, Cpu, EyeOff, HardDrive, Thermometer } from 'lucide-react';
import { api, visibleHealthVolumes, type HealthSystem, type Host } from '../lib/api';
import { formatBytes } from '../lib/backups';
import { dateTime } from '../lib/format';
import { thresholdBg } from '../lib/status';
import { useToast } from '../lib/toast';
import { HealthDetailModal } from './HealthDetailModal';
import { SmartSetup } from './SmartSetup';
import { Badge, Button, Panel } from './ui';

function Percent({ value, tone = 'emerald', warning, alert, durationMinutes }: { value: number; tone?: 'emerald' | 'sky' | 'indigo'; warning?: number; alert?: number; durationMinutes?: number }) {
  const colors = { emerald: 'bg-emerald-400', sky: 'bg-sky-400', indigo: 'bg-indigo-400' };
  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="relative h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-black/30">
          <div className={`h-full ${thresholdBg(value, colors[tone], warning, alert)}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
          {warning !== undefined && <span className="absolute -top-0.5 h-2.5 w-px bg-amber-300" style={{ left: `${warning}%` }} title={`Warning ${warning}% · ${durationMinutes ?? 0} min`} />}
          {alert !== undefined && <span className="absolute -top-0.5 h-2.5 w-px bg-red-400" style={{ left: `${alert}%` }} title={`Alerte ${alert}% · ${durationMinutes ?? 0} min`} />}
        </div>
        <span className="w-12 text-right font-mono text-xs">{value.toFixed(1)} %</span>
      </div>
      {warning !== undefined && alert !== undefined && <div className="mt-1 flex flex-wrap justify-between gap-x-2 pl-1 text-[10px] text-muted"><span>Warning {warning}%</span><span>Alerte {alert}%</span><span>{durationMinutes ? `après ${durationMinutes} min` : 'immédiat'}</span></div>}
    </div>
  );
}

type PanelAlert = NonNullable<NonNullable<Host['health']>['alerts']>[number];

// Accept the alerts of a row (or watch them again): they stop counting for the state of the host, the bar keeps its colour.
function SilenceButton({ hostId, alerts, canManage }: { hostId: string; alerts: PanelAlert[]; canManage: boolean }) {
  const toast = useToast();
  const silenced = alerts.length > 0 && alerts.every((a) => a.silenced);
  const toggle = useMutation({
    mutationFn: () => api.silenceHealthAlerts(hostId, alerts.map((a) => a.key), !silenced),
    onError: (err: Error) => toast.error(err.message),
  });
  if (!alerts.length || !canManage) return null;
  const title = silenced ? 'Alerte masquée : ne compte plus pour l\'état de l\'hôte. Cliquer pour la réactiver.' : 'Accepter le risque : masquer cette alerte de l\'état de l\'hôte';
  return (
    <Button size="sm" variant="ghost" title={title} aria-label={title} aria-pressed={silenced} loading={toggle.isPending} onClick={() => toggle.mutate()}>
      <EyeOff className={`h-4 w-4 ${silenced ? 'text-zinc-500' : 'text-amber-300'}`} />
    </Button>
  );
}

export function HealthPanel({ host, canManage }: { host: Host; canManage: boolean }) {
  const [chartOpen, setChartOpen] = useState(false);
  const { data, isError, error } = useQuery({
    queryKey: ['health', host.id],
    queryFn: () => api.hostHealth(host.id, 1),
    refetchInterval: 30_000,
  });
  const { data: settings } = useQuery({ queryKey: ['settings', 'health'], queryFn: api.healthSettings });
  const systemSamples = useMemo(
    () => (data?.samples ?? []).filter((s): s is typeof s & { report: HealthSystem } => s.category === 'system'),
    [data],
  );
  const health = host.health;
  const system = health?.system;
  const disk = health?.disks;
  const visibleVolumes = visibleHealthVolumes(disk?.volumes ?? []);
  const smart = health?.smart;
  const virtualization = host.info?.virt.trim().toLowerCase();
  const noDisks = virtualization === 'wsl';
  const virtualized = !!virtualization && virtualization !== 'none' && virtualization !== 'unknown';

  const allAlerts = health?.alerts ?? [];
  const alerts = allAlerts.filter((a) => !a.silenced);
  const alertsOf = (...keys: string[]) => allAlerts.filter((a) => keys.some((k) => a.key === k || a.key.startsWith(`${k}:`)));
  const hasCriticalAlert = alerts.some((alert) => alert.level === 'alert');
  const smartDisks = !virtualized ? smart?.disks ?? [] : [];

  return (
    <Panel
      title={<>Santé{system && <span className="text-xs font-normal text-muted">Mesures : {dateTime(system.checkedAt)}</span>}</>}
      icon={Activity}
      actions={
        <>
          {alerts.length > 0 && <Badge tone={hasCriticalAlert ? 'bad' : 'warn'}><span title={alerts.map((a) => a.reason).join('\n')} className="flex items-center"><AlertTriangle className="mr-1 h-3 w-3" />{alerts.length}</span></Badge>}
          <Button size="sm" variant="ghost" title="Détail de la santé" aria-label="Détail de la santé" onClick={() => setChartOpen(true)}><ChartLine className="h-4 w-4" /></Button>
        </>
      }
    >
      <div className="space-y-5 p-4">
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-100"><Cpu className="h-4 w-4 text-emerald-300" />CPU et mémoire</h3>
          {isError && <p className="mb-2 text-xs text-amber-300">Historique indisponible : {error.message}</p>}
          {system ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div><div className="mb-1 flex items-center justify-between"><p className="text-xs text-muted">CPU</p><SilenceButton hostId={host.id} alerts={alertsOf('system:cpu')} canManage={canManage} /></div><Percent value={system.cpuPercent} warning={settings?.cpuWarningThreshold} alert={settings?.cpuAlertThreshold} durationMinutes={settings?.systemSustainedMinutes} /></div>
              <div><div className="mb-1 flex items-center justify-between"><p className="text-xs text-muted">Mémoire · {formatBytes(system.memUsed)} / {formatBytes(system.memTotal)}</p><SilenceButton hostId={host.id} alerts={alertsOf('system:memory')} canManage={canManage} /></div><Percent value={system.memPercent} tone="sky" warning={settings?.memoryWarningThreshold} alert={settings?.memoryAlertThreshold} durationMinutes={settings?.systemSustainedMinutes} /></div>
              {system.load1 !== undefined && (
                <p className="text-xs text-muted sm:col-span-2">
                  Charge Unix : <span className="font-mono">
                    {([['1', system.load1], ['5', system.load5], ['15', system.load15]] as const).map(([period, value]) => value !== undefined && <span key={period} className={value > 1 ? 'text-red-400' : 'text-zinc-300'}>{value.toFixed(2)} </span>)}
                  </span>
                  <span className="ml-1">(1 / 5 / 15 min)</span>
                </p>
              )}
            </div>
          ) : <p className="text-sm text-muted">En attente de la première mesure de l'agent.</p>}
        </section>

        {!noDisks && (<section>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-100"><HardDrive className="h-4 w-4 text-amber-300" />Volumes</h3>
            <p className="mb-3 text-xs text-muted">Les montages loop et pseudo-filesystems sont masqués sous Unix. Les partitions et volumes RAID restent visibles ; un disque virtuel présenté comme un disque local par une VM ne peut pas toujours être distingué du matériel.</p>
            {!visibleVolumes.length ? <p className="text-sm text-muted">Pas de volume remonté pour le moment.</p> : (
              <div className="space-y-3">
                {visibleVolumes.map((v) => (
                  <div key={`${v.device}:${v.mountpoint}`} className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(180px,1fr)] sm:items-center">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-zinc-200" title={v.mountpoint}>{v.mountpoint}</p>
                      <p className="truncate font-mono text-[10px] text-muted" title={v.device}>{v.device} · {v.fstype} · {formatBytes(v.used)} / {formatBytes(v.total)}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="flex w-8 shrink-0 justify-center"><SilenceButton hostId={host.id} alerts={alertsOf(`disks:volume:${v.mountpoint}`)} canManage={canManage} /></span>
                      <div className="min-w-0 flex-1"><Percent value={v.percent} tone="indigo" warning={settings?.diskWarningThreshold} alert={settings?.diskAlertThreshold} /></div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>)}

        {smartDisks.length > 0 && (
          <section>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-100"><Thermometer className="h-4 w-4 text-violet-300" />SMART</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {smartDisks.map((d) => (
                <div key={d.device} className="min-w-0 rounded-md border border-line bg-raised/20 px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate font-medium text-zinc-100" title={d.device}>{d.model || d.device}</span>
                    {d.healthy === undefined ? <Badge>SMART inconnu</Badge> : <Badge tone={d.healthy ? 'ok' : 'bad'}>{d.healthy ? 'Sain' : 'Échec SMART'}</Badge>}
                    {d.temperatureC !== undefined && <span className="text-zinc-300">{d.temperatureC} °C</span>}
                    {d.reallocated !== undefined && <span className="text-zinc-300">{d.reallocated} réalloués</span>}
                    {d.nvmeWearPercent !== undefined && <span className="text-zinc-300">Usure {d.nvmeWearPercent} %</span>}
                    <span className="ml-auto"><SilenceButton hostId={host.id} alerts={alertsOf(`smart:${d.device}`)} canManage={canManage} /></span>
                  </div>
                  {d.error && <p className="mt-1 text-amber-300">{d.error}</p>}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      <HealthDetailModal
        open={chartOpen}
        onClose={() => setChartOpen(false)}
        hostName={host.name}
        health={health}
        samples={systemSamples}
        settings={settings}
        historyError={isError ? error.message : undefined}
        virtualized={virtualized}
        noDisks={noDisks}
        smartSetup={host.capabilities.includes('health') && !virtualized ? <SmartSetup host={host} canManage={canManage} /> : undefined}
      />
    </Panel>
  );
}
