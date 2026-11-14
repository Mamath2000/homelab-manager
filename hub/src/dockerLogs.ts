import { hosts } from './db.js';
import { createJob } from './jobs.js';
import { dockerLogPort, logRole, logTargets, LogServerError } from './logs.js';
import type { HostDoc, JobDoc } from './types.js';

// Journals of the containers of a host (homelab#346), turned on from its Docker block. The agent (capability
// docker_log_collect, agent/logcollect.go) sets json-file with the compose labels in daemon.json, restarts Docker, and runs
// a Fluent Bit collector that sends the lines in syslog TCP to the listener of the log server tagged source=docker. The
// hub only sends where to send: an address and a port.

export const canCollectDockerLogs = (h: Pick<HostDoc, 'capabilities'>) => !!h.capabilities?.includes('docker_log_collect');

// Where the collectors send for a log server: the address the hosts send to, the port of the containers.
export async function dockerLogTarget(roleId: string) {
  const role = logRole(roleId);
  if (!role || role._id !== roleId) throw new LogServerError('serveur de logs inconnu', 404);
  const address = (await logTargets()).get(role._id)?.address;
  if (!address) throw new LogServerError("serveur de logs sans adresse connue : indique-la dans le rôle", 409);
  return { address, port: await dockerLogPort(role.config) };
}

// Sends the journals of the containers of a host to a log server (roleId), or stops it (null): the choice is stored on
// the host, then applied by its agent. Turning it on restarts Docker on the host when its daemon.json changes.
export async function setDockerLogs(host: HostDoc, roleId: string | null, trigger: Extract<JobDoc['trigger'], 'manual'> = 'manual') {
  if (roleId === null) {
    await hosts.updateOne({ _id: host._id }, { $unset: { dockerLogs: '' } });
    return createJob(host, 'docker_log_collect', [], trigger, { logCollect: { address: '' }, logCollectInfo: { role: null } });
  }
  const target = await dockerLogTarget(roleId);
  await hosts.updateOne({ _id: host._id }, { $set: { dockerLogs: { role: roleId } } });
  return createJob(host, 'docker_log_collect', [], trigger, {
    logCollect: { ...target, protocol: 'tcp' },
    logCollectInfo: { role: roleId, ...target },
  });
}
