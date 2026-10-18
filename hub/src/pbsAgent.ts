import { AgentRequestError, agentRequest, isOnline } from './agents.js';
import { hosts, parseId } from './db.js';
import { type AgentTokenDeleteResult, type AgentTokenResult, type HeldToken, holds, parseTokenId, tokenSecretOf as secretOf } from './apiTokens.js';
import type { HostDoc, PbsAgentLink } from './types.js';

// Proxmox Backup Server administered through the agent of the host it runs on (agent/pbs.go, rpc
// pbs_detect / pbs_token): detection, and every API token the hub uses on a PBS (nothing pasted by
// hand). The secret only travels in the rpc answer: never logged, never sent to the UI.

export class PbsAgentError extends Error {}

export interface PbsAcl {
  path: string; // "{store}": the same right on every datastore
  role: string;
}

// Rights of each token (least privilege), granted to the user AND to the token. Their scope is
// described in docs/sauvegardes.md: keep both in step.
export const PBS_TOKEN_ACLS = {
  // supervision of the main PBS: lists datastores, groups and snapshots, reads nothing
  monitor: [{ path: '/datastore', role: 'DatastoreAudit' }],
  // a host: writes and sees its own groups in the namespace Hosts only
  host: [{ path: '/datastore/{store}/Hosts', role: 'DatastoreBackup' }],
  // on the main PBS, used by the secondary to pull: reads every backup, writes nothing
  reader: [{ path: '/datastore', role: 'DatastoreReader' }],
} satisfies Record<string, PbsAcl[]>;

// Token of the hub on the secondary PBS: lists and writes (through the sync jobs it owns) in the target
// datastore, declares the remote and the sync jobs. Neither Datastore.Prune nor Datastore.Modify: it can
// neither delete a snapshot nor create a namespace, nor enable remove-vanished.
export const offsiteHubAcls = (store: string): PbsAcl[] => [
  { path: `/datastore/${store}`, role: 'DatastoreBackup' },
  { path: `/datastore/${store}`, role: 'DatastoreAudit' },
  { path: '/remote', role: 'RemoteAdmin' },
];

export interface PbsDetected {
  found: boolean;
  mode?: 'native' | 'container';
  container?: string;
  version?: string;
  datastores?: string[];
  port?: number; // 0: the container does not publish the API
  fingerprint?: string;
  url?: string; // suggested from the addresses of the host
  tailscaleUrl?: string; // same port, on the Tailscale address of the host (100.64.0.0/10)
}

const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'host';

export const defaultMonitorTokenId = 'homelab@pbs!monitor';
export const defaultHostTokenId = (hostName: string) => `host-${slug(hostName)}@pbs!backup`;

// The host whose agent administers the PBS: known, able to (agent recent enough), connected.
export async function pbsHost(hostId: string, capability = 'pbs'): Promise<HostDoc> {
  const _id = parseId(hostId);
  const host = _id && (await hosts.findOne({ _id }));
  if (!host) throw new PbsAgentError('hôte du PBS introuvable');
  if (!host.capabilities?.includes(capability)) throw new PbsAgentError(`l'agent de ${host.name} ne sait pas administrer un PBS : le mettre à jour`);
  if (!isOnline(hostId)) throw new PbsAgentError(`l'agent de ${host.name} est hors ligne`);
  return host;
}

// First private IPv4 of the host, the address the other machines reach it at (editable in the UI).
export function suggestedUrl(ips: string[] | null | undefined, port: number) {
  const v4 = (ips ?? []).map((ip) => ip.replace(/\/\d+$/, '')).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !ip.startsWith('127.') && !ip.startsWith('169.254.'));
  const lan = v4.find((ip) => ip.startsWith('192.168.') || ip.startsWith('10.')) ?? v4.find((ip) => !/^172\.(1[7-9]|2\d|3[01])\./.test(ip)) ?? v4[0];
  return lan && port ? `https://${lan}:${port}` : '';
}

// Tailscale address of the host (CGNAT range 100.64.0.0/10) with the same port.
export function suggestedTailscaleUrl(ips: string[] | null | undefined, port: number) {
  const ts = (ips ?? []).map((ip) => ip.replace(/\/\d+$/, '')).find((ip) => {
    const m = /^100\.(\d+)\.\d+\.\d+$/.exec(ip);
    return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
  });
  return ts && port ? `https://${ts}:${port}` : '';
}

export async function detectPbsOn(hostId: string): Promise<PbsDetected> {
  const host = await pbsHost(hostId);
  try {
    const info = await agentRequest<PbsDetected>(hostId, 'pbs_detect', {}, 75_000);
    return info.found ? { ...info, url: suggestedUrl(host.info?.ips, info.port ?? 0), tailscaleUrl: suggestedTailscaleUrl(host.info?.ips, info.port ?? 0) } : { found: false };
  } catch (err) {
    throw err instanceof AgentRequestError ? new PbsAgentError(err.message) : err;
  }
}

// Same PBS: the secret the hub holds for a token of another PBS is not the one of this token.
export const sameLink = (a: PbsAgentLink | undefined | null, b: PbsAgentLink) => !!a && a.hostId === b.hostId && a.mode === b.mode && (a.container ?? '') === (b.container ?? '');

export function checkLink(l: PbsAgentLink): string | null {
  if (!parseId(l.hostId)) return 'hôte du PBS invalide';
  if (l.mode !== 'native' && l.mode !== 'container') return 'mode du PBS invalide';
  if (l.mode === 'container' && !CONTAINER_RE.test(l.container ?? '')) return 'nom du conteneur du PBS invalide';
  return null;
}

// Creates the token (or updates the rights of an existing one) through the agent of the PBS. An existing
// token keeps its secret when the hub holds it (held), otherwise the agent creates it again (rotation).
export async function ensurePbsToken(link: PbsAgentLink, tokenId: string, acls: PbsAcl[], held?: HeldToken) {
  const t = parseTokenId(tokenId, 'pbs');
  if (!t) throw new PbsAgentError('identifiant du jeton invalide : utilisateur@pbs!nom (le nom commence par une lettre)');
  const bad = checkLink(link);
  if (bad) throw new PbsAgentError(bad);
  await pbsHost(link.hostId);
  let r: AgentTokenResult;
  try {
    r = await agentRequest<AgentTokenResult>(link.hostId, 'pbs_token', { pbs: { container: link.mode === 'container' ? link.container : '', user: t.user, token: t.token, acls, rotate: !holds(tokenId, held) } }, 75_000);
  } catch (err) {
    throw err instanceof AgentRequestError ? new PbsAgentError(err.message) : err;
  }
  return { tokenId, tokenSecret: tokenSecretOf(tokenId, r.secret, held), created: r.created, rotated: !!r.rotated, applied: r.applied ?? [], removed: r.removed ?? [] };
}

export const tokenSecretOf = (tokenId: string, secret: string | undefined, held?: HeldToken) => secretOf(tokenId, secret, held, 'PBS', (m) => new PbsAgentError(m));

// The agent of the PBS can revoke a token now (connected, recent enough): checked before any step of a
// disconnection, so that it does not stop halfway.
export async function checkPbsRevoker(link: PbsAgentLink | undefined, what: string) {
  if (!link) throw new PbsAgentError(`${what} : PBS non relié à son agent`);
  const bad = checkLink(link);
  if (bad) throw new PbsAgentError(bad);
  await pbsHost(link.hostId, 'pbs_token_delete');
}

// Revokes a token of the hub on the PBS (its rights, the token, the user when it has no token left).
// Backups, groups and their owner stay. An id the hub cannot parse is not its own: left alone.
export async function deletePbsToken(link: PbsAgentLink, tokenId: string): Promise<AgentTokenDeleteResult | null> {
  const t = parseTokenId(tokenId, 'pbs');
  if (!t) return null;
  await pbsHost(link.hostId, 'pbs_token_delete');
  try {
    return await agentRequest<AgentTokenDeleteResult>(link.hostId, 'pbs_token_delete', { pbs: { container: link.mode === 'container' ? link.container : '', user: t.user, token: t.token, acls: [] } }, 75_000);
  } catch (err) {
    throw err instanceof AgentRequestError ? new PbsAgentError(`révocation de ${tokenId} : ${err.message}`) : err;
  }
}
