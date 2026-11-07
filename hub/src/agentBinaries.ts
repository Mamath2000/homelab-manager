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
  // release signatures next to the binary, v1 (.sig, agents below the floor) and v2 (.sig2, version signed); unsigned:
  // development build
  signed: boolean;
  // version floor embedded in the release agents (agent/MIN_VERSION): they refuse any update below it (null: development)
  floor: string | null;
}

// sha256 of the binaries served to agents, recomputed only when a file changes
const cache = new Map<string, { mtimeMs: number; size: number; sha256: string }>();

export function agentBinaryPath(arch: string, os: AgentOs = 'linux') {
  return join(config.agentBinDir, `homelab-agent-${os}-${arch}${os === 'windows' ? '.exe' : ''}`);
}

// OS of the agent of a host, from its hello
export const hostOs = (h: Pick<HostDoc, 'info'>): AgentOs => (h.info?.osId === 'windows' ? 'windows' : 'linux');

// Client image of the backups the release agents trust, written next to the binaries at build time (by digest);
// absent (development build): the tag, which development agents accept as any other image.
export function defaultClientImage() {
  try {
    return readFileSync(join(config.agentBinDir, 'CLIENT_IMAGE'), 'utf8').trim() || FALLBACK_CLIENT_IMAGE;
  } catch {
    return FALLBACK_CLIENT_IMAGE;
  }
}
const FALLBACK_CLIENT_IMAGE = 'mathmath350/pbs-client:latest';

// Version written next to the binaries at build time (agent/dist/VERSION), and version floor of a release build.
function binariesFile(name: string) {
  try {
    return readFileSync(join(config.agentBinDir, name), 'utf8').trim() || null;
  } catch {
    return null;
  }
}
const binariesVersion = () => binariesFile('VERSION');

// X.Y.Z only (a development version such as 1.0.12-dev is not comparable): -1, 0, 1, or null when either is not one.
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const parse = (v: string | null | undefined) => (v && /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
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
  return {
    os,
    arch,
    sha256: c.sha256,
    version: binariesVersion(),
    signed: existsSync(`${file}.sig`) && existsSync(`${file}.sig2`),
    floor: binariesFile('MIN_VERSION'),
  };
}

// the binary the hub distributes for the OS and architecture of this host
export const hostBinary = (h: Pick<HostDoc, 'info'>) => agentBinary(h.info?.arch, hostOs(h));

// null: unknown (never connected, or no binary for this architecture on the hub), or an agent
// without certificate: it can't connect any more and its reinstallation brings the current binary
export function agentOutdated(h: HostDoc): boolean | null {
  if (!h.enrolledAt || !h.info || !h.certFingerprint) return null;
  const bin = hostBinary(h);
  if (!bin) return null;
  // an agent newer than what this hub distributes (hub rolled back, HAOS app behind), or whose floor is above it,
  // would refuse the binary (anti-rollback): nothing to update
  if (agentAhead(h)) return false;
  // agents older than the self-update feature do not report their hash; same version, other binary (toolchain,
  // client image): an update
  return h.agentHash !== bin.sha256;
}

// The agent runs a newer version than the binary of this hub, or refuses it (below its version floor).
export function agentAhead(h: Pick<HostDoc, 'info' | 'agentVersion' | 'agentMinVersion'>): boolean {
  const bin = hostBinary(h);
  if (!bin?.version) return false;
  return compareVersions(h.agentVersion, bin.version) === 1 || compareVersions(h.agentMinVersion, bin.version) === 1;
}
