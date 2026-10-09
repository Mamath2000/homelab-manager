import type { FastifyRequest } from 'fastify';
import { loadAgentSettings } from './agentUpdate.js';

export const SAFE_URL = /^https?:\/\/[A-Za-z0-9.\-:[\]]+(\/[A-Za-z0-9._~\-/]*)?$/;

// URL agents use to reach the hub: the agent settings, else the address used in the browser.
// It ends up in a shell script, so it is validated strictly.
export async function hubUrl(req: FastifyRequest) {
  const url = (await loadAgentSettings()).hubUrl || `${req.protocol}://${req.headers.host ?? ''}`;
  return SAFE_URL.test(url) ? url : null;
}

export function installCommand(url: string, token: string) {
  return `curl -fsSL ${url}/install.sh | sh -s -- ${token}`;
}
