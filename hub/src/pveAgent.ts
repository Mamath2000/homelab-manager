import { AgentRequestError, agentRequest, isOnline } from './agents.js';
import { type AgentTokenResult, type HeldToken, holds, parseTokenId, tokenSecretOf } from './apiTokens.js';
import { hosts, parseId } from './db.js';
import type { HostDoc } from './types.js';

// Proxmox VE cluster administered through the agent of one of its nodes (agent/pve.go, rpc pve_detect /
// pve_token): what declares the cluster (name, nodes, interfaces, certificate) and the read-only API
// token of the hub. The secret only travels in the rpc answer: never logged, never sent to the UI.

export class PveAgentError extends Error {}

// Rights of the token of the hub, granted to the user AND to the token (privilege separation). Their
// scope is described in docs/sauvegardes.md: keep both in step.
export const PVE_TOKEN_ACLS = [{ path: '/', role: 'PVEAuditor' }];

export const defaultPveTokenId = 'homelab@pve!monitor';

export interface PveIface {
  name: string;
  ips: string[];
  default?: boolean;
}

export interface PveDetected {
  found: boolean;
  version?: string;
  cluster?: string; // empty: standalone node
  node?: string;
  nodes?: string[];
  interfaces?: PveIface[];
  port?: number;
  fingerprint?: string;
}

// The node whose agent administers the cluster: known, able to (agent recent enough), connected.
async function pveHost(hostId: string): Promise<HostDoc> {
  const _id = parseId(hostId);
  const host = _id && (await hosts.findOne({ _id }));
  if (!host) throw new PveAgentError('nœud Proxmox VE introuvable');
  if (!host.capabilities?.includes('pve')) throw new PveAgentError(`l'agent de ${host.name} ne sait pas administrer Proxmox VE : le mettre à jour`);
  if (!isOnline(hostId)) throw new PveAgentError(`l'agent de ${host.name} est hors ligne`);
  return host;
}

export async function detectPveOn(hostId: string): Promise<PveDetected> {
  await pveHost(hostId);
  try {
    const info = await agentRequest<PveDetected>(hostId, 'pve_detect', {}, 75_000);
    return info.found ? info : { found: false };
  } catch (err) {
    throw err instanceof AgentRequestError ? new PveAgentError(err.message) : err;
  }
}

// Creates the token (or updates the rights of an existing one) through the agent of a node. An existing
// token keeps its secret when the hub holds it (held), otherwise the agent creates it again (rotation).
export async function ensurePveToken(hostId: string, tokenId: string, held?: HeldToken) {
  const t = parseTokenId(tokenId, 'pve');
  if (!t) throw new PveAgentError('identifiant du jeton invalide : utilisateur@pve!nom (le nom commence par une lettre)');
  await pveHost(hostId);
  let r: AgentTokenResult;
  try {
    r = await agentRequest<AgentTokenResult>(hostId, 'pve_token', { pve: { user: t.user, token: t.token, acls: PVE_TOKEN_ACLS, rotate: !holds(tokenId, held) } }, 75_000);
  } catch (err) {
    throw err instanceof AgentRequestError ? new PveAgentError(err.message) : err;
  }
  return {
    tokenId,
    tokenSecret: tokenSecretOf(tokenId, r.secret, held, 'cluster', (m) => new PveAgentError(m)),
    created: r.created,
    rotated: !!r.rotated,
    applied: r.applied ?? [],
    removed: r.removed ?? [],
  };
}
