import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import type { HostDoc } from './types.js';

export type AgentOs = 'linux' | 'windows';

// binaries built by agent/build.sh
export const AGENT_TARGETS: { os: AgentOs; arch: string }[] = [
  { os: 'linux', arch: 'amd64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'windows', arch: 'amd64' },
];

export interface AgentBinary {
  os: AgentOs;
  arch: string;
  sha256: string;
  version: string | null;
  // release signature next to the binary (unsigned: development build)
  signed: boolean;
}

// sha256 of the binaries served to agents, recomputed only when a file changes
const cache = new Map<string, { mtimeMs: number; size: number; sha256: string }>();

export function agentBinaryPath(arch: string, os: AgentOs = 'linux') {
  return join(config.agentBinDir, `homelab-agent-${os}-${arch}${os === 'windows' ? '.exe' : ''}`);
}

// OS of the agent of a host, from its hello
export const hostOs = (h: Pick<HostDoc, 'info'>): AgentOs => (h.info?.osId === 'windows' ? 'windows' : 'linux');

// Version written next to the binaries at build time (agent/dist/VERSION).
function binariesVersion() {
  try {
    return readFileSync(join(config.agentBinDir, 'VERSION'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function agentBinary(arch: string | undefined, os: AgentOs = 'linux'): AgentBinary | null {
  if (!arch || !AGENT_TARGETS.some((t) => t.os === os && t.arch === arch)) return null;
  const file = agentBinaryPath(arch, os);
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  let c = cache.get(file);
  if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
    c = { mtimeMs: st.mtimeMs, size: st.size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
    cache.set(file, c);
  }
  return { os, arch, sha256: c.sha256, version: binariesVersion(), signed: existsSync(`${file}.sig`) };
}

// the binary the hub distributes for the OS and architecture of this host
export const hostBinary = (h: Pick<HostDoc, 'info'>) => agentBinary(h.info?.arch, hostOs(h));

// null: unknown (never connected, or no binary for this architecture on the hub), or an agent
// without certificate: it can't connect any more and its reinstallation brings the current binary
export function agentOutdated(h: HostDoc): boolean | null {
  if (!h.enrolledAt || !h.info || !h.certFingerprint) return null;
  const bin = hostBinary(h);
  if (!bin) return null;
  // agents older than the self-update feature do not report their hash
  return h.agentHash !== bin.sha256;
}
