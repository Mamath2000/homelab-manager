import { MongoClient, ObjectId, type Collection } from 'mongodb';
import { config } from './config.js';
import type { AgentSettings, HomeAssistantSettings, HostDoc, JobDoc, SessionDoc, UserDoc } from './types.js';

const client = new MongoClient(config.mongoUrl);

export let hosts: Collection<HostDoc>;
export let jobs: Collection<JobDoc>;
export let users: Collection<UserDoc>;
export let sessions: Collection<SessionDoc>;
export let settings: Collection<HomeAssistantSettings | AgentSettings>;

export async function connectDb() {
  await client.connect();
  const db = client.db();
  hosts = db.collection('hosts');
  jobs = db.collection('jobs');
  users = db.collection('users');
  sessions = db.collection('sessions');
  settings = db.collection('settings');

  await Promise.all([
    hosts.createIndex({ name: 1 }),
    jobs.createIndex({ hostId: 1, createdAt: -1 }),
    jobs.createIndex({ createdAt: -1 }),
    // keep 90 days of job history
    jobs.createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600, name: 'jobs_ttl' }),
    users.createIndex({ username: 1 }, { unique: true }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    sessions.createIndex({ userId: 1 }),
    // accounts created before roles existed keep full access
    users.updateMany({ role: { $exists: false } }, { $set: { role: 'admin' } }),
    // "monitor" was renamed "operator" (and lost the settings)
    users.updateMany({ role: 'monitor' as never }, { $set: { role: 'operator' } }),
  ]);
}

export async function closeDb() {
  await client.close();
}

export function parseId(id: string): ObjectId | null {
  return ObjectId.isValid(id) && /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null;
}
