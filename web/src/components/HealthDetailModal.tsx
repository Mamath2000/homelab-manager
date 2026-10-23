import { useState, type ReactNode } from 'react';
import { ChartLine, HardDrive, Layers, Thermometer } from 'lucide-react';
import { formatBytes } from '../lib/backups';
import { hasHealthRaid, visibleHealthVolumes, type HealthSettings, type HealthSnapshot, type HealthSystem } from '../lib/api';
import { dateTime } from '../lib/format';
import { RaidArrays } from './RaidArrays';
import { Badge, Modal } from './ui';

type Sample = { sampledAt: string; report: HealthSystem };

function MetricChart({ samples, settings, field, label, color, warning, alert }: {
  samples: Sample[];
  settings?: HealthSettings;
  field: 'cpuPercent' | 'memPercent';
  label: string;
  color: string;
  warning?: number;
  alert?: number;
}) {
  const [hover, setHover] = useState<{ index: number; x: number } | null>(null);
  if (samples.length < 2) return <div className="flex h-64 items-center justify-center text-sm text-muted">En attente de mesures.</div>;

  const plot = { left: 44, right: 480, top: 20, bottom: 268 };
  const firstAt = new Date(samples[0].sampledAt).getTime();
  const lastAt = new Date(samples[samples.length - 1].sampledAt).getTime();
  const span = Math.max(1, lastAt - firstAt);
  const x = (time: number) => plot.left + ((time - firstAt) / span) * (plot.right - plot.left);
  const y = (value: number) => plot.bottom - (Math.max(0, Math.min(100, value)) / 100) * (plot.bottom - plot.top);
  const points = samples.map((sample) => `${x(new Date(sample.sampledAt).getTime())},${y(sample.report[field])}`).join(' ');
  const current = samples[samples.length - 1];
  const hovered = hover ? samples[hover.index] : null;
  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - bounds.left) / bounds.width) * 500;
    const ratio = Math.max(0, Math.min(1, (svgX - plot.left) / (plot.right - plot.left)));
    const pointerTime = firstAt + ratio * span;
    let index = 0;
    for (let i = 1; i < samples.length; i++) {
      if (Math.abs(new Date(samples[i].sampledAt).getTime() - pointerTime) < Math.abs(new Date(samples[index].sampledAt).getTime() - pointerTime)) index = i;
    }
    setHover({ index, x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) });
  };
  return (
    <div className="min-w-0 rounded-md border border-line bg-raised/20 p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium" style={{ color }}>{label}</span>
        <span className="font-mono text-sm text-zinc-100">{current.report[field].toFixed(1)} %</span>
      </div>
      <div className="relative">
      {hovered && hover && <div className="pointer-events-none absolute top-2 z-10 min-w-32 rounded-md border border-line bg-panel/95 px-2.5 py-2 text-xs shadow-lg" style={{ left: `${Math.min(hover.x * 100, 72)}%` }}>
        <strong className="mb-1 block text-zinc-100">{dateTime(hovered.sampledAt)}</strong>
        <span className="text-muted">{label}</span><span className="ml-2 font-mono text-zinc-100">{hovered.report[field].toFixed(1)} %</span>
      </div>}
      <svg
        viewBox="0 0 500 300"
        role="img"
        aria-label={`Historique ${label} avec seuils`}
        className="h-[min(48vh,22rem)] min-h-56 w-full touch-none"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHover(null)}
      >
        {[0, 25, 50, 75, 100].map((value) => (
          <g key={value}>
            <line x1={plot.left} x2={plot.right} y1={y(value)} y2={y(value)} stroke="currentColor" className="text-line" strokeDasharray={value === 0 ? undefined : '4 6'} />
            <text x="4" y={y(value) + 4} fill="currentColor" className="text-muted" fontSize="12">{value}%</text>
          </g>
        ))}
        {warning !== undefined && <line x1={plot.left} x2={plot.right} y1={y(warning)} y2={y(warning)} stroke="#fbbf24" strokeWidth="1.25" strokeDasharray="8 5" opacity="0.8" />}
        {alert !== undefined && <line x1={plot.left} x2={plot.right} y1={y(alert)} y2={y(alert)} stroke="#f87171" strokeWidth="1.25" strokeDasharray="8 5" opacity="0.8" />}
        <polyline points={points} fill="none" stroke={color} strokeWidth="3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {hovered && hover && <>
          <line x1={x(new Date(hovered.sampledAt).getTime())} x2={x(new Date(hovered.sampledAt).getTime())} y1={plot.top} y2={plot.bottom} stroke="currentColor" className="text-zinc-400" strokeDasharray="3 4" />
          <circle cx={x(new Date(hovered.sampledAt).getTime())} cy={y(hovered.report[field])} r="4" fill={color} stroke="#18181b" strokeWidth="2" />
        </>}
      </svg>
      </div>
      <div className="ml-11 mr-1 flex justify-between text-[10px] text-muted">
        <span>{dateTime(firstAt)}</span><span>{dateTime(lastAt)}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        {warning !== undefined && <span className="text-amber-300">┄ Warning {warning}%</span>}
        {alert !== undefined && <span className="text-red-300">┄ Alerte {alert}%</span>}
        <span className="ml-auto text-muted">{samples.length} mesures · {settings?.systemIntervalSeconds ?? 30} s</span>
      </div>
    </div>
  );
}

export function HealthDetailModal({ open, onClose, hostName, cluster, health, samples, settings, historyError, virtualized = false, noDisks = false, smartSetup }: {
  open: boolean;
  onClose: () => void;
  hostName: string;
  cluster?: string; // corosync cluster of a Proxmox node, shown with its Ceph state
  health?: HealthSnapshot | null;
  samples: Sample[];
  settings?: HealthSettings;
  historyError?: string;
  virtualized?: boolean;
  noDisks?: boolean;
  smartSetup?: ReactNode;
}) {
  const system = health?.system;
  const volumes = visibleHealthVolumes(health?.disks?.volumes ?? []);
  const smartDisks = health?.smart?.disks ?? [];
  const raid = health?.raid;
  const raidCount = raid ? raid.arrays.length + (raid.unraid ? 1 : 0) + (raid.ceph ? 1 : 0) : 0;
  return (
    <Modal open={open} onClose={onClose} title={`Détail Santé · ${hostName}`} wide="screen-wide" scroll>
      <div className="space-y-5">
        <section>
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-100"><ChartLine className="h-4 w-4 text-emerald-300" />CPU et mémoire · dernière heure</div>
          <div className="grid gap-3 lg:grid-cols-2">
            <MetricChart samples={samples} settings={settings} field="cpuPercent" label="CPU" color="#34d399" warning={settings?.cpuWarningThreshold} alert={settings?.cpuAlertThreshold} />
            <MetricChart samples={samples} settings={settings} field="memPercent" label="Mémoire" color="#38bdf8" warning={settings?.memoryWarningThreshold} alert={settings?.memoryAlertThreshold} />
          </div>
          {settings && <p className="mt-2 text-right text-[11px] text-muted">Seuils maintenus {settings.systemSustainedMinutes ? `${settings.systemSustainedMinutes} min` : 'sans temporisation'} · collecte toutes les {settings.systemIntervalSeconds} s</p>}
          {historyError && <p className="mt-2 text-xs text-amber-300">Historique indisponible : {historyError}</p>}
        </section>

        {system && (
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-md border border-line bg-raised/20 p-3">
              <p className="text-xs text-muted">CPU actuel</p><p className="mt-1 font-mono text-lg text-emerald-300">{system.cpuPercent.toFixed(1)} %</p>
            </div>
            <div className="rounded-md border border-line bg-raised/20 p-3">
              <p className="text-xs text-muted">Mémoire utilisée</p><p className="mt-1 font-mono text-lg text-sky-300">{system.memPercent.toFixed(1)} %</p><p className="text-[11px] text-muted">{formatBytes(system.memUsed)} / {formatBytes(system.memTotal)}</p>
            </div>
            {system.load1 !== undefined && (
              <div className="rounded-md border border-line bg-raised/20 p-3">
                <p className="text-xs text-muted">Charge Unix · 1 / 5 / 15 min</p><p className="mt-1 flex flex-wrap gap-2 font-mono text-lg">{[system.load1, system.load5, system.load15].map((load, index) => load !== undefined && <span key={index} className={load > 1 ? 'text-red-400' : 'text-zinc-200'}>{load.toFixed(2)}</span>)}</p>
              </div>
            )}
            <div className="rounded-md border border-line bg-raised/20 p-3">
              <p className="text-xs text-muted">Dernière mesure</p><p className="mt-1 text-sm text-zinc-200">{dateTime(system.checkedAt)}</p>
            </div>
          </section>
        )}

        {!noDisks && <section>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-100"><HardDrive className="h-4 w-4 text-amber-300" />Volumes ({volumes.length})</h3>
          {settings && <p className="mb-3 text-xs text-muted">Warning {settings.diskWarningThreshold}% · alerte {settings.diskAlertThreshold}% · déclenchement immédiat</p>}
          {!volumes.length ? <p className="rounded-md border border-line p-4 text-sm text-muted">Aucune mesure de volume disponible.</p> : (
            <div className="grid gap-3 lg:grid-cols-2">
              {volumes.map((volume) => (
                <div key={`${volume.device}:${volume.mountpoint}`} className="rounded-md border border-line bg-raised/20 p-3">
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div className="min-w-0"><p className="truncate text-sm font-medium text-zinc-100" title={volume.mountpoint}>{volume.mountpoint}</p><p className="truncate font-mono text-[11px] text-muted" title={volume.device}>{volume.device} · {volume.fstype}</p></div>
                    <span className={`font-mono text-sm ${volume.percent >= (settings?.diskAlertThreshold ?? 90) ? 'text-red-300' : volume.percent >= (settings?.diskWarningThreshold ?? 75) ? 'text-amber-300' : 'text-zinc-200'}`}>{volume.percent.toFixed(1)}%</span>
                  </div>
                  <div className="relative h-2 overflow-hidden rounded-full bg-black/30">
                    <div className={`h-full ${volume.percent >= (settings?.diskAlertThreshold ?? 90) ? 'bg-red-400' : volume.percent >= (settings?.diskWarningThreshold ?? 75) ? 'bg-amber-400' : 'bg-emerald-400'}`} style={{ width: `${Math.min(100, volume.percent)}%` }} />
                    <span className="absolute inset-y-0 w-px bg-amber-200" style={{ left: `${settings?.diskWarningThreshold ?? 75}%` }} />
                    <span className="absolute inset-y-0 w-px bg-red-200" style={{ left: `${settings?.diskAlertThreshold ?? 90}%` }} />
                  </div>
                  <p className="mt-1 text-right text-[11px] text-muted">{formatBytes(volume.used)} utilisés / {formatBytes(volume.total)}</p>
                </div>
              ))}
            </div>
          )}
        </section>}

        {hasHealthRaid(raid) && <section>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-100"><Layers className="h-4 w-4 text-sky-300" />RAID ({raidCount})</h3>
          <p className="mb-3 text-xs text-muted">Alerte : array dégradé ou arrêté, disque en échec ou émulé, disque de pool manquant, erreurs de parité, Ceph HEALTH_ERR, OSD down ou Ceph injoignable · warning : reconstruction ou resynchro en cours, incohérences après contrôle, erreurs de disque (à chaque nouvelle valeur), contrôle de parité interrompu, Ceph HEALTH_WARN, OSD out · le contrôle périodique n'alerte pas · déclenchement immédiat</p>
          <RaidArrays raid={raid} cluster={cluster} />
        </section>}

        {!virtualized && <section>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-100"><Thermometer className="h-4 w-4 text-violet-300" />Disques SMART ({smartDisks.length})</h3>
          {smartSetup}
          {settings && <p className="mb-3 text-xs text-muted">Température : warning {settings.smartTemperatureWarningThreshold} °C / alerte {settings.smartTemperatureAlertThreshold} °C · usure NVMe : warning {settings.smartWearWarningThreshold}% / alerte {settings.smartWearAlertThreshold}% · {settings.smartSustainedMinutes ? `durée ${settings.smartSustainedMinutes} min` : 'déclenchement immédiat'}</p>}
          {!smartDisks.length ? <p className="rounded-md border border-line p-4 text-sm text-muted">Aucune mesure SMART disponible ou aucun disque configuré.</p> : (
            <div className="grid gap-3 lg:grid-cols-2">
              {smartDisks.map((disk) => (
                <div key={disk.device} className="rounded-md border border-line bg-raised/20 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-zinc-100">{disk.device}</span>
                    {disk.model && <span className="text-xs text-muted">{disk.model}</span>}
                    {disk.healthy !== undefined && <Badge tone={disk.healthy ? 'ok' : 'bad'}>{disk.healthy ? 'Sain' : 'Échec SMART'}</Badge>}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted">
                    {disk.temperatureC !== undefined && <span>Température <b className="text-zinc-200">{disk.temperatureC} °C</b></span>}
                    {disk.nvmeWearPercent !== undefined && <span>Usure NVMe <b className="text-zinc-200">{disk.nvmeWearPercent} %</b></span>}
                    {disk.reallocated !== undefined && <span>Secteurs réalloués <b className="text-zinc-200">{disk.reallocated}</b></span>}
                    {disk.serial && <span className="truncate" title={disk.serial}>Série <b className="font-mono text-zinc-200">{disk.serial}</b></span>}
                  </div>
                  {disk.error && <p className="mt-2 text-xs text-amber-300">{disk.error}</p>}
                </div>
              ))}
            </div>
          )}
        </section>}
      </div>
    </Modal>
  );
}
