import type { GuestDoc, HostDoc } from './types.js';

// Installation of the agent in the CT of a Proxmox VE cluster, from the inventory (homelab#259). Two levels of
// eligibility: the static one needs nothing but the inventory and the agent of the node; the check one comes from the
// agent of the node (rpc pve_guest_check, read-only) and says what the CT really holds.

export const INSTALL_CAPABILITY = 'agent_install:lxc';
export const CHECK_CAPABILITY = 'pve_guest_check';

export interface InstallEligibility {
  eligible: boolean;
  // why not (French, shown as is), or what to know although eligible
  reasons: string[];
}

// What the agent of the node answers for one CT (agent/pve_guest.go)
export interface GuestCheck {
  vmid: number;
  status: string;
  osId?: string;
  idLike?: string;
  versionId?: string;
  arch?: string;
  systemd: boolean;
  curl: boolean;
  apt: boolean;
  agentInstalled: boolean;
  hubReachable?: boolean;
  error?: string;
}

type Carrier = Pick<HostDoc, 'capabilities'> & { online: boolean };

// Without any exec in the CT: the kind of guest, its state and the agent of its node.
// hostHasAgent: the host linked to the CT holds an agent (certificate or legacy token); a revoked or never enrolled host does not,
// and the agent can be installed again for it.
export function staticEligibility(g: Pick<GuestDoc, 'type' | 'status' | 'ambiguous' | 'hostId' | 'ostype'>, carrier: Carrier | null, hostHasAgent = !!g.hostId): InstallEligibility {
  const reasons: string[] = [];
  if (g.type !== 'lxc') reasons.push("seuls les CT sont pris en charge (pas les VM)");
  if (g.hostId && hostHasAgent) reasons.push('déjà relié à un hôte avec agent');
  if (g.ambiguous) reasons.push('adresse MAC ambiguë : aucun hôte ne pourrait être relié');
  if (g.type === 'lxc' && g.status !== 'running') reasons.push("le CT n'est pas démarré");
  if (g.ostype === 'unmanaged') reasons.push('OS non reconnu par Proxmox VE (unmanaged)');
  if (!carrier) reasons.push('aucun agent sur le nœud porteur');
  else if (!carrier.online) reasons.push("l'agent du nœud porteur est hors ligne");
  else if (!carrier.capabilities?.includes(INSTALL_CAPABILITY) || !carrier.capabilities.includes(CHECK_CAPABILITY)) reasons.push("l'agent du nœud porteur est trop ancien : le mettre à jour");
  return { eligible: reasons.length === 0, reasons };
}

const ARCHS = new Set(['x86_64', 'aarch64']);

export interface CheckVerdict extends InstallEligibility {
  // curl is missing and apt can install it first
  installCurl: boolean;
  // an agent is already in the CT (not linked to the hub): it is enrolled again
  relink: boolean;
}

// What the agent of the node found in a running CT: the blocking reasons, else notes on what the installation will do.
export function checkVerdict(c: GuestCheck): CheckVerdict {
  const verdict = (reasons: string[], eligible: boolean, extra: Partial<CheckVerdict> = {}): CheckVerdict => ({ eligible, reasons, installCurl: false, relink: false, ...extra });
  if (c.error) return verdict([c.error], false);
  if (c.status !== 'running') return verdict(["le CT n'est pas démarré"], false);
  const blocking: string[] = [];
  if (!c.systemd) blocking.push('systemd est requis (Alpine, OpenRC… ne sont pas pris en charge)');
  if (!c.arch || !ARCHS.has(c.arch)) blocking.push(`architecture non prise en charge (${c.arch || 'inconnue'})`);
  if (!c.curl && !c.apt) blocking.push("curl absent et apt indisponible pour l'installer");
  if (c.hubReachable === false) blocking.push('le hub est injoignable depuis le CT (port des agents)');
  if (blocking.length) return verdict(blocking, false);
  const notes: string[] = [];
  const installCurl = !c.curl;
  if (installCurl) notes.push("curl sera installé (apt) avant l'agent");
  if (!/(^|\s)(debian|ubuntu)(\s|$)/.test(`${c.osId ?? ''} ${c.idLike ?? ''}`)) notes.push('hors Debian / Ubuntu : sans apt ni standardisation');
  if (c.agentInstalled) notes.push("un agent est déjà installé : il sera enrôlé à nouveau et son lien avec le cluster recréé");
  return verdict(notes, true, { installCurl, relink: c.agentInstalled });
}

export interface InstallTarget {
  vmid: number;
  name: string;
  node: string;
  eligible: boolean;
  reasons: string[];
  // the host of the hub that gets the agent: created, or the one of the same name when an agent is already in the CT
  mode: 'create' | 'reuse' | null;
  hostName: string;
  siteId: string | null;
  tags: string[];
  installCurl: boolean;
  // the host linked to the CT that gets the agent again (revoked or not enrolled)
  hostId?: string;
  // run only
  jobId?: string;
}

export class PveInstallError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
