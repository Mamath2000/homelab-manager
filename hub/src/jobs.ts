import { ObjectId } from 'mongodb';
import { hostBinary } from './agentBinaries.js';
import { sendToAgent } from './agents.js';
import { hosts, jobs } from './db.js';
import { publish } from './events.js';
import type { HostDoc, JobAction, JobDoc, SetupOption } from './types.js';

const MAX_LOG = 512 * 1024;
const PKG_RE = /^[a-z0-9][a-z0-9+.\-:]*$/;

// Logs of running jobs live in memory and are flushed to Mongo periodically.
interface Running {
  hostId: string;
  log: string;
  dirty: boolean;
  // run by the hub itself (copy to the secondary PBS): not a job of the agent, kept when it disconnects
  hub?: boolean;
}
const running = new Map<string, Running>();

export function validPackages(pkgs: string[]) {
  return pkgs.every((p) => PKG_RE.test(p));
}

// Security updates of the last report of a host (apt_upgrade limited to them).
export function securityPackages(h: Pick<HostDoc, 'apt'>) {
  return (h.apt?.upgradable ?? []).filter((p) => p.security).map((p) => p.name);
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
    backupJobName: j.backupJobName ?? null,
    method: j.method ?? null,
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
  for (const r of running.values()) if (r.hostId === hostId && !r.hub) return true;
  return false;
}

export interface JobTarget {
  stack?: string;
  service?: string;
  // lock: session to lock
  sessionId?: number;
  // setup_apply: what the agent applies (built by setup.ts from the profile, never from the request)
  setup?: { modules: SetupOption[] } & Record<string, unknown>;
  // backup_run: id and name of the backup job
  backupJob?: string;
  backupJobName?: string;
  // backup_install: how to install the client
  method?: 'apt' | 'docker';
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
    ...(target.sessionId !== undefined ? { sessionId: target.sessionId } : {}),
    ...(target.setup ? { modules: target.setup.modules } : {}),
    ...(target.backupJob ? { backupJobId: new ObjectId(target.backupJob), backupJobName: target.backupJobName } : {}),
    ...(target.method ? { method: target.method } : {}),
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
  const bin = action === 'agent_update' ? hostBinary(host) : null;
  if (action === 'agent_update' && !bin) {
    await finishJob(id, hostId, -1, `pas de binaire de l'agent pour l'architecture ${host.info?.arch ?? 'inconnue'}`);
  } else if (
    !sendToAgent(hostId, {
      type: 'run',
      jobId: id,
      action,
      packages,
      ...(target.stack ? { stack: target.stack } : {}),
      ...(target.service ? { service: target.service } : {}),
      ...(target.sessionId !== undefined ? { sessionId: target.sessionId } : {}),
      ...(target.setup ? { setup: target.setup } : {}),
      ...(target.backupJob ? { backupJob: target.backupJob } : {}),
      ...(target.method ? { method: target.method } : {}),
      ...(bin ? { sha256: bin.sha256 } : {}),
    })
  ) {
    await finishJob(id, hostId, -1, 'host is offline');
  } else {
    publish('job', jobDto(job));
  }
  return (await jobs.findOne({ _id: job._id }))!;
}

// Job run by the hub itself, shown like the others (console, Activité); its caller writes the log
// (appendJobLog) and ends it (finishJob). target.backupJobName: what it is about. jobId: a job of a previous
// hub process taken up again (left running by recoverJobs).
export async function startHubJob(host: Pick<HostDoc, '_id' | 'name'>, action: JobAction, trigger: JobDoc['trigger'], target: { backupJobName: string; createdAt?: Date }, jobId?: string) {
  const hostId = host._id.toHexString();
  if (jobId && ObjectId.isValid(jobId)) {
    const cur = await jobs.findOne({ _id: new ObjectId(jobId), status: 'running' });
    if (cur) {
      if (!running.has(jobId)) running.set(jobId, { hostId, log: cur.log, dirty: false, hub: true });
      return cur;
    }
  }
  const job: JobDoc = {
    _id: new ObjectId(),
    hostId: host._id,
    hostName: host.name,
    action,
    packages: [],
    backupJobName: target.backupJobName,
    trigger,
    status: 'running',
    createdAt: target.createdAt ?? new Date(),
    log: '',
  };
  await jobs.insertOne(job);
  running.set(job._id.toHexString(), { hostId, log: '', dirty: false, hub: true });
  publish('job', jobDto(job));
  return job;
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
    if (r.hostId !== hostId || r.hub) continue;
    // a registry check cut short (agent restarted by its own update...) is still due: the flag
    // was cleared when it started, so it is raised again for the next docker report
    const job = await jobs.findOne({ _id: new ObjectId(jobId) }, { projection: { action: 1 } });
    if (job?.action === 'docker_check') await hosts.updateOne({ _id: new ObjectId(hostId) }, { $set: { dockerRecheck: true } });
    await finishJob(jobId, hostId, -1, reason);
  }
}

export async function flushLogs() {
  for (const [jobId, r] of running) {
    if (!r.dirty) continue;
    r.dirty = false;
    await jobs.updateOne({ _id: new ObjectId(jobId) }, { $set: { log: r.log } });
  }
}

// Jobs left "running" by a previous hub process can never complete. Those that only a hub restart
// interrupted must not count as an attempt: the agent update is retried at the next hello, and the
// registry check left due is run again at the next docker report.
export function interruptedByRestart(running: Pick<JobDoc, 'action' | 'hostId'>[]) {
  const on = (action: JobAction) => running.filter((j) => j.action === action).map((j) => j.hostId);
  return { agentUpdate: on('agent_update'), dockerCheck: on('docker_check') };
}

// Copies to the secondary PBS go on without the hub: their job is taken up again (offsite.ts).
export async function recoverJobs() {
  const interrupted = interruptedByRestart(await jobs.find({ status: 'running' }).toArray());
  await jobs.updateMany(
    { status: 'running', action: { $ne: 'offsite_run' } },
    { $set: { status: 'failed', error: 'hub restarted', finishedAt: new Date() } },
  );
  if (interrupted.agentUpdate.length) {
    await hosts.updateMany({ _id: { $in: interrupted.agentUpdate } }, { $unset: { lastAgentUpdateAt: '', lastAgentUpdateHash: '' } });
  }
  if (interrupted.dockerCheck.length) await hosts.updateMany({ _id: { $in: interrupted.dockerCheck } }, { $set: { dockerRecheck: true } });
}
