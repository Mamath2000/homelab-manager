import type { FastifyBaseLogger } from 'fastify';
import type { ObjectId } from 'mongodb';
import { syncAll } from './backupJobs.js';
import { backupJobs, backups, hosts, settings } from './db.js';
import { publish } from './events.js';
import { isPluginJob } from './nextcloud.js';
import { clearSecondary, loadRemoteSettings, pollOffsite } from './offsite.js';
import { loadPbsSettings, pollPbs } from './pbs.js';
import { checkPbsRevoker, deletePbsToken } from './pbsAgent.js';
import { pollPve } from './pve.js';
import type { AgentTokenDeleteResult } from './apiTokens.js';
import type { BackupCache, CachedBackupJob, PbsAgentLink, PbsRemoteSettings } from './types.js';

// Disconnection of the main PBS and of the secondary (#190): Homelab Manager goes back to a state without
// PBS. It removes what it created there (its tokens, the users left without token, the hlm-* sync jobs and
// the remote entry of the secondary) and its own data; never a snapshot, a group, a namespace or a
// datastore. Every agent needed is checked first: a disconnection does not stop halfway because of one.

export interface DisconnectReport {
  revoked: string[]; // tokens revoked
  users: string[]; // users deleted with their last token
  syncJobs: number; // hlm-* sync jobs removed from the secondary
  remote: boolean; // remote entry removed from the secondary
  hosts: number; // hosts whose backups were put aside (cache)
  cachedJobs: number;
  groups: number; // groups of the PBS forgotten
  errors: string[]; // steps that failed, to finish by hand
}

const emptyReport = (): DisconnectReport => ({ revoked: [], users: [], syncJobs: 0, remote: false, hosts: 0, cachedJobs: 0, groups: 0, errors: [] });

// Anything the hub set up for the secondary (a disconnection has something to remove)
export const remoteConfigured = (r: PbsRemoteSettings) => !!(r.url || r.tokenId || r.readerTokenId);

async function revoke(link: PbsAgentLink, tokenId: string, report: DisconnectReport, log?: FastifyBaseLogger) {
  if (!tokenId) return;
  let r: AgentTokenDeleteResult | null;
  try {
    r = await deletePbsToken(link, tokenId);
  } catch (err) {
    log?.warn({ err, tokenId }, 'token not revoked');
    report.errors.push((err as Error).message);
    return;
  }
  if (r?.deleted) report.revoked.push(r.tokenId);
  if (r?.userDeleted) report.users.push(r.tokenId.split('!')[0]);
}

// Agents the disconnection of the secondary needs: its own (token of the hub) and the one of the main PBS
// (reader token).
async function checkRemote(r: PbsRemoteSettings) {
  if (r.tokenId) await checkPbsRevoker(r.agent, 'PBS de secours');
  if (r.readerTokenId) await checkPbsRevoker((await loadPbsSettings()).agent, 'PBS principal (jeton lecteur)');
}

async function disconnectRemoteChecked(r: PbsRemoteSettings, report: DisconnectReport, log?: FastifyBaseLogger) {
  // no longer ready for the poller (it would set the sync jobs again), then the running poll is waited for
  await settings.updateOne({ _id: 'pbs-remote' }, { $set: { tokenSecret: '', readerTokenSecret: '' } });
  await pollOffsite(log);
  try {
    const c = await clearSecondary(r);
    report.syncJobs = c.syncJobs;
    report.remote = c.remote;
  } catch (err) {
    log?.warn({ err }, 'secondary PBS not cleared');
    report.errors.push(`PBS de secours : sync jobs hlm-* et remote hlm-main non retirés (${(err as Error).message})`);
  }
  if (r.agent) await revoke(r.agent, r.tokenId, report, log);
  const main = await loadPbsSettings();
  if (main.agent) await revoke(main.agent, r.readerTokenId, report, log);
  await settings.deleteOne({ _id: 'pbs-remote' });
}

export async function disconnectRemote(log?: FastifyBaseLogger): Promise<DisconnectReport> {
  const r = await loadRemoteSettings();
  await checkRemote(r);
  const report = emptyReport();
  await disconnectRemoteChecked(r, report, log);
  publish('backups', {});
  return report;
}

const cachedJob = (j: CachedBackupJob & { hostId?: ObjectId; lastRun?: unknown; plugin?: unknown }): CachedBackupJob => {
  const { hostId, lastRun, plugin, ...kept } = j;
  void [hostId, lastRun, plugin];
  return kept;
};

// The cache of a host merged with what it has now (a cache not restored since an earlier disconnection
// is kept; the same job, newer, wins).
export function mergeCache(prev: BackupCache | null | undefined, next: Omit<BackupCache, 'at'>, at = new Date()): BackupCache {
  const ids = new Set(next.jobs.map((j) => j._id.toHexString()));
  return {
    at,
    ...(next.tokenId || prev?.tokenId ? { tokenId: next.tokenId || prev?.tokenId } : {}),
    jobs: [...(prev?.jobs ?? []).filter((j) => !ids.has(j._id.toHexString())), ...next.jobs],
    nextcloud: next.nextcloud ?? prev?.nextcloud ?? null,
  };
}

export async function disconnectMain(log?: FastifyBaseLogger): Promise<DisconnectReport> {
  const pbs = await loadPbsSettings();
  const remote = await loadRemoteSettings();
  // the agent of the main PBS revokes every token on it (monitoring, hosts, reader)
  await checkPbsRevoker(pbs.agent, 'PBS principal');
  if (remoteConfigured(remote)) await checkRemote(remote);
  const report = emptyReport();
  // 1. the secondary pulls from the main PBS: disconnected with it
  if (remoteConfigured(remote)) await disconnectRemoteChecked(remote, report, log);

  // 2. hosts: their jobs and settings put aside, then an empty definition sent (the agents stop)
  const list = await hosts
    .find({ $or: [{ pbsCredential: { $exists: true } }, { nextcloud: { $ne: null } }, { _id: { $in: await backupJobs.distinct('hostId') } }] })
    .toArray();
  const tokens: string[] = [];
  for (const h of list) {
    const jobs = await backupJobs.find({ hostId: h._id }).toArray();
    const manual = jobs.filter((j) => !isPluginJob(j)).map(cachedJob);
    // nothing to offer again (a token alone): no cache
    const keep = manual.length > 0 || !!h.nextcloud || !!h.backupCache;
    const cache = keep ? mergeCache(h.backupCache, { tokenId: h.pbsCredential?.tokenId, jobs: manual, nextcloud: h.nextcloud ?? null }) : null;
    await hosts.updateOne({ _id: h._id }, { ...(cache ? { $set: { backupCache: cache } } : {}), $unset: { pbsCredential: '', nextcloud: '', backupSync: '' } });
    await backupJobs.deleteMany({ hostId: h._id });
    if (h.pbsCredential?.tokenId) tokens.push(h.pbsCredential.tokenId);
    report.hosts++;
    report.cachedJobs += manual.length;
  }
  await syncAll().catch((err) => log?.warn({ err }, 'backup definitions not sent'));
  for (const t of tokens) await revoke(pbs.agent!, t, report, log);

  // 3. the main PBS: monitoring token, settings, then the groups read from it (the backups of Home
  // Assistant are not on the PBS: they stay)
  await revoke(pbs.agent!, pbs.tokenId, report, log);
  await settings.deleteOne({ _id: 'pbs' });
  await pollPbs(log); // a poll running meanwhile ends before the groups go
  report.groups = (await backups.deleteMany({ source: { $ne: 'haos' } })).deletedCount;
  await pollPve(log).catch(() => {});
  publish('backups', {});
  log?.info({ ...report, errors: report.errors.length }, 'main PBS disconnected');
  return report;
}

// Settings of before #190: the checkboxes "Suivre / Copier / Relever" (field enabled) are gone.
export async function migrateEnabled() {
  await settings.updateMany({ _id: { $in: ['pbs', 'pbs-remote'] } } as never, { $unset: { enabled: '' } });
  await settings.updateOne({ _id: 'pve', 'clusters.0': { $exists: true } } as never, { $unset: { 'clusters.$[].enabled': '' } });
}
