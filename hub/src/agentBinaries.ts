import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import type { HostDoc } from './types.js';

export const AGENT_ARCHES = ['amd64', 'arm64'] as const;

export interface AgentBinary {
  arch: string;
  sha256: string;
  version: string | null;
}

// sha256 of the binaries served to agents, recomputed only when a file changes
const cache = new Map<string, { mtimeMs: number; size: number; sha256: string }>();

export function agentBinaryPath(arch: string) {
  return join(config.agentBinDir, `homelab-agent-linux-${arch}`);
}

// Version written next to the binaries at build time (agent/dist/VERSION).
function binariesVersion() {
  try {
    return readFileSync(join(config.agentBinDir, 'VERSION'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function agentBinary(arch: string | undefined): AgentBinary | null {
  if (!arch || !(AGENT_ARCHES as readonly string[]).includes(arch)) return null;
  const file = agentBinaryPath(arch);
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  let c = cache.get(arch);
  if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
    c = { mtimeMs: st.mtimeMs, size: st.size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
    cache.set(arch, c);
  }
  return { arch, sha256: c.sha256, version: binariesVersion() };
}

// null: unknown (never connected, or no binary for this architecture on the hub), or an agent
// without certificate: it can't connect any more and its reinstallation brings the current binary
export function agentOutdated(h: HostDoc): boolean | null {
  if (!h.enrolledAt || !h.info || !h.certFingerprint) return null;
  const bin = agentBinary(h.info.arch);
  if (!bin) return null;
  // agents older than the self-update feature do not report their hash
  return h.agentHash !== bin.sha256;
}
