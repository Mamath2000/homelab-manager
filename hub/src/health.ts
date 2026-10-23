import { ObjectId } from 'mongodb';
import type { FastifyInstance } from 'fastify';
import { healthMetrics, hosts, settings } from './db.js';
import type { HealthDisks, HealthMetricDoc, HealthSettings, HealthSmart, HealthSystem, HealthVolume, HealthSmartDisk, HostDoc } from './types.js';
import { parseId } from './db.js';
import { isOnline, sendToAgent } from './agents.js';
import { healthWithSilenced } from './healthSilence.js';
import { hostDto } from './hostDto.js';
import { publish } from './events.js';

export const DEFAULT_HEALTH_SETTINGS: HealthSettings = {
  _id: 'health',
  systemIntervalSeconds: 30,
  diskIntervalSeconds: 5 * 60,
  smartIntervalSeconds: 7 * 24 * 3600,
  retentionHours: 48,
  cpuWarningThreshold: 75,
  cpuAlertThreshold: 90,
  memoryWarningThreshold: 80,
  memoryAlertThreshold: 90,
  diskWarningThreshold: 75,
  diskAlertThreshold: 90,
  smartTemperatureWarningThreshold: 60,
  smartTemperatureAlertThreshold: 70,
  smartWearWarningThreshold: 70,
  smartWearAlertThreshold: 85,
  systemSustainedMinutes: 5,
  smartSustainedMinutes: 0,
};

export async function loadHealthSettings(): Promise<HealthSettings> {
  const stored = (await settings.findOne({ _id: 'health' })) as (Partial<HealthSettings> & Record<string, unknown>) | null;
  const legacyNumber = (key: string) => typeof stored?.[key] === 'number' ? stored[key] as number : undefined;
  const legacyAlert = (key: string, fallback: number) => Math.max(2, legacyNumber(key) ?? fallback);
  return {
    ...DEFAULT_HEALTH_SETTINGS,
    ...stored,
    cpuWarningThreshold: stored?.cpuWarningThreshold ?? Math.min(DEFAULT_HEALTH_SETTINGS.cpuWarningThreshold, legacyAlert('cpuThreshold', DEFAULT_HEALTH_SETTINGS.cpuAlertThreshold) - 1),
    cpuAlertThreshold: stored?.cpuAlertThreshold ?? legacyAlert('cpuThreshold', DEFAULT_HEALTH_SETTINGS.cpuAlertThreshold),
    memoryWarningThreshold: stored?.memoryWarningThreshold ?? Math.min(DEFAULT_HEALTH_SETTINGS.memoryWarningThreshold, legacyAlert('memoryThreshold', DEFAULT_HEALTH_SETTINGS.memoryAlertThreshold) - 1),
    memoryAlertThreshold: stored?.memoryAlertThreshold ?? legacyAlert('memoryThreshold', DEFAULT_HEALTH_SETTINGS.memoryAlertThreshold),
    diskWarningThreshold: stored?.diskWarningThreshold ?? Math.min(DEFAULT_HEALTH_SETTINGS.diskWarningThreshold, legacyAlert('diskThreshold', DEFAULT_HEALTH_SETTINGS.diskAlertThreshold) - 1),
    diskAlertThreshold: stored?.diskAlertThreshold ?? legacyAlert('diskThreshold', DEFAULT_HEALTH_SETTINGS.diskAlertThreshold),
    smartTemperatureWarningThreshold: stored?.smartTemperatureWarningThreshold ?? Math.min(DEFAULT_HEALTH_SETTINGS.smartTemperatureWarningThreshold, legacyAlert('smartTemperatureThreshold', DEFAULT_HEALTH_SETTINGS.smartTemperatureAlertThreshold) - 1),
    smartTemperatureAlertThreshold: stored?.smartTemperatureAlertThreshold ?? legacyAlert('smartTemperatureThreshold', DEFAULT_HEALTH_SETTINGS.smartTemperatureAlertThreshold),
    smartWearWarningThreshold: stored?.smartWearWarningThreshold ?? Math.min(DEFAULT_HEALTH_SETTINGS.smartWearWarningThreshold, legacyAlert('smartWearThreshold', DEFAULT_HEALTH_SETTINGS.smartWearAlertThreshold) - 1),
    smartWearAlertThreshold: stored?.smartWearAlertThreshold ?? legacyAlert('smartWearThreshold', DEFAULT_HEALTH_SETTINGS.smartWearAlertThreshold),
    systemSustainedMinutes: stored?.systemSustainedMinutes ?? legacyNumber('sustainedMinutes') ?? DEFAULT_HEALTH_SETTINGS.systemSustainedMinutes,
  };
}

export function isVirtualizedHealthHost(host: Pick<HostDoc, 'info'>): boolean {
  const virt = host.info?.virt?.trim().toLowerCase();
  return !!virt && virt !== 'none' && virt !== 'unknown';
}

// WSL shares the Windows disks: its volumes say nothing about the machine, so they are neither kept nor alerted on.
export function hasNoHealthDisks(host: Pick<HostDoc, 'info'>): boolean {
  return host.info?.virt?.trim().toLowerCase() === 'wsl';
}

export async function healthConfigForHost(host: HostDoc) {
  const s = await loadHealthSettings();
  return {
    type: 'health_config',
    healthConfig: {
      systemIntervalSeconds: s.systemIntervalSeconds,
      diskIntervalSeconds: s.diskIntervalSeconds,
      smartIntervalSeconds: s.smartIntervalSeconds,
      smartDevices: isVirtualizedHealthHost(host) ? [] : host.smartDevices ?? [],
    },
  };
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const checkedAt = (v: unknown) => finite(v) && v >= Date.now() - 10 * 60_000 && v <= Date.now() + 60_000;

export function isHealthSystem(v: unknown): v is HealthSystem {
  if (!v || typeof v !== 'object') return false;
  const r = v as HealthSystem;
  return checkedAt(r.checkedAt) && finite(r.cpuPercent) && r.cpuPercent >= 0 && r.cpuPercent <= 100 &&
    finite(r.memPercent) && r.memPercent >= 0 && r.memPercent <= 100 &&
    finite(r.memUsed) && r.memUsed >= 0 && finite(r.memTotal) && r.memTotal > 0 &&
    [r.load1, r.load5, r.load15].every((n) => n === undefined || (finite(n) && n >= 0));
}

function isHealthVolume(v: unknown): v is HealthVolume {
  if (!v || typeof v !== 'object') return false;
  const d = v as HealthVolume;
  return typeof d.device === 'string' && d.device.length <= 512 &&
    typeof d.mountpoint === 'string' && d.mountpoint.length <= 1024 &&
    typeof d.fstype === 'string' && d.fstype.length <= 128 &&
    finite(d.used) && d.used >= 0 && finite(d.total) && d.total > 0 &&
    finite(d.percent) && d.percent >= 0 && d.percent <= 100;
}

export function isHealthDisks(v: unknown): v is HealthDisks {
  if (!v || typeof v !== 'object') return false;
  const r = v as HealthDisks;
  return checkedAt(r.checkedAt) && Array.isArray(r.volumes) && r.volumes.length <= 512 && r.volumes.every(isHealthVolume);
}

function isHealthSmartDisk(v: unknown): v is HealthSmartDisk {
  if (!v || typeof v !== 'object') return false;
  const d = v as HealthSmartDisk;
  return typeof d.device === 'string' && d.device.length <= 512 &&
    (d.model === undefined || (typeof d.model === 'string' && d.model.length <= 256)) &&
    (d.serial === undefined || (typeof d.serial === 'string' && d.serial.length <= 256)) &&
    (d.healthy === undefined || typeof d.healthy === 'boolean') &&
    (d.temperatureC === undefined || (finite(d.temperatureC) && d.temperatureC >= -50 && d.temperatureC <= 250)) &&
    (d.reallocated === undefined || (finite(d.reallocated) && d.reallocated >= 0)) &&
    (d.nvmeWearPercent === undefined || (finite(d.nvmeWearPercent) && d.nvmeWearPercent >= 0 && d.nvmeWearPercent <= 1000)) &&
    (d.error === undefined || (typeof d.error === 'string' && d.error.length <= 1024));
}

export function isHealthSmart(v: unknown): v is HealthSmart {
  if (!v || typeof v !== 'object') return false;
  const r = v as HealthSmart;
  return checkedAt(r.checkedAt) && Array.isArray(r.disks) && r.disks.length <= 32 && r.disks.every(isHealthSmartDisk);
}

type HealthCategory = HealthMetricDoc['category'];
type HealthReport = HealthSystem | HealthDisks | HealthSmart;
const pendingHostWrites = new Map<string, Promise<void>>();

export function healthMetricLevel(
  current: number,
  samples: { checkedAt: number; value: number }[],
  warning: number,
  alert: number,
  durationMinutes: number,
  intervalSeconds: number,
  previous: 'warn' | 'alert' | undefined,
  now = Date.now(),
): 'warn' | 'alert' | undefined {
  const sustained = (threshold: number) => {
    if (durationMinutes === 0) return current >= threshold;
    const intervalMs = intervalSeconds * 1000;
    const cutoff = now - durationMinutes * 60_000;
    if (!samples.length || samples[samples.length - 1].checkedAt < now - intervalMs * 2) return false;
    let start = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].value < threshold) start = i + 1;
    }
    const high = samples.slice(start);
    if (!high.length || high[0].checkedAt > cutoff) return false;
    for (let i = 1; i < high.length; i++) {
      if (high[i].checkedAt - high[i - 1].checkedAt > intervalMs * 2) return false;
    }
    return true;
  };
  if (sustained(alert) || (previous === 'alert' && current >= alert - 5)) return 'alert';
  if (sustained(warning) || (previous === 'warn' && current >= warning - 5)) return 'warn';
  return undefined;
}

function reportAlerts(h: HostDoc, category: HealthCategory, report: HealthReport, settings: HealthSettings, samples: HealthReport[] = []) {
  const old = h.health?.alerts ?? [];
  const retained = old.filter((a) => !a.key.startsWith(`${category}:`));
  const next: NonNullable<HostDoc['health']>['alerts'] = [];
  const alert = (key: string, label: string, reason: string, level: 'warn' | 'alert' = 'warn') => next.push({ key: `${category}:${key}`, label, level, reason });

  if (category === 'system') {
    const r = report as HealthSystem;
    const previous = (key: string) => old.find((a) => a.key === `system:${key}`)?.level;
    const addSystemMetric = (key: 'cpu' | 'memory', label: string, field: 'cpuPercent' | 'memPercent', value: number, warning: number, critical: number) => {
      const level = healthMetricLevel(
        value,
        samples.filter((sample): sample is HealthSystem => 'cpuPercent' in sample).map((sample) => ({ checkedAt: sample.checkedAt, value: sample[field] })),
        warning,
        critical,
        settings.systemSustainedMinutes,
        settings.systemIntervalSeconds,
        previous(key),
      );
      if (level) alert(key, label, `${label} à ${value.toFixed(1)} % (warning ${warning} %, alerte ${critical} %, durée ${settings.systemSustainedMinutes} min)`, level);
    };
    addSystemMetric('cpu', 'CPU', 'cpuPercent', r.cpuPercent, settings.cpuWarningThreshold, settings.cpuAlertThreshold);
    addSystemMetric('memory', 'Mémoire', 'memPercent', r.memPercent, settings.memoryWarningThreshold, settings.memoryAlertThreshold);
  } else if (category === 'disks') {
    const previous = new Map(old.map((a) => [a.key, a.level]));
    for (const v of (report as HealthDisks).volumes) {
      const key = `disks:volume:${v.mountpoint}`;
      const values = samples.filter((sample): sample is HealthDisks => 'volumes' in sample)
        .flatMap((sample) => sample.volumes.filter((volume) => volume.mountpoint === v.mountpoint).map((volume) => ({ checkedAt: sample.checkedAt, value: volume.percent })));
      const level = healthMetricLevel(v.percent, values, settings.diskWarningThreshold, settings.diskAlertThreshold, 0, settings.diskIntervalSeconds, previous.get(key));
      if (level) alert(`volume:${v.mountpoint}`, v.mountpoint, `${v.mountpoint} utilisé à ${v.percent.toFixed(1)} % (warning ${settings.diskWarningThreshold} %, alerte ${settings.diskAlertThreshold} %, déclenchement immédiat)`, level);
    }
  } else {
    const previous = new Map(old.map((a) => [a.key, a.level]));
    for (const d of (report as HealthSmart).disks) {
      if (d.healthy === false) alert(`smart:${d.device}:health`, d.device, `${d.device} : état SMART en échec`, 'alert');
      if (d.temperatureC !== undefined) {
        const key = `smart:smart:${d.device}:temperature`;
        const values = samples.filter((sample): sample is HealthSmart => 'disks' in sample)
          .flatMap((sample) => sample.disks.filter((disk) => disk.device === d.device && disk.temperatureC !== undefined).map((disk) => ({ checkedAt: sample.checkedAt, value: disk.temperatureC! })));
        const level = healthMetricLevel(d.temperatureC, values, settings.smartTemperatureWarningThreshold, settings.smartTemperatureAlertThreshold, settings.smartSustainedMinutes, settings.smartIntervalSeconds, previous.get(key));
          if (level) alert(`smart:${d.device}:temperature`, d.device, `${d.device} : température ${d.temperatureC} °C (warning ${settings.smartTemperatureWarningThreshold} °C, alerte ${settings.smartTemperatureAlertThreshold} °C, ${settings.smartSustainedMinutes ? `durée ${settings.smartSustainedMinutes} min` : 'déclenchement immédiat'})`, level);
      }
      if (d.reallocated !== undefined && d.reallocated > 0) alert(`smart:${d.device}:reallocated`, d.device, `${d.device} : ${d.reallocated} secteur(s) réalloué(s)`, 'alert');
      if (d.nvmeWearPercent !== undefined) {
        const key = `smart:smart:${d.device}:wear`;
        const values = samples.filter((sample): sample is HealthSmart => 'disks' in sample)
          .flatMap((sample) => sample.disks.filter((disk) => disk.device === d.device && disk.nvmeWearPercent !== undefined).map((disk) => ({ checkedAt: sample.checkedAt, value: disk.nvmeWearPercent! })));
        const level = healthMetricLevel(d.nvmeWearPercent, values, settings.smartWearWarningThreshold, settings.smartWearAlertThreshold, settings.smartSustainedMinutes, settings.smartIntervalSeconds, previous.get(key));
        if (level) alert(`smart:${d.device}:wear`, d.device, `${d.device} : usure NVMe ${d.nvmeWearPercent} % (warning ${settings.smartWearWarningThreshold} %, alerte ${settings.smartWearAlertThreshold} %, ${settings.smartSustainedMinutes ? `durée ${settings.smartSustainedMinutes} min` : 'déclenchement immédiat'})`, level);
      }
      if (d.error) alert(`smart:${d.device}:error`, d.device, `${d.device} : ${d.error}`);
    }
  }
  return [...retained, ...next];
}

async function persistReport(hostId: ObjectId, category: HealthCategory, report: HealthReport) {
  const sampledAt = new Date(report.checkedAt);
  const host = await hosts.findOne({ _id: hostId });
  if (!host) return;
  if (category === 'disks' && hasNoHealthDisks(host)) {
    await hosts.updateOne({ _id: hostId }, { $unset: { 'health.disks': '' }, $set: { 'health.alerts': (host.health?.alerts ?? []).filter((a) => !a.key.startsWith('disks:')) } });
    return;
  }
  await healthMetrics.insertOne({ hostId, category, sampledAt, report });

  const s = await loadHealthSettings();
  const durationMinutes = category === 'system' ? s.systemSustainedMinutes : category === 'disks' ? 0 : s.smartSustainedMinutes;
  const intervalSeconds = category === 'system' ? s.systemIntervalSeconds : category === 'disks' ? s.diskIntervalSeconds : s.smartIntervalSeconds;
  const since = new Date(Date.now() - durationMinutes * 60_000 - intervalSeconds * 2_000);
  const docs = await healthMetrics.find({ hostId, category, sampledAt: { $gte: since } }).sort({ sampledAt: 1 }).limit(5000).toArray();
  const alerts = reportAlerts(host, category, report, s, docs.map((d) => d.report));
  const field = category === 'system' ? 'health.system' : category === 'disks' ? 'health.disks' : 'health.smart';
  await hosts.updateOne({ _id: hostId }, { $set: { [field]: report, 'health.alerts': alerts } });
}

async function saveReport(hostId: ObjectId, category: HealthCategory, report: HealthReport) {
  const key = hostId.toHexString();
  const previous = pendingHostWrites.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => persistReport(hostId, category, report));
  pendingHostWrites.set(key, next);
  try {
    await next;
  } finally {
    if (pendingHostWrites.get(key) === next) pendingHostWrites.delete(key);
  }
}

export async function receiveHealthReport(hostId: ObjectId, category: HealthCategory, report: unknown) {
  if ((category === 'system' && !isHealthSystem(report)) ||
      (category === 'disks' && !isHealthDisks(report)) ||
      (category === 'smart' && !isHealthSmart(report))) return false;
  await saveReport(hostId, category, report as HealthReport);
  return true;
}

const healthSettingsBody = {
  type: 'object',
  required: [
    'systemIntervalSeconds', 'diskIntervalSeconds', 'smartIntervalSeconds',
    'cpuWarningThreshold', 'cpuAlertThreshold', 'memoryWarningThreshold', 'memoryAlertThreshold',
    'diskWarningThreshold', 'diskAlertThreshold', 'smartTemperatureWarningThreshold', 'smartTemperatureAlertThreshold',
    'smartWearWarningThreshold', 'smartWearAlertThreshold', 'systemSustainedMinutes', 'smartSustainedMinutes',
  ],
  additionalProperties: false,
  properties: {
    systemIntervalSeconds: { type: 'integer', minimum: 10, maximum: 3600 },
    diskIntervalSeconds: { type: 'integer', minimum: 60, maximum: 86400 },
    smartIntervalSeconds: { type: 'integer', minimum: 600, maximum: 2592000 },
    cpuWarningThreshold: { type: 'number', minimum: 1, maximum: 99 },
    cpuAlertThreshold: { type: 'number', minimum: 2, maximum: 100 },
    memoryWarningThreshold: { type: 'number', minimum: 1, maximum: 99 },
    memoryAlertThreshold: { type: 'number', minimum: 2, maximum: 100 },
    diskWarningThreshold: { type: 'number', minimum: 1, maximum: 99 },
    diskAlertThreshold: { type: 'number', minimum: 2, maximum: 100 },
    smartTemperatureWarningThreshold: { type: 'number', minimum: 1, maximum: 149 },
    smartTemperatureAlertThreshold: { type: 'number', minimum: 2, maximum: 150 },
    smartWearWarningThreshold: { type: 'number', minimum: 1, maximum: 999 },
    smartWearAlertThreshold: { type: 'number', minimum: 2, maximum: 1000 },
    systemSustainedMinutes: { type: 'integer', minimum: 0, maximum: 60 },
    smartSustainedMinutes: { type: 'integer', minimum: 0, maximum: 2880 },
  },
} as const;

export function registerHealthRoutes(app: FastifyInstance) {
  app.get('/api/settings/health', loadHealthSettings);
  app.put<{ Body: Omit<HealthSettings, '_id' | 'retentionHours'> }>(
    '/api/settings/health',
    { schema: { body: healthSettingsBody } },
    async (req, reply) => {
      const pairs = [
        [req.body.cpuWarningThreshold, req.body.cpuAlertThreshold],
        [req.body.memoryWarningThreshold, req.body.memoryAlertThreshold],
        [req.body.diskWarningThreshold, req.body.diskAlertThreshold],
        [req.body.smartTemperatureWarningThreshold, req.body.smartTemperatureAlertThreshold],
        [req.body.smartWearWarningThreshold, req.body.smartWearAlertThreshold],
      ];
      if (pairs.some(([warning, alert]) => warning >= alert)) {
        return reply.code(400).send({ error: 'Le seuil warning doit être inférieur au seuil alerte.' });
      }
      const next: HealthSettings = { ...DEFAULT_HEALTH_SETTINGS, ...req.body, retentionHours: 48 };
      await settings.replaceOne({ _id: 'health' }, next, { upsert: true });
      for (const host of await hosts.find({}).toArray()) {
        if (host.capabilities?.includes('health')) sendToAgent(host._id.toHexString(), await healthConfigForHost(host));
      }
      return next;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { hours?: string } }>('/api/hosts/:id/health', async (req, reply) => {
    const hostId = parseId(req.params.id);
    if (!hostId || !(await hosts.countDocuments({ _id: hostId }, { limit: 1 }))) return reply.code(404).send({ error: 'host not found' });
    const hours = Math.min(24, Math.max(1, Number(req.query.hours) || 1));
    const samples = await healthMetrics.find({ hostId, sampledAt: { $gte: new Date(Date.now() - hours * 3600_000) } })
      .sort({ sampledAt: 1 }).limit(10_000).toArray();
    return { samples };
  });

  app.get('/api/health/overview', async () => {
    const list = await hosts.find({}).sort({ name: 1 }).toArray();
    const hostIds = list.map((h) => h._id);
    const samples = hostIds.length
      ? await healthMetrics.find({ hostId: { $in: hostIds }, category: 'system', sampledAt: { $gte: new Date(Date.now() - 3600_000) } })
        .sort({ sampledAt: 1 }).limit(20_000).toArray()
      : [];
    const byHost = new Map<string, typeof samples>();
    for (const sample of samples) {
      const key = sample.hostId.toHexString();
      byHost.set(key, [...(byHost.get(key) ?? []), sample]);
    }
    return {
      hosts: list.map((host) => ({
        id: host._id.toHexString(),
        name: host.name,
        online: isOnline(host._id.toHexString()),
        supported: host.capabilities?.includes('health') ?? false,
        virtualized: isVirtualizedHealthHost(host),
        noDisks: hasNoHealthDisks(host),
        health: healthWithSilenced(host.health, host.healthSilenced),
        samples: (byHost.get(host._id.toHexString()) ?? []).map(({ sampledAt, report }) => ({ sampledAt, report })),
      })),
    };
  });

  // Accept ("silence") or watch again alerts of a host: they stop counting for its state, the bars keep their colours.
  app.put<{ Params: { id: string }; Body: { keys: string[]; silenced: boolean } }>(
    '/api/hosts/:id/health/silenced',
    {
      schema: {
        body: {
          type: 'object',
          required: ['keys', 'silenced'],
          additionalProperties: false,
          properties: {
            keys: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 512 } },
            silenced: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const hostId = parseId(req.params.id);
      const host = hostId && (await hosts.findOne({ _id: hostId }, { projection: { health: 1, healthSilenced: 1 } }));
      if (!host) return reply.code(404).send({ error: 'host not found' });
      const current = new Map((host.health?.alerts ?? []).map((a) => [a.key, a.level]));
      const keys = new Set(req.body.keys);
      let next = (host.healthSilenced ?? []).filter((s) => !keys.has(s.key));
      if (req.body.silenced) {
        const unknown = req.body.keys.filter((k) => !current.has(k));
        if (unknown.length) return reply.code(409).send({ error: `alerte inactive : ${unknown.join(', ')}` });
        next = [...next, ...req.body.keys.map((key) => ({ key, level: current.get(key)! }))];
      }
      const updated = await hosts.findOneAndUpdate({ _id: hostId }, { $set: { healthSilenced: next } }, { returnDocument: 'after' });
      if (updated) publish('host', hostDto(updated));
      return { healthSilenced: next };
    },
  );

  app.put<{ Params: { id: string }; Body: { devices: string[] } }>(
    '/api/hosts/:id/health/smart',
    {
      schema: {
        body: {
          type: 'object',
          required: ['devices'],
          additionalProperties: false,
          properties: { devices: { type: 'array', maxItems: 16, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128, pattern: '^/dev/[A-Za-z0-9._/+:-]+$' } } },
        },
      },
    },
    async (req, reply) => {
      const hostId = parseId(req.params.id);
      if (!hostId) return reply.code(404).send({ error: 'host not found' });
      const current = await hosts.findOne({ _id: hostId });
      if (!current) return reply.code(404).send({ error: 'host not found' });
      if (isVirtualizedHealthHost(current)) return reply.code(409).send({ error: 'SMART désactivé sur les hôtes virtualisés' });
      if (!current.capabilities?.includes('smart')) return reply.code(409).send({ error: 'SMART indisponible sur cet agent' });
      const host = await hosts.findOneAndUpdate({ _id: hostId }, { $set: { smartDevices: req.body.devices } }, { returnDocument: 'after' });
      if (!host) return reply.code(404).send({ error: 'host not found' });
      if (host.capabilities?.includes('health')) sendToAgent(hostId.toHexString(), await healthConfigForHost(host));
      return { devices: host.smartDevices ?? [] };
    },
  );
}
