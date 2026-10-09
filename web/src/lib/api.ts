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

export interface Host {
  id: string;
  name: string;
  group: string;
  createdAt: string;
  enrolledAt: string | null;
  lastSeenAt: string | null;
  online: boolean;
  agentVersion: string | null;
  capabilities: string[];
  // null: unknown (never connected, or no binary for its architecture)
  agentOutdated: boolean | null;
  latestAgentVersion: string | null;
  info: HostInfo | null;
  apt: AptReport | null;
  aptSummary: AptSummary | null;
}

export type JobAction = 'apt_report' | 'apt_update' | 'apt_upgrade' | 'apt_autoremove' | 'reboot' | 'agent_update';
export type JobStatus = 'running' | 'success' | 'failed';

export interface Job {
  id: string;
  hostId: string;
  hostName: string;
  action: JobAction;
  packages: string[];
  trigger: 'manual' | 'schedule' | 'homeassistant';
  status: JobStatus;
  createdAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  log?: string;
}

export interface AuthStatus {
  setupRequired: boolean;
  user: { username: string } | null;
}

export interface HomeAssistantSettings {
  enabled: boolean;
  broker: string;
  username: string;
  hasPassword: boolean;
  topic: string;
  discoveryPrefix: string;
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
}

export interface AgentSettings {
  autoUpdate: boolean;
  binaries: { arch: string; sha256: string; version: string | null }[];
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
  setup: (username: string, password: string) => request('POST', '/api/auth/setup', { username, password }),
  login: (username: string, password: string) => request('POST', '/api/auth/login', { username, password }),
  logout: () => request('POST', '/api/auth/logout'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request('POST', '/api/account/password', { currentPassword, newPassword }),

  hosts: () => request<Host[]>('GET', '/api/hosts'),
  createHost: (name: string, group: string) =>
    request<{ host: Host; token: string; installCommand: string | null }>('POST', '/api/hosts', { name, group }),
  updateHost: (id: string, patch: { name?: string; group?: string }) => request<Host>('PATCH', `/api/hosts/${id}`, patch),
  deleteHost: (id: string) => request<void>('DELETE', `/api/hosts/${id}`),
  regenerateToken: (id: string) =>
    request<{ token: string; installCommand: string | null }>('POST', `/api/hosts/${id}/token`),

  homeAssistant: () => request<HomeAssistantSettings>('GET', '/api/settings/homeassistant'),
  saveHomeAssistant: (s: HomeAssistantInput) => request<HomeAssistantSettings>('PUT', '/api/settings/homeassistant', s),
  testHomeAssistant: (s: HomeAssistantInput) =>
    request<{ ok: boolean; error?: string }>('POST', '/api/settings/homeassistant/test', s),

  agentSettings: () => request<AgentSettings>('GET', '/api/settings/agents'),
  saveAgentSettings: (autoUpdate: boolean) => request<AgentSettings>('PUT', '/api/settings/agents', { autoUpdate }),

  jobs: (limit = 100) => request<Job[]>('GET', `/api/jobs?limit=${limit}`),
  hostJobs: (id: string) => request<Job[]>('GET', `/api/hosts/${id}/jobs`),
  job: (id: string) => request<Job>('GET', `/api/jobs/${id}`),
  runJob: (hostId: string, action: JobAction, packages?: string[]) =>
    request<Job>('POST', `/api/hosts/${hostId}/jobs`, { action, packages }),
  runBulk: (hostIds: string[], action: JobAction) => request<Job[]>('POST', '/api/jobs/bulk', { hostIds, action }),
};
