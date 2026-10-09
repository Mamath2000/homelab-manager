import type { FastifyBaseLogger } from 'fastify';
import { isOnline } from './agents.js';
import { config } from './config.js';
import { hosts } from './db.js';
import { createJob, hasRunningJob } from './jobs.js';

// Asks every online agent to refresh its package lists when they are older than the interval.
async function tick(log: FastifyBaseLogger) {
  const intervalMs = config.checkIntervalHours * 3600 * 1000;
  const threshold = Date.now() - intervalMs;
  for (const host of await hosts.find().toArray()) {
    const id = host._id.toHexString();
    if (!isOnline(id) || hasRunningJob(id)) continue;
    const listsAge = host.apt?.listsUpdatedAt ?? 0;
    const lastAuto = host.lastAutoCheckAt?.getTime() ?? 0;
    if (listsAge > threshold || lastAuto > threshold) continue;
    log.info({ host: host.name }, 'scheduled apt update');
    await hosts.updateOne({ _id: host._id }, { $set: { lastAutoCheckAt: new Date() } });
    await createJob(host, 'apt_update', [], 'schedule');
  }
}

export function startScheduler(log: FastifyBaseLogger) {
  if (config.checkIntervalHours <= 0) return () => {};
  const run = () => tick(log).catch((err) => log.error({ err }, 'scheduler failed'));
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, 10 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
