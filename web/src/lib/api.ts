export interface Package {
  name: string;
  current: string;
  candidate: string;
  repo: string;
  security: boolean;
  reboot?: boolean;
}

export interface AptReport {
  checkedAt: number;
  listsUpdatedAt: number;
  upgradable: Package[];
  held: string[];
  rebootRequired: boolean;
  rebootPkgs: string[];
  autoremovable?: string[];
}

export interface HostInfo {
  hostname: string;
  osId: string;
  osName: string;
  kernel: string;
  arch: string;
  uptime: number;
  ips: string[] | null;
  virt: string;
}

export interface AptSummary {
  upgradable: number;
  security: number;
  held: number;
  rebootRequired: boolean;
  rebootPending?: number;
  autoremovable?: number | null;
}

// Docker compose stacks (agent report + update state computed by the hub)
export interface DockerContainer {
  id: string;
  name: string;
  state: string; // running, exited, restarting, paused, created, dead
  status: string;
  health?: string; // healthy, unhealthy, starting
  imageId: string;
}

// available: newer image on the registry; recreate: pulled, container not redeployed yet;
// unknown: never checked or not checkable (local build, pinned digest, private registry...)
export type ImageUpdate = 'available' | 'recreate' | 'uptodate' | 'unknown';
export type StackStatus = 'running' | 'partial' | 'stopped' | 'down';

export interface DockerService {
  name: string;
  image: string;
  containers: DockerContainer[];
  // container outside the compose file (created by another container): logs only, no action
  external?: boolean;
  update: ImageUpdate;
  localDigest: string | null;
  remoteDigest: string | null;
  checkError: string | null;
}

export interface DockerStack {
  name: string;
  // false: managed elsewhere (own update system), read-only, without state, updates nor problems
  managed: boolean;
  workingDir: string;
  configFiles: string[];
  envFiles: string[];
  status: StackStatus;
  services: DockerService[];
  running: number;
  total: number;
  update: ImageUpdate;
  updates: number;
  problems: string[];
}

export interface DockerView {
  engine: string;
  compose: string;
  checkedAt: number;
  updatesCheckedAt: number | null;
  stacks: DockerStack[];
}

export interface DockerSummary {
  stacks: number;
  running: number;
  partial: number;
  stopped: number;
  down: number;
  updates: number;
  problems: number;
  unmanaged: number;
}

export interface ComposeFile {
  path: string;
  content: string;
  masked?: boolean;
}

export interface Host {
  id: string;
  name: string;
  group: string;
  createdAt: string;
  enrolledAt: string | null;
  lastSeenAt: string | null;
  online: boolean;
  agentVersion: string | null;
  // cert: TLS client certificate; legacy: plain-text token of the first versions, reinstall needed;
  // none: not enrolled yet, or revoked
  agentAuth: 'cert' | 'legacy' | 'none';
  certIssuedAt: string | null;
  // pending install command (single-use code), null once used or expired
  enrollExpiresAt: string | null;
  capabilities: string[];
  recentlyInstalled: { name: string; from: string; to: string; at: number; rebootRequired: boolean }[];
  // null: unknown (never connected, or no binary for its architecture)
  agentOutdated: boolean | null;
  latestAgentVersion: string | null;
  info: HostInfo | null;
  apt: AptReport | null;
  aptSummary: AptSummary | null;
  docker: DockerView | null;
  dockerSummary: DockerSummary | null;
  // standardisation: user set on this host (null: the profile's), last conformity check
  setupUser: string | null;
  setup: SetupState | null;
}

export const SETUP_MODULES = ['user', 'apt_proxy', 'packages', 'ssh_keys', 'ssh_config', 'aliases', 'prompt', 'motd', 'ssh_password'] as const;
export type SetupModule = (typeof SETUP_MODULES)[number];

export interface SetupState {
  checkedAt: number;
  user: string;
  modules: { module: SetupModule; state: 'ok' | 'drift' | 'na' | 'error'; detail?: string }[];
  // modules that differ from the standard configuration
  drift: number;
}

export interface SetupProfile {
  autoApply: boolean;
  modules: SetupModule[];
  user: string;
  sudoNoPassword: boolean;
  packages: string[];
  sshKeys: string[];
  allowPassword: boolean;
  aliases: string;
  prompt: 'none' | 'classic' | 'starship';
  motd: 'none' | 'homelab' | 'fastfetch';
  aptProxy: string;
  sshConfig: string;
}

export type StackAction = 'docker_up' | 'docker_stop' | 'docker_restart' | 'docker_update';
export type JobAction = 'apt_report' | 'apt_update' | 'apt_upgrade' | 'apt_autoremove' | 'reboot' | 'agent_update' | 'docker_check' | StackAction | 'setup_apply';
export type JobStatus = 'running' | 'success' | 'failed';

export interface Job {
  id: string;
  hostId: string;
  hostName: string;
  action: JobAction;
  packages: string[];
  stack: string | null;
  service: string | null;
  modules: SetupModule[] | null;
  trigger: 'manual' | 'schedule' | 'homeassistant' | 'enroll';
  status: JobStatus;
  createdAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  log?: string;
}

export type Role = 'admin' | 'operator' | 'viewer';

export interface Me {
  username: string;
  displayName: string;
  role: Role | 'superadmin';
  // temporary password: it must be replaced before using the app
  mustChangePassword: boolean;
}

export interface AuthStatus {
  // fresh install: log in as superadmin with the password printed in the hub logs
  noAccounts: boolean;
  user: Me | null;
}

export interface Account {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  createdAt: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
}

export interface AccountWithPassword {
  user: Account;
  temporaryPassword: string;
}

export interface HomeAssistantSettings {
  enabled: boolean;
  broker: string;
  username: string;
  hasPassword: boolean;
  topic: string;
  discoveryPrefix: string;
  publicUrl: string;
  status: {
    state: 'disabled' | 'connecting' | 'connected' | 'error';
    error: string | null;
    devices: number;
    lastPublishAt: string | null;
  };
}

export interface HomeAssistantInput {
  enabled: boolean;
  broker: string;
  username: string;
  password?: string;
  topic: string;
  discoveryPrefix: string;
  publicUrl: string;
}

export interface AgentSettings {
  autoUpdate: boolean;
  hubUrl: string; // empty: the address used in the browser
  checkIntervalHours: number;
  agentPort: number; // TLS port given to the agents (published port of the hub)
  // signed: release signature checked by the agents (unsigned: development build)
  binaries: { arch: string; sha256: string; version: string | null; signed: boolean }[];
  tls: {
    agentUrl: string | null; // null: invalid hub URL
    serverPin: string;
    caFingerprint: string;
    upgradeCommand: string | null;
    uninstallCommand: string | null;
  };
}

export interface InstallInfo {
  installCommand: string | null; // null: invalid hub URL
  expiresAt: string;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('hm:unauthorized'));
    throw new ApiError(res.status, data.error ?? data.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export const api = {
  authStatus: () => request<AuthStatus>('GET', '/api/auth/status'),
  login: (username: string, password: string) =>
    request<Me>('POST', '/api/auth/login', { username, password }),
  logout: () => request('POST', '/api/auth/logout'),
  changePassword: (currentPassword: string | undefined, newPassword: string) =>
    request('POST', '/api/account/password', { currentPassword, newPassword }),

  users: () => request<Account[]>('GET', '/api/users'),
  createUser: (username: string, displayName: string, role: Role) =>
    request<AccountWithPassword>('POST', '/api/users', { username, displayName, role }),
  updateUser: (id: string, patch: { username?: string; displayName?: string; role?: Role }) =>
    request<Account>('PATCH', `/api/users/${id}`, patch),
  deleteUser: (id: string) => request<void>('DELETE', `/api/users/${id}`),
  resetPassword: (id: string) => request<AccountWithPassword>('POST', `/api/users/${id}/reset-password`),

  hosts: () => request<Host[]>('GET', '/api/hosts'),
  createHost: (name: string, group: string) =>
    request<{ host: Host } & InstallInfo>('POST', '/api/hosts', { name, group }),
  updateHost: (id: string, patch: { name?: string; group?: string }) => request<Host>('PATCH', `/api/hosts/${id}`, patch),
  deleteHost: (id: string) => request<void>('DELETE', `/api/hosts/${id}`),
  enrollHost: (id: string) => request<InstallInfo>('POST', `/api/hosts/${id}/enroll`),
  revokeHost: (id: string) => request<Host>('POST', `/api/hosts/${id}/revoke`),

  homeAssistant: () => request<HomeAssistantSettings>('GET', '/api/settings/homeassistant'),
  saveHomeAssistant: (s: HomeAssistantInput) => request<HomeAssistantSettings>('PUT', '/api/settings/homeassistant', s),
  testHomeAssistant: (s: HomeAssistantInput) =>
    request<{ ok: boolean; error?: string }>('POST', '/api/settings/homeassistant/test', s),
  republishHomeAssistant: () => request<{ ok: boolean }>('POST', '/api/settings/homeassistant/republish'),

  agentSettings: () => request<AgentSettings>('GET', '/api/settings/agents'),
  saveAgentSettings: (patch: Partial<Pick<AgentSettings, 'autoUpdate' | 'hubUrl' | 'checkIntervalHours' | 'agentPort'>>) =>
    request<AgentSettings>('PUT', '/api/settings/agents', patch),

  jobs: (limit = 100) => request<Job[]>('GET', `/api/jobs?limit=${limit}`),
  hostJobs: (id: string) => request<Job[]>('GET', `/api/hosts/${id}/jobs`),
  job: (id: string) => request<Job>('GET', `/api/jobs/${id}`),
  runJob: (hostId: string, action: JobAction, packages?: string[], target?: { stack: string; service?: string }) =>
    request<Job>('POST', `/api/hosts/${hostId}/jobs`, { action, packages, ...target }),

  stackLogs: (hostId: string, stack: string, service: string | undefined, tail: number) =>
    request<{ logs: string }>(
      'GET',
      `/api/hosts/${hostId}/stacks/${encodeURIComponent(stack)}/logs?tail=${tail}${service ? `&service=${encodeURIComponent(service)}` : ''}`,
    ),
  stackCompose: (hostId: string, stack: string) =>
    request<{ files: ComposeFile[] }>('GET', `/api/hosts/${hostId}/stacks/${encodeURIComponent(stack)}/compose`),
  forgetStack: (hostId: string, stack: string) => request<void>('DELETE', `/api/hosts/${hostId}/stacks/${encodeURIComponent(stack)}`),
  setStackManaged: (hostId: string, stack: string, managed: boolean) =>
    request<Host>('PUT', `/api/hosts/${hostId}/stacks/${encodeURIComponent(stack)}/managed`, { managed }),
  runBulk: (hostIds: string[], action: JobAction) => request<Job[]>('POST', '/api/jobs/bulk', { hostIds, action }),

  setupProfile: () => request<SetupProfile>('GET', '/api/settings/setup'),
  saveSetupProfile: (p: SetupProfile) => request<SetupProfile>('PUT', '/api/settings/setup', p),
  setupStandard: () => request<{ modules: SetupModule[]; user: string; autoApply: boolean }>('GET', '/api/setup'),
  applySetup: (hostId: string, modules: SetupModule[], user: string) =>
    request<Job>('POST', `/api/hosts/${hostId}/jobs`, { action: 'setup_apply', modules, user }),
  checkSetup: (hostId: string) => request<Host>('POST', `/api/hosts/${hostId}/setup/check`),
};
