import type { ObjectId } from 'mongodb';
import { agentOutdated } from './agentBinaries.js';
import { isOnline } from './agents.js';
import { config } from './config.js';
import { hosts, settings } from './db.js';
import { createJob, hasRunningJob } from './jobs.js';
import type { AgentSettings, HostDoc } from './types.js';

const RETRY_MS = 3600 * 1000;

export async function loadAgentSettings(): Promise<AgentSettings> {
  const s = (await settings.findOne({ _id: 'agents' })) as AgentSettings | null;
  return { _id: 'agents', autoUpdate: s?.autoUpdate ?? true, hubUrl: s?.hubUrl ?? '', agentPort: s?.agentPort ?? config.agentTlsPort, checkIntervalHours: s?.checkIntervalHours ?? 12 };
}

export function canSelfUpdate(h: HostDoc) {
  return !!h.capabilities?.includes('agent_update');
}

// Starts an agent_update job when the agent is outdated, able to update itself, idle,
// and was not already asked within the last hour (a failing update must not loop).
export async function maybeAutoUpdate(id: ObjectId) {
  if (!(await loadAgentSettings()).autoUpdate) return false;
  const h = await hosts.findOne({ _id: id });
  if (!h || !canSelfUpdate(h) || agentOutdated(h) !== true) return false;
  const hid = h._id.toHexString();
  if (!isOnline(hid) || hasRunningJob(hid)) return false;
  if (h.lastAgentUpdateAt && Date.now() - h.lastAgentUpdateAt.getTime() < RETRY_MS) return false;
  await hosts.updateOne({ _id: h._id }, { $set: { lastAgentUpdateAt: new Date() } });
  await createJob(h, 'agent_update', [], 'schedule');
  return true;
}
