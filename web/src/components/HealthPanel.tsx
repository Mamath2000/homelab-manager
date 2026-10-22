import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ChartLine, HardDrive, Thermometer } from 'lucide-react';
import { api, visibleHealthVolumes, type HealthSystem, type Host } from '../lib/api';
import { formatBytes } from '../lib/backups';
import { dateTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { HealthDetailModal } from './HealthDetailModal';
import { Badge, Button, Checkbox, Panel } from './ui';

function Percent({ value, tone = 'emerald', warning, alert, durationMinutes }: { value: number; tone?: 'emerald' | 'sky' | 'amber'; warning?: number; alert?: number; durationMinutes?: number }) {
  const colors = { emerald: 'bg-emerald-400', sky: 'bg-sky-400', amber: 'bg-amber-400' };
  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="relative h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-black/30">
          <div className={`h-full ${colors[tone]}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
          {warning !== undefined && <span className="absolute -top-0.5 h-2.5 w-px bg-amber-300" style={{ left: `${warning}%` }} title={`Warning ${warning}% · ${durationMinutes ?? 0} min`} />}
          {alert !== undefined && <span className="absolute -top-0.5 h-2.5 w-px bg-red-400" style={{ left: `${alert}%` }} title={`Alerte ${alert}% · ${durationMinutes ?? 0} min`} />}
        </div>
        <span className="w-12 text-right font-mono text-xs">{value.toFixed(1)} %</span>
      </div>
      {warning !== undefined && alert !== undefined && <div className="mt-1 flex flex-wrap justify-between gap-x-2 pl-1 text-[10px] text-muted"><span>Warning {warning}%</span><span>Alerte {alert}%</span><span>{durationMinutes ? `après ${durationMinutes} min` : 'immédiat'}</span></div>}
    </div>
  );
}

export function HealthPanel({ host, canManage }: { host: Host; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
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
  const selected = useMemo(() => new Set(devices.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean)), [devices]);
  const scan = useMutation({
    mutationFn: () => api.hostSmartCandidates(host.id),
    onError: (err: Error) => toast.error(err.message),
  });
  const toggleDevice = (device: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(device); else next.delete(device);
    setDevices([...next].join(', '));
  };
  const health = host.health;
  const system = health?.system;
  const disk = health?.disks;
  const visibleVolumes = visibleHealthVolumes(disk?.volumes ?? []);
  const smart = health?.smart;
  const virtualization = host.info?.virt.trim().toLowerCase();
  const noDisks = virtualization === 'wsl';
  const virtualized = !!virtualization && virtualization !== 'none' && virtualization !== 'unknown';

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
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-zinc-100">CPU et mémoire</h3>
            <Button size="sm" variant="ghost" title="Afficher le graphique CPU et mémoire" aria-label="Afficher le graphique CPU et mémoire" onClick={() => setChartOpen(true)}><ChartLine className="h-4 w-4" /></Button>
          </div>
          {isError && <p className="mt-2 text-xs text-amber-300">Historique indisponible : {error.message}</p>}
          {system ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div><p className="mb-1 text-xs text-muted">CPU</p><Percent value={system.cpuPercent} warning={settings?.cpuWarningThreshold} alert={settings?.cpuAlertThreshold} durationMinutes={settings?.systemSustainedMinutes} /></div>
              <div><p className="mb-1 text-xs text-muted">Mémoire · {formatBytes(system.memUsed)} / {formatBytes(system.memTotal)}</p><Percent value={system.memPercent} tone="sky" warning={settings?.memoryWarningThreshold} alert={settings?.memoryAlertThreshold} durationMinutes={settings?.systemSustainedMinutes} /></div>
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
                    <Percent value={v.percent} tone="amber" warning={settings?.diskWarningThreshold} alert={settings?.diskAlertThreshold} />
                  </div>
                ))}
              </div>
            )}
          </section>)}

        {host.capabilities.includes('health') && !virtualized && !host.capabilities.includes('smart') && (
          <section className="border-t border-line pt-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-100"><Thermometer className="h-4 w-4 text-violet-300" />SMART · smartmontools requis</h3>
            <p className="mb-2 text-xs text-muted">L'agent ne trouve pas <span className="font-mono">smartctl</span>. Installe smartmontools sur l'hôte (en administrateur), puis attends la prochaine connexion de l'agent ou actualise l'hôte.</p>
            <pre className="overflow-x-auto rounded-md border border-line bg-black/30 px-3 py-2 font-mono text-xs text-zinc-200">{host.osFamily === 'windows'
              ? 'winget install smartmontools\n# ou l\'installeur officiel : https://www.smartmontools.org/wiki/Download'
              : 'apt install smartmontools'}</pre>
          </section>
        )}

        {host.capabilities.includes('smart') && !virtualized && (
          <section className="border-t border-line pt-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-100"><Thermometer className="h-4 w-4 text-violet-300" />SMART · configuré pour cet hôte</h3>
            {canManage && (
              <div className="mb-3 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <input
                    className="input min-w-48 flex-1"
                    aria-label="Disques physiques SMART"
                    placeholder="/dev/sda, /dev/nvme0"
                    value={devices}
                    onChange={(event) => setDevices(event.target.value)}
                  />
                  <Button size="sm" variant="ghost" loading={scan.isPending} disabled={!host.online} onClick={() => scan.mutate()}>Détecter les disques</Button>
                  <Button size="sm" loading={saveSmart.isPending} disabled={!host.online} onClick={() => saveSmart.mutate()}>Enregistrer</Button>
                </div>
                {scan.data && (!scan.data.candidates.length ? <p className="text-xs text-muted">Aucun disque détecté par smartctl.</p> : (
                  <ul className="divide-y divide-line rounded-md border border-line">
                    {scan.data.candidates.map((c) => (
                      <li key={c.device} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                        <Checkbox label={c.device} checked={selected.has(c.device)} onChange={(on) => toggleDevice(c.device, on)} />
                        <span className="font-mono text-zinc-100">{c.device}</span>
                        <span className="min-w-0 flex-1 truncate text-muted">{c.model ?? 'modèle inconnu'}</span>
                        {c.protocol && <Badge>{c.protocol}</Badge>}
                        {!!c.sizeBytes && <span className="text-muted">{formatBytes(c.sizeBytes)}</span>}
                      </li>
                    ))}
                  </ul>
                ))}
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
      />
    </Panel>
  );
}
