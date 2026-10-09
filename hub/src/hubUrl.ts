import type { FastifyRequest } from 'fastify';
import { loadAgentSettings } from './agentUpdate.js';
import { loadPki } from './pkiStore.js';

export const SAFE_URL = /^https?:\/\/[A-Za-z0-9.\-:[\]]+(\/[A-Za-z0-9._~\-/]*)?$/;

// URL of the hub UI: the agent settings, else the address used in the browser.
// It ends up in a shell script, so it is validated strictly.
export async function hubUrl(req: FastifyRequest) {
  const url = (await loadAgentSettings()).hubUrl || `${req.protocol}://${req.headers.host ?? ''}`;
  return SAFE_URL.test(url) ? url : null;
}

// Address of the TLS agent server: same host as the hub UI, agent port.
export async function agentUrl(req: FastifyRequest) {
  const base = await hubUrl(req);
  if (!base) return null;
  const { agentPort } = await loadAgentSettings();
  const url = `https://${new URL(base).hostname}:${agentPort}`;
  return SAFE_URL.test(url) ? url : null;
}

// curl checks the pinned key of the agent server; -k only skips the CA / host name checks, which
// the pin replaces (the certificate is issued by the hub's own CA).
export function curlPinned(pin: string) {
  return `curl -fsSLk --pinnedpubkey sha256//${pin}`;
}

export async function agentCommands(req: FastifyRequest) {
  const url = await agentUrl(req);
  if (!url) return null;
  const { serverPin } = await loadPki();
  const curl = curlPinned(serverPin);
  return {
    url,
    install: (code: string) => `${curl} ${url}/install.sh | sh -s -- ${code}`,
    upgrade: `${curl} ${url}/install.sh | sh`,
    uninstall: `${curl} ${url}/install.sh | sh -s -- --uninstall`,
  };
}
