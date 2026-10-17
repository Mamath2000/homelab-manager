import { MongoClient, ObjectId, type Collection } from 'mongodb';
import type { TokenSetupDoc } from './tokenSetup.js';
import { config } from './config.js';
import type { AgentSettings, BackupDoc, BackupJobDoc, GuestDoc, HostAlertDoc, PveSettings, HomeAssistantSettings, HostDoc, JobDoc, PbsSettings, PbsRemoteSettings, PkiDoc, ApiKeyDoc, SessionDoc, SetupProfile, SitesSettings, TagsSettings, UserDoc } from './types.js';

const client = new MongoClient(config.mongoUrl);

export let hosts: Collection<HostDoc>;
export let jobs: Collection<JobDoc>;
export let users: Collection<UserDoc>;
export let sessions: Collection<SessionDoc>;
export let apiKeys: Collection<ApiKeyDoc>;
export let settings: Collection<HomeAssistantSettings | AgentSettings | PkiDoc | SetupProfile | PbsSettings | PbsRemoteSettings | PveSettings | SitesSettings | TagsSettings>;
export let guests: Collection<GuestDoc>;
export let backupJobs: Collection<BackupJobDoc>;
export let tokenSetups: Collection<TokenSetupDoc>;
export let backups: Collection<BackupDoc>;
export let hostAlerts: Collection<HostAlertDoc>;

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
  guests = db.collection('guests');
  backupJobs = db.collection('backupJobs');
  tokenSetups = db.collection('tokenSetups');
  hostAlerts = db.collection('hostAlerts');

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
    // backup results reported by the agents, recorded once
    jobs.createIndex({ resultId: 1 }, { sparse: true }),
    // one document per host and day, kept a little longer than the timeline of the host page shows
    hostAlerts.createIndex({ hostId: 1, day: 1 }, { unique: true }),
    hostAlerts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'host_alerts_ttl' }),
    tokenSetups.createIndex({ codeHash: 1 }),
    tokenSetups.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0, name: 'token_setups_ttl' }),
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
