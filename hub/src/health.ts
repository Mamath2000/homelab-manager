import { ObjectId } from 'mongodb';
import type { FastifyInstance } from 'fastify';
import { healthMetrics, hosts, settings } from './db.js';
import type { HealthDisks, HealthMetricDoc, HealthSettings, HealthSmart, HealthSystem, HealthVolume, HealthSmartDisk, HostDoc } from './types.js';
import { parseId } from './db.js';
import { isOnline, sendToAgent } from './agents.js';

export const DEFAULT_HEALTH_SETTINGS: HealthSettings = {
  _id: 'health',
  systemIntervalSeconds: 30,
  diskIntervalSeconds: 5 * 60,
  smartIntervalSeconds: 24 * 3600,
  retentionHours: 48,
  cpuThreshold: 90,
  memoryThreshold: 90,
  diskThreshold: 80,
  smartTemperatureThreshold: 70,
  smartWearThreshold: 80,
  sustainedMinutes: 5,
};

export async function loadHealthSettings(): Promise<HealthSettings> {
  return { ...DEFAULT_HEALTH_SETTINGS, ...((await settings.findOne({ _id: 'health' })) as HealthSettings | null) };
}

export async function healthConfigForHost(host: HostDoc) {
  const s = await loadHealthSettings();
  return {
    type: 'health_config',
    healthConfig: {
      systemIntervalSeconds: s.systemIntervalSeconds,
      diskIntervalSeconds: s.diskIntervalSeconds,
      smartIntervalSeconds: s.smartIntervalSeconds,
      smartDevices: host.smartDevices ?? [],
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

function reportAlerts(h: HostDoc, category: HealthCategory, report: HealthReport, settings: HealthSettings, samples: HealthSystem[] = []) {
  const old = h.health?.alerts ?? [];
  const retained = old.filter((a) => !a.key.startsWith(`${category}:`));
  const next: NonNullable<HostDoc['health']>['alerts'] = [];
  const alert = (key: string, label: string, reason: string, level: 'warn' | 'alert' = 'warn') => next.push({ key: `${category}:${key}`, label, level, reason });

  if (category === 'system') {
    const r = report as HealthSystem;
    const cutoff = Date.now() - settings.sustainedMinutes * 60_000;
    const intervalMs = settings.systemIntervalSeconds * 1000;
    const highFor = (field: 'cpuPercent' | 'memPercent', threshold: number) => {
      if (!samples.length || samples[0].checkedAt > cutoff || samples[samples.length - 1].checkedAt < Date.now() - intervalMs * 2) return false;
      let start = 0;
      for (let i = 0; i < samples.length; i++) {
        if (samples[i][field] < threshold) start = i + 1;
      }
      const highSamples = samples.slice(start);
      if (!highSamples.length || highSamples[0].checkedAt > cutoff) return false;
      for (let i = 1; i < highSamples.length; i++) {
        if (highSamples[i].checkedAt - highSamples[i - 1].checkedAt > intervalMs * 2) return false;
      }
      return true;
    };
    const previous = (key: string) => old.some((a) => a.key === `system:${key}`);
    if (highFor('cpuPercent', settings.cpuThreshold) || (previous('cpu') && r.cpuPercent >= settings.cpuThreshold - 5)) {
      alert('cpu', 'CPU', `CPU > ${settings.cpuThreshold} % depuis au moins ${settings.sustainedMinutes} min (${r.cpuPercent.toFixed(1)} %)`);
    }
    if (highFor('memPercent', settings.memoryThreshold) || (previous('memory') && r.memPercent >= settings.memoryThreshold - 5)) {
      alert('memory', 'Mémoire', `Mémoire > ${settings.memoryThreshold} % depuis au moins ${settings.sustainedMinutes} min (${r.memPercent.toFixed(1)} %)`);
    }
  } else if (category === 'disks') {
    const previous = new Set(old.map((a) => a.key));
    for (const v of (report as HealthDisks).volumes) {
      const key = `disks:volume:${v.mountpoint}`;
      if (v.percent >= settings.diskThreshold || (previous.has(key) && v.percent >= settings.diskThreshold - 5)) {
        alert(`volume:${v.mountpoint}`, v.mountpoint, `${v.mountpoint} utilisé à ${v.percent.toFixed(1)} % (seuil ${settings.diskThreshold} %)`);
      }
    }
  } else {
    const previous = new Set(old.map((a) => a.key));
    for (const d of (report as HealthSmart).disks) {
      if (d.healthy === false) alert(`smart:${d.device}:health`, d.device, `${d.device} : état SMART en échec`, 'alert');
      if (d.temperatureC !== undefined && (d.temperatureC >= settings.smartTemperatureThreshold || (previous.has(`smart:smart:${d.device}:temperature`) && d.temperatureC >= settings.smartTemperatureThreshold - 5))) alert(`smart:${d.device}:temperature`, d.device, `${d.device} : température ${d.temperatureC} °C`);
      if (d.reallocated !== undefined && d.reallocated > 0) alert(`smart:${d.device}:reallocated`, d.device, `${d.device} : ${d.reallocated} secteur(s) réalloué(s)`, 'alert');
      if (d.nvmeWearPercent !== undefined && (d.nvmeWearPercent >= settings.smartWearThreshold || (previous.has(`smart:smart:${d.device}:wear`) && d.nvmeWearPercent >= settings.smartWearThreshold - 5))) alert(`smart:${d.device}:wear`, d.device, `${d.device} : usure NVMe ${d.nvmeWearPercent} %`);
      if (d.error) alert(`smart:${d.device}:error`, d.device, `${d.device} : ${d.error}`);
    }
  }
  return [...retained, ...next];
}

async function persistReport(hostId: ObjectId, category: HealthCategory, report: HealthReport) {
  const sampledAt = new Date(report.checkedAt);
  const host = await hosts.findOne({ _id: hostId });
  if (!host) return;
  await healthMetrics.insertOne({ hostId, category, sampledAt, report });

  const s = await loadHealthSettings();
  let recentSystem: HealthSystem[] = [];
  if (category === 'system') {
    const since = new Date(Date.now() - s.sustainedMinutes * 60_000 - s.systemIntervalSeconds * 2_000);
    const docs = await healthMetrics.find({ hostId, category: 'system', sampledAt: { $gte: since } }).sort({ sampledAt: 1 }).toArray();
    recentSystem = docs.map((d) => d.report as HealthSystem);
  }
  const alerts = reportAlerts(host, category, report, s, recentSystem);
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
  required: ['systemIntervalSeconds', 'diskIntervalSeconds', 'smartIntervalSeconds', 'cpuThreshold', 'memoryThreshold', 'diskThreshold', 'smartTemperatureThreshold', 'smartWearThreshold', 'sustainedMinutes'],
  additionalProperties: false,
  properties: {
    systemIntervalSeconds: { type: 'integer', minimum: 10, maximum: 3600 },
    diskIntervalSeconds: { type: 'integer', minimum: 60, maximum: 86400 },
    smartIntervalSeconds: { type: 'integer', minimum: 600, maximum: 2592000 },
    cpuThreshold: { type: 'number', minimum: 1, maximum: 100 },
    memoryThreshold: { type: 'number', minimum: 1, maximum: 100 },
    diskThreshold: { type: 'number', minimum: 1, maximum: 100 },
    smartTemperatureThreshold: { type: 'number', minimum: 1, maximum: 150 },
    smartWearThreshold: { type: 'number', minimum: 1, maximum: 1000 },
    sustainedMinutes: { type: 'integer', minimum: 1, maximum: 60 },
  },
} as const;

export function registerHealthRoutes(app: FastifyInstance) {
  app.get('/api/settings/health', loadHealthSettings);
  app.put<{ Body: Omit<HealthSettings, '_id' | 'retentionHours'> }>(
    '/api/settings/health',
    { schema: { body: healthSettingsBody } },
    async (req) => {
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
        health: host.health ?? null,
        samples: (byHost.get(host._id.toHexString()) ?? []).map(({ sampledAt, report }) => ({ sampledAt, report })),
      })),
    };
  });

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
      if (!current.capabilities?.includes('smart')) return reply.code(409).send({ error: 'SMART indisponible sur cet agent' });
      const host = await hosts.findOneAndUpdate({ _id: hostId }, { $set: { smartDevices: req.body.devices } }, { returnDocument: 'after' });
      if (!host) return reply.code(404).send({ error: 'host not found' });
      if (host.capabilities?.includes('health')) sendToAgent(hostId.toHexString(), await healthConfigForHost(host));
      return { devices: host.smartDevices ?? [] };
    },
  );
}
