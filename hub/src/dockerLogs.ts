import { isOnline } from './agents.js';
import { hosts, jobs } from './db.js';
import { createJob } from './jobs.js';
import { dockerLogPort, logRole, logTargets, LogServerError } from './logs.js';
import { canSetup, effectiveValues, loadSetupProfile } from './setup.js';
import type { HostDoc, JobDoc, SetupProfile } from './types.js';

// Journals of the containers of a host (homelab#346, #347), turned on from Paramètres › Logs. The agent (capability
// docker_log_collect, agent/logcollect.go) sets json-file with the compose labels in daemon.json, restarts Docker, and runs
// a Fluent Bit collector that sends the lines in syslog TCP to the listener of the log server tagged source=docker. The
// hub only sends where to send: an address and a port.
//
// They always go to the log server of the host (its option « Envoi des journaux »): the host only stores that they are
// on. A report whose collector sends elsewhere (server of the host changed, address or port of the role changed) is
// set again by reconcileDockerLogs, which never restarts Docker; a host that no longer sends its journals stops them.

export const canCollectDockerLogs = (h: Pick<HostDoc, 'capabilities'>) => !!h.capabilities?.includes('docker_log_collect');

// The log server the journals of the host go to, through the standardisation (null: none).
export function hostLogRole(p: SetupProfile, h: Pick<HostDoc, 'capabilities' | 'setupOverrides'>): string | null {
  if (!canSetup(h)) return null;
  return effectiveValues(p, h.setupOverrides).log_forward?.role || null;
}

// Where the collectors send for a log server: the address the hosts send to, the port of the containers.
export async function dockerLogTarget(roleId: string) {
  const role = logRole(roleId);
  if (!role || role._id !== roleId) throw new LogServerError('serveur de logs inconnu', 404);
  const address = (await logTargets()).get(role._id)?.address;
  if (!address) throw new LogServerError('serveur de logs sans adresse connue : indique-la dans le rôle', 409);
  return { address, port: await dockerLogPort(role.config) };
}

type Trigger = Extract<JobDoc['trigger'], 'manual' | 'retry'>;

const removeJob = (host: HostDoc, trigger: Trigger) => createJob(host, 'docker_log_collect', [], trigger, { logCollect: { address: '' }, logCollectInfo: { role: null } });

// Turns the journals of the containers of a host on (recreate: the stacks whose containers are created again, so that
// they send) or off. On: the host must send its journals; Docker restarts on the host when its daemon.json changes.
export async function setDockerLogs(host: HostDoc, enabled: boolean, recreate: string[] = [], trigger: Trigger = 'manual') {
  if (!enabled) {
    await hosts.updateOne({ _id: host._id }, { $unset: { dockerLogs: '' } });
    return removeJob(host, trigger);
  }
  const role = hostLogRole(await loadSetupProfile(), host);
  if (!role) throw new LogServerError("l'hôte n'envoie pas ses journaux : active d'abord l'envoi (Paramètres › Logs)", 409);
  const target = await dockerLogTarget(role);
  await hosts.updateOne({ _id: host._id }, { $set: { dockerLogs: { enabled: true } } });
  return createJob(host, 'docker_log_collect', [], trigger, {
    logCollect: { ...target, protocol: 'tcp', ...(recreate.length ? { recreate } : {}) },
    logCollectInfo: { role, ...target, ...(recreate.length ? { recreate } : {}) },
  });
}

// Keeps the collector of a host on the log server of the host, online only. Moved (new address or port): the collector
// alone is set again, never when it is absent or daemon.json drifted (that would restart Docker: Paramètres › Logs offers
// it). The host sends no more journals: stopped. From a report (retry), an attempt that failed for the same target is not
// repeated.
export async function reconcileDockerLogs(host: HostDoc, trigger: Trigger = 'retry', p?: SetupProfile) {
  if (!host.dockerLogs?.enabled || !canCollectDockerLogs(host) || !isOnline(host._id.toHexString())) return null;
  const last = await jobs.findOne({ hostId: host._id, action: 'docker_log_collect' }, { sort: { createdAt: -1 }, projection: { status: 1, logCollect: 1 } });
  if (last?.status === 'running') return null;
  const role = hostLogRole(p ?? (await loadSetupProfile()), host);
  if (!role) return setDockerLogs(host, false, [], trigger);
  const state = host.docker?.logCollect;
  if (!state || state.daemon !== 'ok') return null;
  let target: Awaited<ReturnType<typeof dockerLogTarget>>;
  try {
    target = await dockerLogTarget(role);
  } catch {
    return null;
  }
  if (state.address === target.address && state.port === target.port) return null;
  if (trigger === 'retry' && last?.status === 'failed' && last.logCollect?.address === target.address && last.logCollect.port === target.port) return null;
  return createJob(host, 'docker_log_collect', [], trigger, { logCollect: { ...target, protocol: 'tcp' }, logCollectInfo: { role, ...target } });
}
