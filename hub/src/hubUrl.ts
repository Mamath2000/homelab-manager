import type { FastifyRequest } from 'fastify';
import { config } from './config.js';

const SAFE_URL = /^https?:\/\/[A-Za-z0-9.\-:[\]]+(\/[A-Za-z0-9._~\-/]*)?$/;

// URL agents use to reach the hub. It ends up in a shell script, so it is validated strictly.
export function hubUrl(req: FastifyRequest) {
  const url = config.publicUrl ?? `${req.protocol}://${req.headers.host ?? ''}`;
  return SAFE_URL.test(url) ? url : null;
}

export function installCommand(url: string, token: string) {
  return `curl -fsSL ${url}/install.sh | sh -s -- ${token}`;
}
