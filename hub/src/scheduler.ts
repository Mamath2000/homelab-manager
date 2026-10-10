import type { FastifyBaseLogger } from 'fastify';
import { isOnline } from './agents.js';
import { hosts } from './db.js';
import { loadAgentSettings, maybeAutoUpdate } from './agentUpdate.js';
import { createJob, hasRunningJob } from './jobs.js';

// Asks every online agent to refresh its package lists, and to check its Docker images, when
// they are older than the interval.
async function tick(log: FastifyBaseLogger) {
  for (const h of await hosts.find({}, { projection: { _id: 1 } }).toArray()) {
    if (await maybeAutoUpdate(h._id)) log.info({ host: h._id.toHexString() }, 'automatic agent update');
  }

  // an interval of 0 disables the automatic apt-get update only
  const { checkIntervalHours } = await loadAgentSettings();
  if (checkIntervalHours <= 0) return;
  const intervalMs = checkIntervalHours * 3600 * 1000;
  const threshold = Date.now() - intervalMs;
  for (const host of await hosts.find({ capabilities: 'apt_update' }).toArray()) {
    const id = host._id.toHexString();
    if (!isOnline(id) || hasRunningJob(id)) continue;
    const listsAge = host.apt?.listsUpdatedAt ?? 0;
    const lastAuto = host.lastAutoCheckAt?.getTime() ?? 0;
    if (listsAge > threshold || lastAuto > threshold) continue;
    log.info({ host: host.name }, 'scheduled apt update');
    await hosts.updateOne({ _id: host._id }, { $set: { lastAutoCheckAt: new Date() } });
    await createJob(host, 'apt_update', [], 'schedule');
  }

  // same interval for the registry check of the Docker images (one job at a time per host:
  // a host that just got its apt-get update is checked at the next tick)
  for (const host of await hosts.find({ capabilities: 'docker' }).toArray()) {
    const id = host._id.toHexString();
    if (!isOnline(id) || hasRunningJob(id)) continue;
    const checked = host.dockerUpdates?.checkedAt ?? 0;
    const lastAuto = host.lastDockerAutoCheckAt?.getTime() ?? 0;
    if (checked > threshold || lastAuto > threshold) continue;
    log.info({ host: host.name }, 'scheduled docker image check');
    await hosts.updateOne({ _id: host._id }, { $set: { lastDockerAutoCheckAt: new Date() } });
    await createJob(host, 'docker_check', [], 'schedule');
  }
}

export function startScheduler(log: FastifyBaseLogger) {
  const run = () => tick(log).catch((err) => log.error({ err }, 'scheduler failed'));
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, 10 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
