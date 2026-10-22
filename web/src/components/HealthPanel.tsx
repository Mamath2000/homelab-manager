import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, HardDrive, Thermometer } from 'lucide-react';
import { api, type HealthSystem, type Host } from '../lib/api';
import { formatBytes } from '../lib/backups';
import { dateTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { Badge, Button, Panel } from './ui';

function Percent({ value, tone = 'emerald' }: { value: number; tone?: 'emerald' | 'sky' | 'amber' }) {
  const colors = { emerald: 'bg-emerald-400', sky: 'bg-sky-400', amber: 'bg-amber-400' };
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-black/30">
        <div className={`h-full ${colors[tone]}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span className="w-12 text-right font-mono text-xs">{value.toFixed(1)} %</span>
    </div>
  );
}

function SystemChart({ samples }: { samples: { sampledAt: string; report: HealthSystem }[] }) {
  if (samples.length < 2) return <p className="py-10 text-center text-sm text-muted">La courbe se dessine à mesure que les mesures arrivent.</p>;
  const points = (field: 'cpuPercent' | 'memPercent') => samples.map(({ report }, i) => {
    const x = (i / (samples.length - 1)) * 600;
    const y = 130 - (Math.max(0, Math.min(100, report[field])) / 100) * 120;
    return `${x},${y}`;
  }).join(' ');
  const current = samples[samples.length - 1];
  return (
    <div>
      <svg viewBox="0 0 600 140" role="img" aria-label="Charge CPU et mémoire de la dernière heure" className="h-36 w-full overflow-visible">
        {[0, 25, 50, 75, 100].map((v) => {
          const y = 130 - v * 1.2;
          return <g key={v}><line x1="0" x2="600" y1={y} y2={y} stroke="currentColor" className="text-line" strokeDasharray={v === 0 ? undefined : '3 5'} /><text x="0" y={y - 3} fill="currentColor" className="text-muted" fontSize="9">{v}</text></g>;
        })}
        <polyline points={points('cpuPercent')} fill="none" stroke="#34d399" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        <polyline points={points('memPercent')} fill="none" stroke="#38bdf8" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[10px] text-muted">
        <span>{dateTime(Number(new Date(samples[0].sampledAt)))}</span><span>{dateTime(Number(new Date(current.sampledAt)))}</span>
      </div>
      <div className="mt-2 flex gap-4 text-xs">
        <span className="flex items-center gap-1.5 text-emerald-300"><i className="h-2 w-2 rounded-full bg-emerald-400" />CPU</span>
        <span className="flex items-center gap-1.5 text-sky-300"><i className="h-2 w-2 rounded-full bg-sky-400" />Mémoire</span>
      </div>
    </div>
  );
}

export function HealthPanel({ host, canManage }: { host: Host; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isError, error } = useQuery({
    queryKey: ['health', host.id],
    queryFn: () => api.hostHealth(host.id, 1),
    refetchInterval: 30_000,
  });
  const systemSamples = useMemo(
    () => (data?.samples ?? []).filter((s): s is typeof s & { report: HealthSystem } => s.category === 'system'),
    [data],
  );
  const [devices, setDevices] = useState(host.smartDevices.join(', '));
  const saveSmart = useMutation({
    mutationFn: () => api.saveHostSmartDevices(host.id, [...new Set(devices.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean))]),
    onSuccess: async ({ devices: saved }) => {
      await qc.invalidateQueries({ queryKey: ['hosts'] });
      setDevices(saved.join(', '));
      toast.success('Disques SMART configurés');
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const health = host.health;
  const system = health?.system;
  const disk = health?.disks;
  const smart = health?.smart;

  return (
    <Panel title="Santé" icon={Activity} actions={system && <span className="text-xs text-muted">Mesures : {dateTime(system.checkedAt)}</span>}>
      <div className="space-y-4 p-4">
        {health?.alerts?.length ? (
          <ul className="space-y-1.5">
            {health.alerts.map((alert) => (
              <li key={alert.key} className="flex items-start gap-2 text-sm">
                <Badge tone={alert.level === 'alert' ? 'bad' : 'warn'}>{alert.level === 'alert' ? 'Alerte' : 'Seuil'}</Badge>
                <span className="text-zinc-200">{alert.reason}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-emerald-300">Aucune alerte de santé active.</p>}

        <section className="rounded-md border border-line bg-raised/20 p-3">
          <h3 className="mb-3 text-sm font-medium text-zinc-100">CPU et mémoire · dernière heure</h3>
          <SystemChart samples={systemSamples} />
          {isError && <p className="mt-2 text-xs text-amber-300">Historique indisponible : {error.message}</p>}
          {system ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div><p className="mb-1 text-xs text-muted">CPU</p><Percent value={system.cpuPercent} /></div>
              <div><p className="mb-1 text-xs text-muted">Mémoire · {formatBytes(system.memUsed)} / {formatBytes(system.memTotal)}</p><Percent value={system.memPercent} tone="sky" /></div>
              {system.load1 !== undefined && (
                <p className="text-xs text-muted sm:col-span-2">
                  Charge Unix : <span className="font-mono text-zinc-300">{system.load1.toFixed(2)} / {system.load5?.toFixed(2)} / {system.load15?.toFixed(2)}</span>
                  <span className="ml-1">(1 / 5 / 15 min)</span>
                </p>
              )}
            </div>
          ) : <p className="text-sm text-muted">En attente de la première mesure de l'agent.</p>}
        </section>

        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-100"><HardDrive className="h-4 w-4 text-amber-300" />Volumes</h3>
          {!disk?.volumes.length ? <p className="text-sm text-muted">Pas de volume remonté pour le moment.</p> : (
            <div className="space-y-3">
              {disk.volumes.map((v) => (
                <div key={`${v.device}:${v.mountpoint}`} className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(180px,1fr)] sm:items-center">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-zinc-200" title={v.mountpoint}>{v.mountpoint}</p>
                    <p className="truncate font-mono text-[10px] text-muted" title={v.device}>{v.device} · {v.fstype} · {formatBytes(v.used)} / {formatBytes(v.total)}</p>
                  </div>
                  <Percent value={v.percent} tone="amber" />
                </div>
              ))}
            </div>
          )}
        </section>

        {host.capabilities.includes('smart') && (
          <section className="border-t border-line pt-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-100"><Thermometer className="h-4 w-4 text-violet-300" />SMART · configuré pour cet hôte</h3>
            {canManage && (
              <div className="mb-3 flex flex-wrap gap-2">
                <input
                  className="input min-w-48 flex-1"
                  aria-label="Disques physiques SMART"
                  placeholder="/dev/sda, /dev/nvme0"
                  value={devices}
                  onChange={(event) => setDevices(event.target.value)}
                />
                <Button size="sm" loading={saveSmart.isPending} disabled={!host.online} onClick={() => saveSmart.mutate()}>Enregistrer</Button>
              </div>
            )}
            {!host.smartDevices.length ? <p className="text-xs text-muted">Aucun périphérique sélectionné. Les disques virtualisés ne doivent pas être ajoutés.</p> : !smart?.disks.length ? <p className="text-xs text-muted">En attente de la prochaine collecte SMART.</p> : (
              <div className="space-y-2">
                {smart.disks.map((d) => (
                  <div key={d.device} className="rounded-md border border-line bg-raised/20 px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-zinc-100">{d.device}</span>
                      {d.model && <span className="text-muted">{d.model}</span>}
                      {d.healthy === undefined ? <Badge>SMART inconnu</Badge> : <Badge tone={d.healthy ? 'ok' : 'bad'}>{d.healthy ? 'Sain' : 'Échec SMART'}</Badge>}
                      {d.temperatureC !== undefined && <span className="text-zinc-300">{d.temperatureC} °C</span>}
                      {d.reallocated !== undefined && <span className="text-zinc-300">{d.reallocated} secteurs réalloués</span>}
                      {d.nvmeWearPercent !== undefined && <span className="text-zinc-300">Usure NVMe : {d.nvmeWearPercent} %</span>}
                    </div>
                    {d.error && <p className="mt-1 text-amber-300">{d.error}</p>}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </Panel>
  );
}
