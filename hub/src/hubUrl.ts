import type { FastifyRequest } from 'fastify';
import type { AccessNetwork } from './types.js';
import { loadAgentSettings } from './agentUpdate.js';
import { loadPki } from './pkiStore.js';

export const SAFE_URL = /^https?:\/\/[A-Za-z0-9.\-:[\]]+(\/[A-Za-z0-9._~\-/]*)?$/;

// URL of the hub UI: the agent settings, else the address used in the browser.
// It ends up in a shell script, so it is validated strictly.
export async function hubUrl(req: FastifyRequest) {
  const url = (await loadAgentSettings()).hubUrl || `${req.protocol}://${req.headers.host ?? ''}`;
  return SAFE_URL.test(url) ? url : null;
}

// Host name or IP typed by hand for the hub on the tailnet (no scheme, no port).
export const TAILSCALE_HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$|^\[[0-9A-Fa-f:]+\]$/;

// Address of the TLS agent server: same host as the hub UI, agent port; on the Tailscale access
// network, the host typed in the agent settings (null while it is empty).
export async function agentUrl(req: FastifyRequest, network: AccessNetwork = 'lan') {
  const { agentPort, tailscaleHub } = await loadAgentSettings();
  if (network === 'tailscale') {
    const url = `https://${tailscaleHub}:${agentPort}`;
    return tailscaleHub && TAILSCALE_HOST.test(tailscaleHub) && SAFE_URL.test(url) ? url : null;
  }
  const base = await hubUrl(req);
  if (!base) return null;
  const url = `https://${new URL(base).hostname}:${agentPort}`;
  return SAFE_URL.test(url) ? url : null;
}

// Address the scripts served on the agent port bake in: the one the agent used to fetch them, when it
// is the Tailscale address of the hub (otherwise a LAN agent could be handed an address it cannot reach).
export async function agentUrlOfRequest(req: FastifyRequest) {
  const { tailscaleHub } = await loadAgentSettings();
  const asked = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  return agentUrl(req, tailscaleHub && asked === tailscaleHub.toLowerCase() ? 'tailscale' : 'lan');
}

// curl checks the pinned key of the agent server; -k only skips the CA / host name checks, which
// the pin replaces (the certificate is issued by the hub's own CA).
export function curlPinned(pin: string) {
  return `curl -fsSLk --pinnedpubkey sha256//${pin}`;
}

export async function agentCommands(req: FastifyRequest, network: AccessNetwork = 'lan') {
  const url = await agentUrl(req, network);
  if (!url) return null;
  const { serverPin } = await loadPki();
  const curl = curlPinned(serverPin);
  return {
    url,
    install: (code: string) => `${curl} ${url}/install.sh | sh -s -- ${code}`,
    upgrade: `${curl} ${url}/install.sh | sh`,
    uninstall: `${curl} ${url}/install.sh | sh -s -- --uninstall`,
    // Home Assistant OS add-on: what the install command carries, as one value to paste in its options
    haosToken: (code: string) => haosToken(url, serverPin, code),
  };
}

export function haosToken(hub: string, pin: string, code: string) {
  return Buffer.from(JSON.stringify({ hub, pin, code })).toString('base64url');
}
