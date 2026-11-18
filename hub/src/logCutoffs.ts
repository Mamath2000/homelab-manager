import { logCutoffs } from './db.js';
import type { LogCutoff } from './logs.js';

// History of the journals hidden by host (homelab#355). Nothing is deleted on the log server: the routes that show
// journals leave out what is older than the cutoff of the host (filterQuery); setting a cutoff again moves it, removing
// it shows the history again. The poll that watches silent hosts never reads them (it works on the raw lines).

export const loadCutoffs = async (): Promise<LogCutoff[]> => (await logCutoffs.find().toArray()).map((c) => ({ hostname: c._id, since: c.since.toISOString() }));

export async function setCutoffs(hostnames: string[], by: string | null, now = new Date()) {
  if (!hostnames.length) return;
  await logCutoffs.bulkWrite(hostnames.map((h) => ({ updateOne: { filter: { _id: h }, update: { $set: { since: now, by, at: now } }, upsert: true } })));
}

// no host: every cutoff
export async function removeCutoffs(hostnames: string[] = []) {
  const { deletedCount } = await logCutoffs.deleteMany(hostnames.length ? { _id: { $in: hostnames } } : {});
  return deletedCount;
}
