import { MongoClient, ObjectId, type Collection } from 'mongodb';
import { config } from './config.js';

// the journal of the key actions is kept one year, then dropped by Mongo itself (no purge from the hub)
export const AUDIT_RETENTION_DAYS = 365;
import type { AgentSettings, BackupDoc, BackupStatDoc, StorageUsageDoc, BackupJobDoc, EquipmentAlertDoc, EquipmentDoc, GuestDoc, HealthMetricDoc, HealthSettings, HostAlertDoc, PveSettings, HomeAssistantSettings, HostDoc, JobDoc, PbsSettings, PbsRemoteSettings, ProbeDayDoc, ProbeDoc, ProbeMeasureDoc, PkiDoc, UiTlsDoc, ApiKeyDoc, AuditDoc, PasskeyDoc, StoredRoleDoc, OmadaStateDoc, SessionDoc, SetupProfile, SitesSettings, TagsSettings, UserDoc } from './types.js';

// an account given apart from the URL (no escaping of the password); none: the URL as it is (with its own account, if any)
const client = new MongoClient(
  config.mongoUrl,
  config.mongoUsername ? { auth: { username: config.mongoUsername, password: config.mongoPassword ?? '' }, authSource: config.mongoAuthSource } : {},
);

export let hosts: Collection<HostDoc>;
export let jobs: Collection<JobDoc>;
export let users: Collection<UserDoc>;
export let sessions: Collection<SessionDoc>;
export let apiKeys: Collection<ApiKeyDoc>;
export let passkeys: Collection<PasskeyDoc>;
export let settings: Collection<HomeAssistantSettings | AgentSettings | HealthSettings | PkiDoc | UiTlsDoc | SetupProfile | PbsSettings | PbsRemoteSettings | PveSettings | SitesSettings | TagsSettings>;
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
export let roles: Collection<StoredRoleDoc>;
export let omada: Collection<OmadaStateDoc>;
export let audit: Collection<AuditDoc>;

export async function connectDb() {
  await client.connect();
  await alignFeatureCompatibility();
  const db = client.db();
  hosts = db.collection('hosts');
  jobs = db.collection('jobs');
  users = db.collection('users');
  sessions = db.collection('sessions');
  apiKeys = db.collection('apiKeys');
  passkeys = db.collection('passkeys');
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
  roles = db.collection('roles');
  omada = db.collection('omada');
  audit = db.collection('audit');

  await Promise.all([
    hosts.createIndex({ name: 1 }),
    hosts.createIndex({ certFingerprint: 1 }, { sparse: true }),
    hosts.createIndex({ enrollCodeHash: 1 }, { sparse: true }),
    jobs.createIndex({ hostId: 1, createdAt: -1 }),
    jobs.createIndex({ createdAt: -1 }),
    // keep 90 days of job history
    jobs.createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600, name: 'jobs_ttl' }),
    users.createIndex({ username: 1 }, { unique: true }),
    // journal of the key actions (audit.ts): newest first, by actor or category, kept one year
    audit.createIndex({ 'actor.name': 1, _id: -1 }),
    audit.createIndex({ category: 1, _id: -1 }),
    audit.createIndex({ at: 1 }, { expireAfterSeconds: AUDIT_RETENTION_DAYS * 24 * 3600, name: 'audit_ttl' }),
    roles.createIndex({ 'carrier.id': 1 }),
    apiKeys.createIndex({ hash: 1 }, { unique: true }),
    apiKeys.createIndex({ userId: 1 }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    sessions.createIndex({ userId: 1 }),
    passkeys.createIndex({ credentialId: 1 }, { unique: true }),
    passkeys.createIndex({ userId: 1 }),
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
    // "role" was renamed "profile" (the roles are now the ones of the hub); accounts created before roles existed keep
    // full access, "monitor" was renamed "operator" (and lost the settings)
    users.updateMany({ profile: { $exists: false } }, [
      { $set: { profile: { $cond: [{ $eq: ['$role', 'monitor'] }, 'operator', { $ifNull: ['$role', 'admin'] }] } } },
      { $unset: 'role' },
    ]),
    // the history of the snapshots was plain dates before it carried their verification
    backups.updateMany({ 'times.0': { $type: 'number' } } as never, [
      { $set: { times: { $map: { input: '$times', in: { $cond: [{ $isNumber: '$$this' }, { t: '$$this', verify: null }, '$$this'] } } } } },
    ]),
  ]);
  await lowercaseUsernames();
}

// featureCompatibilityVersion the server should be at: its own version (major.minor), when the stored one lags
// behind it (a base created by an older mongod). null: nothing to do.
export function fcvTarget(serverVersion: string, fcv: string): string | null {
  const parse = (v: string) => /^(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
  const server = parse(serverVersion);
  const current = parse(fcv);
  if (!server || !current) return null;
  const behind = current[0] < server[0] || (current[0] === server[0] && current[1] < server[1]);
  return behind ? `${server[0]}.${server[1]}` : null;
}

// A new mongod only starts on the featureCompatibilityVersion of the release before it (8.0 on 7.0, 8.3 on 8.0 or 8.2):
// the hub raises it to the version of the server at start, so that the next image starts too. Not reversible (going
// back to the previous mongod takes a restore). Without the rights (account without clusterManager): warning only.
async function alignFeatureCompatibility() {
  const admin = client.db('admin');
  try {
    const { version } = await admin.command({ buildInfo: 1 });
    const { featureCompatibilityVersion: fcv } = await admin.command({ getParameter: 1, featureCompatibilityVersion: 1 });
    const target = fcvTarget(version, fcv.version);
    if (!target) return;
    console.warn(`MongoDB ${version}: featureCompatibilityVersion ${fcv.version} -> ${target}`);
    await admin.command({ setFeatureCompatibilityVersion: target, confirm: true });
  } catch (err) {
    console.warn(`MongoDB: featureCompatibilityVersion not checked or not raised (${(err as Error).message}); the next MongoDB image may not start`);
  }
}

// Logins are lowercase (the display case lives in displayName). Accounts created before that are lowercased, the old
// case kept as display name; a name that collides with another one once lowercased is left alone and reported.
export async function lowercaseUsernames() {
  const all = await users.find({}, { projection: { username: 1, displayName: 1 } }).toArray();
  const groups = new Map<string, typeof all>();
  for (const u of all) groups.set(u.username.toLowerCase(), [...(groups.get(u.username.toLowerCase()) ?? []), u]);
  for (const [lower, list] of groups) {
    if (list.length > 1) {
      console.warn(`accounts ${list.map((u) => `"${u.username}"`).join(', ')} differ only by case: left unchanged, rename them by hand`);
      continue;
    }
    const [u] = list;
    if (u.username === lower) continue;
    await users.updateOne({ _id: u._id }, { $set: { username: lower, ...(u.displayName ? {} : { displayName: u.username }) } });
    console.info(`account "${u.username}" renamed "${lower}" (logins are lowercase)`);
  }
}

export async function closeDb() {
  await client.close();
}

export function parseId(id: string): ObjectId | null {
  return ObjectId.isValid(id) && /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null;
}
