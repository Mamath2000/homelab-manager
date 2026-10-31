import type { ObjectId } from 'mongodb';
import { AgentRequestError, agentRequest } from './agents.js';
import { hosts } from './db.js';
import type { Measure } from './probeRunners.js';

// A ping measured from the agent of another host (runFrom: { hostId }, homelab#260) instead of the hub.
// unknown: the measure is impossible (source offline, agent too old...); down: the probe is not set up (the source is
// gone and has to be chosen again), which the user has to handle.

interface AgentPing {
  up: boolean;
  latencyMs?: number;
  message?: string;
}

export const SOURCE_GONE = 'source supprimée : à choisir';

// from: the address of the source the ping leaves with (agent capability ping_from); absent: the one its routing picks.
export async function pingFromHost(hostId: ObjectId, address: string, timeoutMs: number, from?: string, request: typeof agentRequest = agentRequest): Promise<Measure> {
  const host = await hosts.findOne({ _id: hostId }, { projection: { name: 1, capabilities: 1 } });
  // not set up: no retries, the user is told at once
  if (!host) return { state: 'down', message: SOURCE_GONE, immediate: true };
  if (!host.capabilities?.includes(from ? 'ping_from' : 'ping')) return { state: 'unknown', message: `agent de ${host.name} trop ancien pour mesurer un ping : mettre à jour l'agent` };
  try {
    const r = await request<AgentPing>(hostId.toHexString(), 'ping', { host: address, ...(from ? { from } : {}), timeoutSec: Math.max(1, Math.ceil(timeoutMs / 1000)) }, timeoutMs + 5000);
    return r.up ? { state: 'up', latencyMs: r.latencyMs } : { state: 'down', message: r.message || 'pas de réponse' };
  } catch (err) {
    if (!(err instanceof AgentRequestError)) throw err;
    return { state: 'unknown', message: err.message === 'hôte hors ligne' ? `source ${host.name} hors ligne` : `source ${host.name} : ${err.message}` };
  }
}
