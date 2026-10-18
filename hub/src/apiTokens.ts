// API tokens the agents create on a Proxmox server (PBS: pbsAgent.ts, PVE: pveAgent.ts). A token's
// secret is only readable when it is created: an existing token whose secret the hub does not hold is
// created again by the agent (rotation), the hub only uses tokens it holds the secret of.

// Token id chosen in the UI: user@realm!name, realm of the server's own users (pbs, pve: the user is
// created there), name with a letter first (PVE).
export const TOKEN_FULL_RE = /^([A-Za-z0-9._-]{1,64})@(pbs|pve)!([A-Za-z][A-Za-z0-9._-]{0,31})$/;

export function parseTokenId(id: string, realm: 'pbs' | 'pve') {
  const m = TOKEN_FULL_RE.exec(id);
  return m && m[2] === realm ? { user: `${m[1]}@${m[2]}`, token: m[3] } : null;
}

export type HeldToken = { tokenId: string; tokenSecret: string } | null | undefined;

// The hub holds the secret of this very token: the agent keeps it, otherwise it creates it again.
export const holds = (tokenId: string, held: HeldToken) => !!held && held.tokenId === tokenId && !!held.tokenSecret;

// What the agent answers to a token request (agent/pbs.go, agent/pve.go).
export interface AgentTokenResult {
  tokenId: string;
  secret?: string;
  created: boolean;
  rotated?: boolean;
  applied: string[] | null;
  removed?: string[] | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Secret of the token: the one the agent sent (new or rotated token), or the one the hub holds for this
// same token. fail builds the error of the caller.
export function tokenSecretOf(tokenId: string, secret: string | undefined, held: HeldToken, server: string, fail: (msg: string) => Error) {
  if (secret !== undefined && !UUID_RE.test(secret)) throw fail(`secret du jeton ${tokenId} illisible : le supprimer sur le ${server} et recommencer`);
  const s = secret ?? (holds(tokenId, held) ? held!.tokenSecret : undefined);
  if (!s) throw fail(`le jeton ${tokenId} existe sur le ${server} sans que le hub connaisse son secret, et l'agent ne l'a pas recréé : mettre à jour l'agent`);
  return s;
}
