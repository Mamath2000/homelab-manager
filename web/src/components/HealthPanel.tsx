import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Activity, AlertTriangle, ChartLine, ChevronDown, EyeOff, HardDrive, Layers, Thermometer, type LucideIcon } from 'lucide-react';
import { api, hasHealthRaid, loadTextClass, visibleHealthVolumes, type HealthSystem, type Host } from '../lib/api';
import { formatBytes } from '../lib/backups';
import { dateTime } from '../lib/format';
import { thresholdBg, toneBg, toneText, type Tone } from '../lib/status';
import { useToast } from '../lib/toast';
import { Gauge } from './Gauge';
import { HealthDetailModal } from './HealthDetailModal';
import { RaidArrays } from './RaidArrays';
import { SmartSetup } from './SmartSetup';
import { Badge, Button, Panel } from './ui';

function Percent({ value, tone = 'emerald', warning, alert, durationMinutes }: { value: number; tone?: 'emerald' | 'sky' | 'indigo'; warning?: number; alert?: number; durationMinutes?: number }) {
  const colors = { emerald: 'bg-emerald-400', sky: 'bg-sky-400', indigo: 'bg-indigo-400' };
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-black/30">
        <div className={`h-full ${thresholdBg(value, colors[tone], warning, alert)}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
        {warning !== undefined && <span className="absolute -top-0.5 h-2.5 w-px bg-amber-300" style={{ left: `${warning}%` }} title={`Warning ${warning}% · ${durationMinutes ?? 0} min`} />}
        {alert !== undefined && <span className="absolute -top-0.5 h-2.5 w-px bg-red-400" style={{ left: `${alert}%` }} title={`Alerte ${alert}% · ${durationMinutes ?? 0} min`} />}
      </div>
      <span className="w-12 text-right font-mono text-xs">{value.toFixed(1)} %</span>
    </div>
  );
}

type PanelAlert = NonNullable<NonNullable<Host['health']>['alerts']>[number];

// State of a family of alerts: silenced ones no longer count, like for the state of the host.
function alertTone(alerts: PanelAlert[]): Tone {
  const live = alerts.filter((a) => !a.silenced);
  return live.some((a) => a.level === 'alert') ? 'bad' : live.length ? 'warn' : 'ok';
}

// First reason of the alerts still counting, the most serious first, with the number of the others.
function alertReason(alerts: PanelAlert[]): string | undefined {
  const live = alerts.filter((a) => !a.silenced).sort((a, b) => Number(b.level === 'alert') - Number(a.level === 'alert'));
  if (!live.length) return undefined;
  return live.length > 1 ? `${live[0].reason} (+${live.length - 1})` : live[0].reason;
}

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

// One line of the summary column: what it is, the verdict in a few words, a small chart, and the details on click.
function SummaryRow({ id, icon: Icon, label, sub, head, tone, mini, open, onToggle, children }: {
  id: string; icon: LucideIcon; label: string; sub: string; head: string; tone: Tone; mini: ReactNode; open: boolean; onToggle?: () => void; children?: ReactNode;
}) {
  const problem = tone === 'warn' || tone === 'bad';
  return (
    <div>
      <button type="button" disabled={!onToggle} aria-expanded={open} aria-controls={`health-${id}`} onClick={onToggle}
        className="grid w-full grid-cols-[1.25rem_minmax(0,1fr)_auto_auto_1rem] items-center gap-x-3 rounded-md px-1 py-2.5 text-left enabled:hover:bg-raised/60">
        <Icon className={clsx('h-4 w-4', problem ? toneText[tone] : 'text-muted')} />
        <span className="min-w-0 leading-tight">
          <span className="block text-sm text-zinc-200">{label}</span>
          <span className={clsx('block truncate text-xs', problem ? toneText[tone] : 'text-muted')} title={sub}>{sub}</span>
        </span>
        <span className="flex items-center">{mini}</span>
        <span className={clsx('min-w-14 text-right font-mono text-sm font-semibold', problem ? toneText[tone] : 'text-zinc-100')}>{head}</span>
        {onToggle ? <ChevronDown className={clsx('h-4 w-4 text-muted transition-transform', open && 'rotate-180')} /> : <span />}
      </button>
      {open && <div id={`health-${id}`} className="mb-2 rounded-md border border-line bg-raised/30 p-3">{children}</div>}
    </div>
  );
}

export function HealthPanel({ host, canManage }: { host: Host; canManage: boolean }) {
  const [chartOpen, setChartOpen] = useState(false);
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const toggleRow = (id: string) => setOpenRows((rows) => ({ ...rows, [id]: !rows[id] }));
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
  const raid = health?.raid;
  const cluster = host.capabilities.find((c) => c.startsWith('pve_cluster:'))?.slice('pve_cluster:'.length);

  const diskWarning = settings?.diskWarningThreshold;
  const diskAlert = settings?.diskAlertThreshold;
  const sustained = settings?.systemSustainedMinutes;

  // Volumes: the row shows the fullest volume still counting for the host, or the fullest one when all are silenced.
  const volumeSilenced = (mountpoint: string) => { const a = alertsOf(`disks:volume:${mountpoint}`); return a.length > 0 && a.every((x) => x.silenced); };
  const countingVolumes = visibleVolumes.filter((v) => !volumeSilenced(v.mountpoint));
  const fullest = (countingVolumes.length ? countingVolumes : visibleVolumes).reduce<(typeof visibleVolumes)[number] | undefined>((a, b) => (a && a.percent >= b.percent ? a : b), undefined);
  const volumeAlerts = alertsOf('disks');
  const volumeTone = alertTone(volumeAlerts);
  const hiddenVolumes = visibleVolumes.length - countingVolumes.length;
  const volumeSub = alertReason(volumeAlerts)
    ?? (visibleVolumes.length ? `${visibleVolumes.length} volume${visibleVolumes.length > 1 ? 's' : ''}${hiddenVolumes ? ` · ${hiddenVolumes} masqué${hiddenVolumes > 1 ? 's' : ''}` : ''}` : 'Pas de volume remonté pour le moment');

  // SMART: a disk is sound when it reports healthy and no alert counts against it.
  const smartDiskTone = (d: (typeof smartDisks)[number]): Tone => {
    if (d.healthy === false) return 'bad';
    const t = alertTone(alertsOf(`smart:${d.device}`));
    return t !== 'ok' ? t : d.healthy === undefined ? 'unknown' : 'ok';
  };
  const smartTones = smartDisks.map(smartDiskTone);
  const smartSound = smartTones.filter((t) => t === 'ok').length;
  const smartTone: Tone = smartTones.includes('bad') ? 'bad' : smartTones.includes('warn') ? 'warn' : 'ok';
  const maxTemperature = Math.max(0, ...smartDisks.map((d) => d.temperatureC ?? 0));
  const smartSub = alertReason(alertsOf('smart'))
    ?? (smartSound === smartDisks.length ? `sains${maxTemperature ? ` · ${maxTemperature} °C max` : ''}` : `${smartDisks.length - smartSound} sans verdict`);

  // RAID: one unit per md array, Unraid array and Ceph cluster, judged by its alerts.
  const raidUnits = hasHealthRaid(raid) ? [...raid.arrays.map((a) => ({ key: `raid:${a.name}`, label: a.name })), ...(raid.unraid ? [{ key: 'raid:unraid', label: 'Unraid' }] : []), ...(raid.ceph ? [{ key: 'raid:ceph', label: 'Ceph' }] : [])] : [];
  const raidTones = raidUnits.map((u) => alertTone(alertsOf(u.key)));
  const raidSound = raidTones.filter((t) => t === 'ok').length;
  const raidTone: Tone = raidTones.includes('bad') ? 'bad' : raidTones.includes('warn') ? 'warn' : 'ok';
  const raidSub = alertReason(alertsOf('raid')) ?? (raidSound === raidUnits.length ? 'sains' : `${raidUnits.length - raidSound} à vérifier`);

  const gauge = (key: 'cpu' | 'mem') => {
    if (!system) return null;
    const value = key === 'cpu' ? system.cpuPercent : system.memPercent;
    const warning = key === 'cpu' ? settings?.cpuWarningThreshold : settings?.memoryWarningThreshold;
    const alert = key === 'cpu' ? settings?.cpuAlertThreshold : settings?.memoryAlertThreshold;
    const tone: Tone = alert !== undefined && value >= alert ? 'bad' : warning !== undefined && value >= warning ? 'warn' : 'ok';
    const sub = tone === 'bad' ? `Alerte ${alert} % dépassée` : tone === 'warn' ? `Warning ${warning} % dépassé` : key === 'cpu' ? (warning !== undefined && alert !== undefined ? `Seuils ${warning} / ${alert} %` : '') : `${formatBytes(system.memUsed)} / ${formatBytes(system.memTotal)}`;
    const title = warning !== undefined && alert !== undefined ? `Warning ${warning} % · alerte ${alert} % · soutenu ${sustained ?? 0} min` : undefined;
    return (
      <div className="min-w-0 text-center" title={title}>
        <Gauge value={value} base={key === 'cpu' ? 'ok' : 'info'} warning={warning} alert={alert} label={key === 'cpu' ? 'CPU' : 'Mémoire'} />
        <div className="-mt-1 flex items-center justify-center gap-1">
          <span className={clsx('text-sm', tone === 'ok' ? 'text-zinc-200' : toneText[tone])}>{key === 'cpu' ? 'CPU' : 'Mémoire'}</span>
          <SilenceButton hostId={host.id} alerts={alertsOf(key === 'cpu' ? 'system:cpu' : 'system:memory')} canManage={canManage} />
        </div>
        <p className={clsx('text-[11px]', tone === 'ok' ? 'text-muted' : toneText[tone])}>{sub}</p>
      </div>
    );
  };

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
      <div className="@container p-4">
        {isError && <p className="mb-2 text-xs text-amber-300">Historique indisponible : {error.message}</p>}
        <div className="grid gap-x-6 gap-y-4 @xl:grid-cols-[minmax(15rem,0.9fr)_1.4fr] @xl:items-start">
          <div>
            {system ? (
              <>
                <div className="grid grid-cols-2 gap-2">{gauge('cpu')}{gauge('mem')}</div>
                {system.load1 !== undefined && (
                  <p className="mt-2 text-center text-xs text-muted">
                    Charge Unix : <span className="font-mono">
                      {([['1', system.load1], ['5', system.load5], ['15', system.load15]] as const).map(([period, value]) => value !== undefined && <span key={period} className={loadTextClass(value, system.cpuCount, settings)}>{value.toFixed(2)} </span>)}
                    </span>
                    <span className="ml-1">(1 / 5 / 15 min)</span>
                    <SilenceButton hostId={host.id} alerts={alertsOf('system:load')} canManage={canManage} />
                  </p>
                )}
              </>
            ) : <p className="text-sm text-muted">En attente de la première mesure de l'agent.</p>}
          </div>

          <div className="flex min-w-0 flex-col divide-y divide-line">
            {!noDisks && (
              <SummaryRow
                id="volumes" icon={HardDrive} label="Volumes" sub={volumeSub} tone={volumeTone}
                head={fullest ? `${fullest.percent.toFixed(1)} %` : '—'}
                mini={
                  <span className="flex h-5 items-end gap-[3px]">
                    {visibleVolumes.map((v) => (
                      <span key={`${v.device}:${v.mountpoint}`} title={`${v.mountpoint} · ${v.percent.toFixed(1)} %${volumeSilenced(v.mountpoint) ? ' (alerte masquée)' : ''}`}
                        className={clsx('flex h-full w-1.5 items-end overflow-hidden rounded-sm bg-black/30', volumeSilenced(v.mountpoint) && 'opacity-50')}>
                        <span className={clsx('w-full', thresholdBg(v.percent, 'bg-indigo-400', diskWarning, diskAlert))} style={{ height: `${Math.max(6, Math.min(100, v.percent))}%` }} />
                      </span>
                    ))}
                  </span>
                }
                open={!!openRows.volumes} onToggle={visibleVolumes.length ? () => toggleRow('volumes') : undefined}
              >
                <div className="space-y-2">
                  {visibleVolumes.map((v) => (
                    <div key={`${v.device}:${v.mountpoint}`} className="grid gap-1 @md:grid-cols-[minmax(0,1fr)_minmax(10rem,1.2fr)] @md:items-center">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-zinc-200" title={v.mountpoint}>{v.mountpoint}</p>
                        <p className="truncate font-mono text-[10px] text-muted" title={v.device}>{v.device} · {v.fstype} · {formatBytes(v.used)} / {formatBytes(v.total)}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="flex w-8 shrink-0 justify-center"><SilenceButton hostId={host.id} alerts={alertsOf(`disks:volume:${v.mountpoint}`)} canManage={canManage} /></span>
                        <div className="min-w-0 flex-1"><Percent value={v.percent} tone="indigo" warning={diskWarning} alert={diskAlert} /></div>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted">
                  {diskWarning !== undefined && diskAlert !== undefined && <>Seuils : warning {diskWarning} % · alerte {diskAlert} %. </>}
                  Les montages loop et pseudo-filesystems sont masqués sous Unix. Les partitions et volumes RAID restent visibles ; un disque virtuel présenté comme un disque local par une VM ne peut pas toujours être distingué du matériel.
                </p>
              </SummaryRow>
            )}

            {hasHealthRaid(raid) && (
              <SummaryRow
                id="raid" icon={Layers} label="RAID" sub={raidSub} tone={raidTone}
                head={`${raidSound}/${raidUnits.length}`}
                mini={
                  <span className="flex items-center gap-1">
                    {raidUnits.map((u, i) => <span key={u.key} title={u.label} className={clsx('h-2.5 w-2.5 rounded-[3px]', toneBg[raidTones[i]])} />)}
                  </span>
                }
                open={!!openRows.raid} onToggle={() => toggleRow('raid')}
              >
                <RaidArrays raid={raid} cluster={cluster} actions={(prefix) => <SilenceButton hostId={host.id} alerts={alertsOf(prefix)} canManage={canManage} />} />
              </SummaryRow>
            )}

            {smartDisks.length > 0 && (
              <SummaryRow
                id="smart" icon={Thermometer} label="SMART" sub={smartSub} tone={smartTone}
                head={`${smartSound}/${smartDisks.length}`}
                mini={
                  <span className="flex items-center gap-1">
                    {smartDisks.map((d, i) => <span key={d.device} title={d.model || d.device} className={clsx('h-2.5 w-2.5 rounded-[3px]', toneBg[smartTones[i]])} />)}
                  </span>
                }
                open={!!openRows.smart} onToggle={() => toggleRow('smart')}
              >
                <div className="grid gap-2 @md:grid-cols-2">
                  {smartDisks.map((d) => (
                    <div key={d.device} className="min-w-0 rounded-md border border-line bg-panel px-3 py-2 text-xs">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate font-medium text-zinc-100" title={d.device}>{d.model || d.device}</span>
                        {d.healthy === undefined ? <Badge>SMART inconnu</Badge> : <Badge tone={d.healthy ? 'ok' : 'bad'}>{d.healthy ? 'Sain' : 'Échec SMART'}</Badge>}
                        {d.standby && <Badge tone="info">En veille</Badge>}
                        {d.temperatureC !== undefined && <span className="text-zinc-300" title={d.standby ? 'Dernière mesure connue' : undefined}>{d.temperatureC} °C</span>}
                        {d.reallocated !== undefined && <span className="text-zinc-300">{d.reallocated} réalloués</span>}
                        {d.nvmeWearPercent !== undefined && <span className="text-zinc-300">Usure {d.nvmeWearPercent} %</span>}
                        <span className="ml-auto"><SilenceButton hostId={host.id} alerts={alertsOf(`smart:${d.device}`)} canManage={canManage} /></span>
                      </div>
                      {d.error && <p className="mt-1 text-amber-300">{d.error}</p>}
                    </div>
                  ))}
                </div>
              </SummaryRow>
            )}
          </div>
        </div>
      </div>
      <HealthDetailModal
        open={chartOpen}
        onClose={() => setChartOpen(false)}
        hostName={host.name}
        cluster={cluster}
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
