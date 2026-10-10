import { ObjectId } from 'mongodb';
import { agentBinary } from './agentBinaries.js';
import { sendToAgent } from './agents.js';
import { jobs } from './db.js';
import { publish } from './events.js';
import type { HostDoc, JobAction, JobDoc, SetupOption } from './types.js';

const MAX_LOG = 512 * 1024;
const PKG_RE = /^[a-z0-9][a-z0-9+.\-:]*$/;

// Logs of running jobs live in memory and are flushed to Mongo periodically.
interface Running {
  hostId: string;
  log: string;
  dirty: boolean;
}
const running = new Map<string, Running>();

export function validPackages(pkgs: string[]) {
  return pkgs.every((p) => PKG_RE.test(p));
}

export function jobDto(j: JobDoc, withLog = false) {
  const id = j._id.toHexString();
  return {
    id,
    hostId: j.hostId.toHexString(),
    hostName: j.hostName,
    action: j.action,
    packages: j.packages,
    stack: j.stack ?? null,
    service: j.service ?? null,
    modules: j.modules ?? null,
    trigger: j.trigger,
    status: j.status,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt ?? null,
    exitCode: j.exitCode ?? null,
    error: j.error ?? null,
    ...(withLog ? { log: running.get(id)?.log ?? j.log } : {}),
  };
}

export function hasRunningJob(hostId: string) {
  for (const r of running.values()) if (r.hostId === hostId) return true;
  return false;
}

export interface JobTarget {
  stack?: string;
  service?: string;
  // setup_apply: what the agent applies (built by setup.ts from the profile, never from the request)
  setup?: { modules: SetupOption[] } & Record<string, unknown>;
}

export async function createJob(host: HostDoc, action: JobAction, packages: string[], trigger: JobDoc['trigger'], target: JobTarget = {}) {
  const job: JobDoc = {
    _id: new ObjectId(),
    hostId: host._id,
    hostName: host.name,
    action,
    packages,
    ...(target.stack ? { stack: target.stack } : {}),
    ...(target.service ? { service: target.service } : {}),
    ...(target.setup ? { modules: target.setup.modules } : {}),
    trigger,
    status: 'running',
    createdAt: new Date(),
    log: '',
  };
  const id = job._id.toHexString();
  const hostId = host._id.toHexString();
  await jobs.insertOne(job);
  running.set(id, { hostId, log: '', dirty: false });

  // the agent checks the downloaded binary against this hash
  const bin = action === 'agent_update' ? agentBinary(host.info?.arch) : null;
  if (action === 'agent_update' && !bin) {
    await finishJob(id, hostId, -1, `pas de binaire de l'agent pour l'architecture ${host.info?.arch ?? 'inconnue'}`);
  } else if (!sendToAgent(hostId, { type: 'run', jobId: id, action, packages, ...target, ...(bin ? { sha256: bin.sha256 } : {}) })) {
    await finishJob(id, hostId, -1, 'host is offline');
  } else {
    publish('job', jobDto(job));
  }
  return (await jobs.findOne({ _id: job._id }))!;
}

export function appendJobLog(jobId: string, hostId: string, data: string) {
  const r = running.get(jobId);
  if (!r || r.hostId !== hostId) return;
  r.log += data;
  if (r.log.length > MAX_LOG) r.log = '[...]\n' + r.log.slice(-MAX_LOG);
  r.dirty = true;
  publish('job.log', { jobId, data });
}

export async function finishJob(jobId: string, hostId: string, exitCode: number, error?: string) {
  const r = running.get(jobId);
  if (!r || r.hostId !== hostId) return;
  running.delete(jobId);
  const status = exitCode === 0 && !error ? 'success' : 'failed';
  const updated = await jobs.findOneAndUpdate(
    { _id: new ObjectId(jobId) },
    { $set: { status, exitCode, error: error || undefined, finishedAt: new Date(), log: r.log } },
    { returnDocument: 'after' },
  );
  if (updated) publish('job', jobDto(updated));
  return updated;
}

export async function failRunningJobs(hostId: string, reason: string) {
  for (const [jobId, r] of running) {
    if (r.hostId === hostId) await finishJob(jobId, hostId, -1, reason);
  }
}

export async function flushLogs() {
  for (const [jobId, r] of running) {
    if (!r.dirty) continue;
    r.dirty = false;
    await jobs.updateOne({ _id: new ObjectId(jobId) }, { $set: { log: r.log } });
  }
}

// Jobs left "running" by a previous hub process can never complete.
export async function recoverJobs() {
  await jobs.updateMany(
    { status: 'running' },
    { $set: { status: 'failed', error: 'hub restarted', finishedAt: new Date() } },
  );
}
