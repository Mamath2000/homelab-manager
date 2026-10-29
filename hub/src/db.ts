import { MongoClient, ObjectId, type Collection } from 'mongodb';
import { config } from './config.js';
import type { AgentSettings, BackupDoc, BackupStatDoc, StorageUsageDoc, BackupJobDoc, EquipmentAlertDoc, EquipmentDoc, GuestDoc, HealthMetricDoc, HealthSettings, HostAlertDoc, PveSettings, HomeAssistantSettings, HostDoc, JobDoc, PbsSettings, PbsRemoteSettings, ProbeDayDoc, ProbeDoc, ProbeMeasureDoc, PkiDoc, ApiKeyDoc, SessionDoc, SetupProfile, SitesSettings, TagsSettings, UserDoc } from './types.js';

const client = new MongoClient(config.mongoUrl);

export let hosts: Collection<HostDoc>;
export let jobs: Collection<JobDoc>;
export let users: Collection<UserDoc>;
export let sessions: Collection<SessionDoc>;
export let apiKeys: Collection<ApiKeyDoc>;
export let settings: Collection<HomeAssistantSettings | AgentSettings | HealthSettings | PkiDoc | SetupProfile | PbsSettings | PbsRemoteSettings | PveSettings | SitesSettings | TagsSettings>;
export let guests: Collection<GuestDoc>;
export let backupJobs: Collection<BackupJobDoc>;
export let backups: Collection<BackupDoc>;
export let backupStats: Collection<BackupStatDoc>;
export let storageUsage: Collection<StorageUsageDoc>;
export let hostAlerts: Collection<HostAlertDoc>;
export let healthMetrics: Collection<HealthMetricDoc>;
export let probes: Collection<ProbeDoc>;
export let probeDays: Collection<ProbeDayDoc>;
export let probeMeasures: Collection<ProbeMeasureDoc>;
export let equipments: Collection<EquipmentDoc>;
export let equipmentAlerts: Collection<EquipmentAlertDoc>;

export async function connectDb() {
  await client.connect();
  const db = client.db();
  hosts = db.collection('hosts');
  jobs = db.collection('jobs');
  users = db.collection('users');
  sessions = db.collection('sessions');
  apiKeys = db.collection('apiKeys');
  settings = db.collection('settings');
  backups = db.collection('backups');
  backupStats = db.collection('backupStats');
  storageUsage = db.collection('storageUsage');
  guests = db.collection('guests');
  backupJobs = db.collection('backupJobs');
  hostAlerts = db.collection('hostAlerts');
  healthMetrics = db.collection('healthMetrics');
  probes = db.collection('probes');
  probeDays = db.collection('probeDays');
  probeMeasures = db.collection('probeMeasures');
  equipments = db.collection('equipments');
  equipmentAlerts = db.collection('equipmentAlerts');

  await Promise.all([
    hosts.createIndex({ name: 1 }),
    hosts.createIndex({ certFingerprint: 1 }, { sparse: true }),
    hosts.createIndex({ enrollCodeHash: 1 }, { sparse: true }),
    jobs.createIndex({ hostId: 1, createdAt: -1 }),
    jobs.createIndex({ createdAt: -1 }),
    // keep 90 days of job history
    jobs.createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600, name: 'jobs_ttl' }),
    users.createIndex({ username: 1 }, { unique: true }),
    apiKeys.createIndex({ hash: 1 }, { unique: true }),
    apiKeys.createIndex({ userId: 1 }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    sessions.createIndex({ userId: 1 }),
    backups.createIndex({ hostId: 1 }),
    backupJobs.createIndex({ hostId: 1 }),
    // one document per PBS backup task, kept 400 days
    backupStats.createIndex({ start: -1 }),
    backupStats.createIndex({ groupId: 1, start: -1 }),
    backupStats.createIndex({ at: 1 }, { expireAfterSeconds: 400 * 24 * 3600, name: 'backup_stats_ttl' }),
    // one document per datastore and day, kept 400 days
    storageUsage.createIndex({ source: 1, store: 1, day: 1 }),
    storageUsage.createIndex({ at: 1 }, { expireAfterSeconds: 400 * 24 * 3600, name: 'storage_usage_ttl' }),
    // backup results reported by the agents, recorded once
    jobs.createIndex({ resultId: 1 }, { sparse: true }),
    // one document per host and day, kept a little longer than the timeline of the host page shows
    hostAlerts.createIndex({ hostId: 1, day: 1 }, { unique: true }),
    hostAlerts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'host_alerts_ttl' }),
    probes.createIndex({ 'subject.kind': 1, 'subject.id': 1 }),
    // one document per probe and day
    probeDays.createIndex({ probeId: 1, day: 1 }, { unique: true }),
    probeDays.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'probe_days_ttl' }),
    // one document per measure, kept a little longer than the hour the Probes page shows
    probeMeasures.createIndex({ probeId: 1, at: 1 }),
    probeMeasures.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'probe_measures_ttl' }),
    equipments.createIndex({ siteId: 1, name: 1 }),
    // one equipment per id of its source
    equipments.createIndex({ source: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $exists: true } } }),
    // same as the hosts
    equipmentAlerts.createIndex({ equipmentId: 1, day: 1 }, { unique: true }),
    equipmentAlerts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'equipment_alerts_ttl' }),
    healthMetrics.createIndex({ hostId: 1, category: 1, sampledAt: -1 }),
    healthMetrics.createIndex({ sampledAt: 1 }, { expireAfterSeconds: 48 * 3600, name: 'health_metrics_ttl' }),
    // accounts created before roles existed keep full access
    users.updateMany({ role: { $exists: false } }, { $set: { role: 'admin' } }),
    // "monitor" was renamed "operator" (and lost the settings)
    users.updateMany({ role: 'monitor' as never }, { $set: { role: 'operator' } }),
    // the history of the snapshots was plain dates before it carried their verification
    backups.updateMany({ 'times.0': { $type: 'number' } } as never, [
      { $set: { times: { $map: { input: '$times', in: { $cond: [{ $isNumber: '$$this' }, { t: '$$this', verify: null }, '$$this'] } } } } },
    ]),
  ]);
}

export async function closeDb() {
  await client.close();
}

export function parseId(id: string): ObjectId | null {
  return ObjectId.isValid(id) && /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null;
}
