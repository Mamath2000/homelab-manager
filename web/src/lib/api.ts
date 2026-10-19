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
  macs?: string[] | null;
}

// UPS reported by the agent (NUT); numbers are absent when the UPS does not report them.
export interface UpsReport {
  checkedAt: number;
  name: string;
  model: string;
  driver: string;
  status: string; // ups.status flags: OL OB LB RB CHRG DISCHRG ALARM...
  charge?: number; // %
  chargeWarning?: number;
  chargeLow?: number;
  runtime?: number; // seconds
  runtimeLow?: number;
  load?: number; // %
  inputVoltage?: number;
  inputNominal?: number;
  batteryVoltage?: number;
  batteryNominal?: number;
  testResult?: string;
  beeper?: string;
  mfrDate?: string;
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
  // false: managed elsewhere and read-only; state and problems are suppressed, image updates are informational
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

export type AccessNetwork = 'lan' | 'tailscale';

export interface Host {
  id: string;
  name: string;
  // site of the settings (null: none) and tags of the catalog, by id
  siteId: string | null;
  tags: string[];
  createdAt: string;
  enrolledAt: string | null;
  lastSeenAt: string | null;
  online: boolean;
  // not connected permanently: offline is its normal state
  roaming: boolean;
  // offline connectivity is critical for this host
  critical: boolean;
  // not published to Home Assistant
  haExcluded: boolean;
  // network the agent reaches the hub and the PBS through, fixed at creation
  accessNetwork: AccessNetwork;
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
  // UPS monitored by NUT on the host, null: none
  ups: UpsReport | null;
  // standardisation: values of this host that differ from the standard, last conformity check
  setupOverrides: SetupOverrides;
  setup: SetupState | null;
  // Proxmox VE guest this host is (one of its MAC addresses), null: none or not a single one
  pve: HostPveLink | null;
  // OS of the agent (windows: presence, info and sessions only)
  osFamily: 'linux' | 'windows';
  // Windows: path of the backup CLI set in the options (checked by the agent: capability backup:cli)
  backupClientPath: string | null;
  // Windows: user sessions, last report of the agent (null: none yet)
  sessions: SessionReport | null;
  sessionSummary: { users: string[]; loggedIn: boolean; locked: boolean; interactive: boolean; changedAt: number | null } | null;
}

export interface HostSession {
  id: number;
  user: string;
  domain?: string;
  station?: string; // Console, RDP-Tcp#0...
  state: 'active' | 'locked' | 'disconnected';
  logonAt?: number; // unix ms
  stateAt?: number; // unix ms, last change of state (logon, lock, unlock, disconnection)
  interactive?: boolean; // input within the last minute
  idleSec?: number; // seconds since the last input, at the time of the report
}

export interface SessionReport {
  checkedAt: number; // unix ms
  sessions: HostSession[];
}

export interface HostPveLink {
  cluster: string;
  vmid: number;
  type: 'lxc' | 'qemu';
  node: string;
  name: string;
  covered: boolean; // part of an enabled backup job
}

// options of the standardisation (see hub/src/types.ts)
export const SETUP_OPTIONS = [
  'packages',
  'ssh_password',
  'root_keys',
  'root_aliases',
  'root_prompt',
  'root_motd',
  'user',
  'user_keys',
  'user_aliases',
  'user_prompt',
  'user_motd',
] as const;
export type SetupOption = (typeof SETUP_OPTIONS)[number];
export type PromptStyle = 'none' | 'classic' | 'starship';
export type MotdStyle = 'none' | 'homelab' | 'fastfetch';

export interface SetupValues {
  packages: string[];
  ssh_password: boolean;
  root_keys: string[];
  root_aliases: string;
  root_prompt: PromptStyle;
  root_motd: MotdStyle;
  user: { name: string; sudoNoPassword: boolean };
  user_keys: string[];
  user_aliases: string;
  user_prompt: PromptStyle;
  user_motd: MotdStyle;
}
export const LIST_OPTIONS: readonly SetupOption[] = ['packages', 'root_keys', 'user_keys'];
export type SetupOptions = { [K in SetupOption]: { enabled: boolean; value: SetupValues[K] } };
export type SetupOverride<K extends SetupOption> = { mode: 'off' } | { mode: 'custom'; value: SetupValues[K] } | { mode: 'extra'; add: string[] };
export type SetupOverrides = { [K in SetupOption]?: SetupOverride<K> };

export interface SetupState {
  checkedAt: number;
  user: string;
  modules: { module: SetupOption; state: 'ok' | 'drift' | 'na' | 'error'; detail?: string }[];
  // options that differ from the values of the host
  drift: number;
}

export interface SetupProfile {
  autoApply: boolean;
  options: SetupOptions;
  fastfetch: string;
  starship: string;
}

export type StackAction = 'docker_up' | 'docker_stop' | 'docker_restart' | 'docker_update';
export type JobAction = 'apt_report' | 'apt_update' | 'apt_upgrade' | 'apt_autoremove' | 'reboot' | 'agent_update' | 'docker_check' | StackAction | 'setup_apply' | 'backup_run' | 'backup_install' | 'offsite_run';
export type JobStatus = 'running' | 'success' | 'failed';

export interface Job {
  id: string;
  hostId: string;
  hostName: string;
  action: JobAction;
  packages: string[];
  stack: string | null;
  service: string | null;
  modules: SetupOption[] | null;
  backupJobName?: string | null;
  method?: 'apt' | 'docker' | null;
  trigger: 'manual' | 'schedule' | 'homeassistant' | 'enroll';
  status: JobStatus;
  createdAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  log?: string;
}

// Alerts of a host for one day (timeline of the host page): latest observed level of the day in each domain and
// its reasons; null: not followed that day (no APT, agent not connected...)
export type AlertLevel = 'ok' | 'warn' | 'alert';
// Instant commands the UI offers on the UPS (same list as hub and agent)
export type UpsCommand = 'beeper.enable' | 'beeper.disable' | 'beeper.mute' | 'test.battery.start.quick';

export interface DayAlert {
  level: AlertLevel;
  reasons: string[];
}
export interface HostAlertDay {
  day: string;
  domains: Record<string, DayAlert | null>;
}

// Live status (hub monitoring.ts): domains (connection, updates, backups...) and, in each, the followed
// elements. Domains are given by the hub, the interface does not list them.
// A domain missing from a host does not apply to it; unknown: it applies but cannot be read now.
export interface DomainMeta {
  id: string;
  label: string;
  icon: string;
}
export interface Check {
  key: string;
  label: string;
  level: AlertLevel;
  reason?: string;
}
export interface DomainStatus {
  level: AlertLevel | 'unknown';
  checks: Check[];
  reason?: string;
}
export interface HostStatus {
  level: AlertLevel;
  domains: Record<string, DomainStatus | undefined>;
}
export interface StatusView {
  domains: DomainMeta[];
  hosts: Record<string, HostStatus | undefined>;
}

// Sites described in the settings (display order of the dashboard), one per host.
export type SiteKind = 'main' | 'vpn' | 'external';
export interface SiteConfig {
  id: string;
  name: string;
  kind: SiteKind;
  color: TagColor;
}

// Tags of the hosts (several per host), colour chosen at creation (see hub TAG_COLORS).
export const TAG_COLORS = ['zinc', 'red', 'orange', 'amber', 'lime', 'emerald', 'teal', 'sky', 'blue', 'violet', 'pink'] as const;
export type TagColor = (typeof TAG_COLORS)[number];
export interface TagConfig {
  id: string;
  name: string;
  color: TagColor;
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

export interface ApiKey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Account {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  createdAt: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  // no password: the account only opens with its API key
  hasPassword: boolean;
  apiKeys: ApiKey[];
}

// Secret shown once: a temporary password or a new API key; none for an account created without password
export interface AccountSecret {
  user: Account;
  temporaryPassword?: string;
  apiKey?: string;
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
  tailscaleHub: string; // hub on the tailnet (host or IP); empty: the Tailscale access network is not offered
  // signed: release signature checked by the agents (unsigned: development build)
  binaries: { os: 'linux' | 'windows'; arch: string; sha256: string; version: string | null; signed: boolean }[];
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
  haosToken: string | null; // Home Assistant OS add-on (same code), null: invalid hub URL
  expiresAt: string;
}

export class ApiError extends Error {
  status: number;
  // the whole answer (flags of some errors, e.g. edit: the form is to open)
  data: Record<string, unknown>;
  constructor(status: number, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.data = data;
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
    throw new ApiError(res.status, data.error ?? data.message ?? `HTTP ${res.status}`, data);
  }
  return data as T;
}

// Backups of the Proxmox Backup Server (hub/src/pbs.ts)
export type BackupState = 'ok' | 'stale' | 'failed' | 'gone' | 'task_failed' | 'disabled' | 'not_synced';

// PVE backup job writing a group (hub/src/pve.ts)
export interface PveJobRef {
  id: string;
  schedule: string;
  scheduleText: string;
  enabled: boolean;
  nextRun: number | null;
  storage: string;
  store: string | null;
  ns: string | null;
}

export interface PveTaskResult {
  upid: string;
  at: number;
  ok: boolean;
  error?: string;
}

export interface BackupSnapshot {
  t: number;
  verify: 'ok' | 'failed' | null;
  size?: number | null;
  note?: string | null;
  automatic?: boolean; // Home Assistant: made by the automatic backups
}

export interface BackupGroup {
  id: string;
  store: string;
  ns: string;
  type: string; // host | vm | ct
  backupId: string;
  comment?: string;
  owner?: string;
  count: number;
  lastBackup: number;
  size: number | null;
  verify: 'ok' | 'failed' | null;
  hostId: string | null;
  staleHours?: number | null;
  gone?: boolean;
  seenAt: string;
  state: BackupState;
  // last snapshots, oldest first; size and note when known (PBS: snapshot comment, Home Assistant: backup name)
  times?: BackupSnapshot[];
  threshold: number | null; // hours; null: no rhythm known, never late
  thresholdSource: 'manual' | 'learned' | 'retention' | 'schedule' | 'none';
  interval: number | null; // rhythm (ms), learned, from the retention or the PVE schedule
  // vzdump: attached by Proxmox VE; managed: written by a backup job of the hub; haos: destination of the
  // Home Assistant backups of a HAOS host (not on the PBS). None is attached by hand.
  source?: 'vzdump' | 'managed' | 'haos';
  // copy to the secondary PBS (hub/src/offsite.ts); null: never set
  offsite: BackupOffsite | null;
  pve: { cluster: string; vmid: number; tz: string; jobs: PveJobRef[]; lastTask?: PveTaskResult | null } | null;
  managed: {
    jobId: string;
    name: string;
    tz: string;
    schedule: string;
    scheduleText: string;
    connectEveryDays?: number; // run on connection of the agent instead of the schedule
    enabled: boolean;
    synced: boolean;
    lastRun?: { at: number; ok: boolean; error?: string | null; dumps?: DumpInfo[] } | null;
    kind?: BackupJobKind;
    database?: DatabaseDump | null;
    plugin?: JobPlugin | null;
  } | null;
  placeholder?: boolean; // expected by a job, never seen on the PBS
  ha?: {
    agentId: string;
    automatic: boolean; // the automatic backups go to this destination
    scheduleText: string | null; // null: not automatic
    tz: string;
    next: number | null;
    lastAttempted: number | null;
    lastCompleted: number | null;
    failedAt: number | null; // last automatic backup that did not reach this destination
    error: string | null; // destination that could not be listed
  } | null;
}

// Group of the PBS attached to no host: not followed
export interface BackupOrphan {
  id: string;
  store: string;
  ns: string;
  type: string;
  backupId: string;
  comment: string | null;
  lastBackup: number;
  count: number;
  gone: boolean;
}

export interface BackupsView {
  // main PBS connected: its groups, datastores and the jobs of the hosts (the backups of Home Assistant and
  // the Proxmox VE clusters are shown without it)
  connected: boolean;
  // secondary PBS of the copies; null: not connected
  offsite: {
    host: string;
    store: string;
    polledAt: string | null;
    pollError: string | null;
    usage: { total: number; used: number; avail: number } | null;
    series: OffsiteSeriesView;
  } | null;
  polledAt: string | null;
  pollError: string | null;
  datastores: { store: string; total: number; used: number; avail: number }[];
  clusters: { id: string; name: string; polledAt: string | null; pollError: string | null; guests: number }[];
  groups: BackupGroup[];
  orphans: BackupOrphan[];
  // jobs set aside at the disconnection of the main PBS, to restore from the host card
  cached: { id: string; hostId: string; name: string; store: string; ns: string; backupId: string; schedule: string; connectEveryDays: number | null; enabled: boolean; at: string }[];
}

// Agent that administers a PBS (hub/src/pbsAgent.ts): host, PBS installed on it or in a container
export interface PbsAgentLink {
  hostId: string;
  mode: 'native' | 'container';
  container?: string;
}

// What the agent of a host found (rpc pbs_detect)
export interface PbsDetected {
  found: boolean;
  mode?: 'native' | 'container';
  container?: string;
  version?: string;
  datastores?: string[];
  port?: number; // 0: the container does not publish the API
  fingerprint?: string;
  url?: string; // suggested from the addresses of the host
  tailscaleUrl?: string; // same port on the Tailscale address of the host
}

// Token created by the agent of a PBS or a PVE node: rights granted, and those removed from the token.
// rotated: it existed without the hub holding its secret, it was created again.
export interface PbsTokenOutcome {
  created: boolean;
  rotated?: boolean;
  applied: string[];
  removed: string[];
}

export interface PbsSettings {
  connected: boolean; // address and monitoring token
  agent?: PbsAgentLink;
  url: string;
  fingerprint: string;
  tokenId: string;
  hasSecret: boolean;
  clientImage?: string;
  tailscaleUrl?: string; // PBS address for the hosts of the Tailscale access network
  polledAt?: string;
  pollError?: string | null;
}

// Copy of a group to the secondary PBS: enabled, and what the poll of the secondary found
export interface BackupOffsite {
  enabled: boolean;
  jobId: string; // sync job of its datastore and namespace
  since: number;
  error?: string | null;
  lastBackup?: number | null;
  count?: number;
  verify?: 'ok' | 'failed' | null;
  size?: number | null;
  // last snapshots on the secondary, oldest first (timeline of the copy)
  times?: BackupSnapshot[];
  // last run of its sync job, for this group
  lastRun?: { start: number; end: number; ok: boolean; error?: string } | null;
  // run of its sync job on the secondary, followed by the hub as a job (console, Activité); current: this
  // group is the one being copied
  running?: { upid: string; start: number; jobId: string; current?: boolean } | null;
  // ok, pending (a verified snapshot of the main PBS newer than the copy), late (missed by a daily series),
  // failed; null: not copied
  state: 'ok' | 'pending' | 'late' | 'failed' | null;
  // why the last verified snapshot cannot be copied now (immediate copy), null: it can
  adhocBlocked?: string | null;
}

// Whether a group can be copied now (hub routes/offsite.ts checkOffsite)
export interface OffsiteCheck {
  ok: boolean;
  error?: string;
  // namespace to create first on the secondary: the levels missing and the commands creating them
  namespace?: { ns: string; store: string; missing: string[]; commands: string[] };
}

export interface BackupOffsiteInput {
  enabled: boolean;
}

// Daily series of the copies, started by the agent of the secondary PBS (hub offsite.ts seriesView)
export interface OffsiteSeriesView {
  startTime: string; // HH:MM
  tz: string;
  jobs: number; // sync jobs (datastore + namespace) copied
  active: boolean; // the agent starts the series (else: agent to update, no copy)
  agentOnline: boolean;
  error: string | null;
  day: string | null; // last series started (YYYY-MM-DD)
  total: number; // jobs of that series
  pending: number; // not started yet
  running: string | null; // label of the job running, or another sync of the secondary
  nextStart: number | null; // unix ms
}

// Secondary PBS (hub/src/routes/offsite.ts); the tokens are created by the agents of both PBS
export interface PbsRemoteSettings {
  connected: boolean; // address, target datastore and both tokens
  agent?: PbsAgentLink;
  url: string;
  fingerprint: string;
  store: string;
  tokenId: string;
  hasSecret: boolean;
  readerTokenId: string;
  hasReaderSecret: boolean;
  polledAt?: string;
  pollError?: string | null;
  usage?: { store: string; total: number; used: number; avail: number } | null;
  startTime: string;
  series: OffsiteSeriesView;
}

export interface PbsRemoteInput {
  url: string;
  fingerprint: string;
  agent?: PbsAgentLink;
  startTime?: string;
}

export interface PbsTestResult {
  ok: boolean;
  error?: string;
  datastores?: string[];
}

// the token is created by the agent of the PBS (createPbsToken), not part of the form
export interface PbsSettingsInput {
  url: string;
  fingerprint: string;
  agent?: PbsAgentLink;
  clientImage?: string;
  tailscaleUrl?: string;
}

// Backups of directories run by the agent (hub/src/backupJobs.ts)
export interface BackupArchive {
  name: string;
  path: string;
}

// Kind of backup job: directories, or the dump of databases (agent/database.go), one archive per dump in workDir
export type BackupJobKind = 'directories' | 'postgres' | 'mongodb' | 'nextcloud';
// kinds of the form of a job (nextcloud: jobs of the plugin only)
export type DatabaseKind = 'postgres' | 'mongodb';

// generated by the Nextcloud AIO plugin (part: database, config, user:<id>): changed through it only
export interface JobPlugin {
  name: 'nextcloud';
  part: string;
}

export interface DatabaseDump {
  mode?: 'databases' | 'cluster' | 'database' | 'config'; // postgres: databases | cluster; nextcloud: database | config
  databases: string[];
  container?: string; // mongodb
  workDir: string;
  keep: number; // dumps kept on the host after the backup (0: removed once sent)
}

// Size of a dump of a run and of its database (-1: unknown)
export interface DumpInfo {
  archive: string;
  database?: string;
  dbSize: number;
  dumpSize: number;
}

// What the agent found for a database job (button Vérifier of the form)
export interface BackupEstimate {
  name: string;
  path: string;
  files: number;
  size: number;
  excluded: { files: number; size: number; top: { path: string; size: number; dir?: boolean }[] };
  error?: string;
  partial?: boolean; // walk stopped: the figures are a minimum
}

export interface DatabaseCheck {
  tools: string;
  databases: { name: string; size: number }[];
  missing: string[];
  free: number; // bytes, -1: unknown
}

export interface BackupJob {
  id: string;
  hostId: string;
  name: string;
  archives: BackupArchive[];
  excludes: string[];
  store: string;
  ns: string;
  backupId: string;
  group: string;
  schedule: string;
  connectEveryDays: number | null;
  timezone: string;
  enabled: boolean;
  kind: BackupJobKind;
  database: DatabaseDump | null;
  plugin: JobPlugin | null;
  lastRun: { start: number; end: number; ok: boolean; error: string | null; trigger: string; jobId: string | null; dumps?: DumpInfo[] } | null;
}

export interface BackupJobInput {
  name: string;
  archives: BackupArchive[];
  excludes: string[];
  store: string;
  ns?: string; // fixed by the hub (Hosts)
  backupId?: string;
  schedule: string;
  connectEveryDays?: number | null; // roaming hosts: run on connection, at most every N days (the schedule is ignored)
  timezone?: string;
  enabled: boolean;
  kind?: BackupJobKind; // creation only
  database?: DatabaseDump | null;
}

export interface HostBackupJobs {
  // PBS client: installed (native), image present (docker), directory CLI of a Windows host (cli), none;
  // how it can be installed
  mode: 'native' | 'docker' | 'cli' | null;
  install: ('apt' | 'docker')[];
  // Windows: the directory CLI of Nimbus Backup, installed by hand at clientPath (one directory per
  // job, no exclusion, no database)
  windows: boolean;
  clientPath: string | null;
  // database jobs: kinds the agent found usable on the host (null: agent to update)
  databases: DatabaseKind[] | null;
  estimate: boolean;
  supported: boolean;
  // store: datastore of the rights of the token ('*': namespace Hosts of every datastore), when created by the hub
  credential: { tokenId: string; updatedAt: string; store: string | null } | null;
  sync: { hash: string; at: string; error: string | null; current: boolean } | null;
  pbsReady: boolean;
  pbsAgent: boolean; // the agent of the PBS can create the token of the host
  datastores: string[];
  // retention the PBS applies to the namespace Hosts of each datastore; null: no pruning
  retention: Record<string, { keep: string; schedule: string | null; ns: string } | null>;
  timezone: string;
  // Nextcloud AIO plugin: shown (BACKUP_NEXTCLOUD_AIO of the hub), instance found here, settings of the host
  nextcloudPlugin: boolean;
  nextcloud: boolean;
  nextcloudSettings: NextcloudSettings | null;
  // kept when the main PBS was disconnected (#190): the settings of the plugin (restored from its dialog)
  // and the jobs entered by hand (restored or dropped one by one)
  nextcloudPrevious: NextcloudSettings | null;
  cache: { at: string; jobs: BackupJob[] } | null;
  jobs: BackupJob[];
}

// What a disconnection removes (hub/src/disconnect.ts), and what it did
export interface PbsDisconnectPreview {
  monitorToken: string | null;
  remote: { host: string | null; tokenId: string | null; readerTokenId: string | null } | null;
  hosts: { name: string; tokenId: string | null; jobs: number; nextcloud: boolean }[];
  groups: number;
}
export interface DisconnectReport {
  revoked: string[];
  users: string[];
  syncJobs: number;
  remote: boolean;
  hosts: number;
  cachedJobs: number;
  groups: number;
  errors: string[];
}

// Nextcloud AIO plugin of a host (hub/src/nextcloud.ts): a datastore per part backed up, null: not backed up
export interface NextcloudSettings {
  workDir: string;
  keep: number;
  schedule: string;
  enabled: boolean;
  database: string | null;
  config: string | null;
  users: { id: string; store: string }[];
}

// what the agent found of the instance (agent/nextcloud.go)
export interface NextcloudDiscovery {
  containers: Record<string, string>;
  version: string;
  database: string;
  dbSize: number;
  dbTools?: string;
  dataDir: string;
  configDir: string;
  instanceId: string;
  composeFiles: string[];
  users: { id: string; name: string; path?: string; exists: boolean; error?: string }[];
  free: number;
}

// What the agent of a Proxmox VE node found (rpc pve_detect, hub/src/pveAgent.ts)
export interface PveIface {
  name: string;
  ips: string[];
  default?: boolean; // carries the default route
}
export interface PveDetected {
  found: boolean;
  version?: string;
  cluster?: string; // empty: standalone node
  node?: string;
  nodes?: string[];
  interfaces?: PveIface[];
  port?: number;
  fingerprint?: string;
}

export interface PveCluster {
  id: string;
  name: string;
  url: string;
  fingerprint: string;
  tokenId: string;
  hasSecret: boolean;
  agent?: { hostId: string }; // node whose agent created the token
  timezone?: string;
  polledAt: string | null;
  pollError: string | null;
  guests?: number;
}

// the token is created by the agent of a node (createPveToken), not part of the form
export interface PveClusterInput {
  name: string;
  url: string;
  fingerprint: string;
  agent?: { hostId: string };
}

export const api = {
  authStatus: () => request<AuthStatus>('GET', '/api/auth/status'),
  login: (username: string, password: string) =>
    request<Me>('POST', '/api/auth/login', { username, password }),
  logout: () => request('POST', '/api/auth/logout'),
  changePassword: (currentPassword: string | undefined, newPassword: string) =>
    request('POST', '/api/account/password', { currentPassword, newPassword }),

  users: () => request<Account[]>('GET', '/api/users'),
  createUser: (username: string, displayName: string, role: Role, noPassword = false) =>
    request<AccountSecret>('POST', '/api/users', { username, displayName, role, noPassword }),
  updateUser: (id: string, patch: { username?: string; displayName?: string; role?: Role }) =>
    request<Account>('PATCH', `/api/users/${id}`, patch),
  deleteUser: (id: string) => request<void>('DELETE', `/api/users/${id}`),
  resetPassword: (id: string) => request<AccountSecret>('POST', `/api/users/${id}/reset-password`),
  createApiKey: (id: string, name: string) => request<AccountSecret>('POST', `/api/users/${id}/api-keys`, { name }),
  revokeApiKey: (id: string, keyId: string) => request<void>('DELETE', `/api/users/${id}/api-keys/${keyId}`),

  hosts: () => request<Host[]>('GET', '/api/hosts'),
  createHost: (h: { name: string; siteId: string; tags: string[]; roaming: boolean; critical?: boolean; haExcluded: boolean; accessNetwork: AccessNetwork }) =>
    request<{ host: Host } & InstallInfo>('POST', '/api/hosts', h),
  // siteId '': no site
  updateHost: (id: string, patch: { name?: string; siteId?: string; tags?: string[]; roaming?: boolean; critical?: boolean; haExcluded?: boolean }) => request<Host>('PATCH', `/api/hosts/${id}`, patch),
  deleteHost: (id: string) => request<void>('DELETE', `/api/hosts/${id}`),
  enrollHost: (id: string) => request<InstallInfo>('POST', `/api/hosts/${id}/enroll`),
  revokeHost: (id: string) => request<Host>('POST', `/api/hosts/${id}/revoke`),

  homeAssistant: () => request<HomeAssistantSettings>('GET', '/api/settings/homeassistant'),
  saveHomeAssistant: (s: HomeAssistantInput) => request<HomeAssistantSettings>('PUT', '/api/settings/homeassistant', s),
  testHomeAssistant: (s: HomeAssistantInput) =>
    request<{ ok: boolean; error?: string }>('POST', '/api/settings/homeassistant/test', s),
  republishHomeAssistant: () => request<{ ok: boolean }>('POST', '/api/settings/homeassistant/republish'),

  agentSettings: () => request<AgentSettings>('GET', '/api/settings/agents'),
  saveAgentSettings: (patch: Partial<Pick<AgentSettings, 'autoUpdate' | 'hubUrl' | 'checkIntervalHours' | 'agentPort' | 'tailscaleHub'>>) =>
    request<AgentSettings>('PUT', '/api/settings/agents', patch),

  jobs: (limit = 100) => request<Job[]>('GET', `/api/jobs?limit=${limit}`),
  hostJobs: (id: string) => request<Job[]>('GET', `/api/hosts/${id}/jobs`),
  hostAlerts: (id: string) => request<{ days: HostAlertDay[] }>('GET', `/api/hosts/${id}/alerts`),
  alerts: () => request<{ days: (HostAlertDay & { hostId: string })[] }>('GET', '/api/alerts'),
  status: () => request<StatusView>('GET', '/api/status'),
  sites: () => request<{ sites: SiteConfig[] }>('GET', '/api/sites'),
  // a new site has no id yet
  saveSites: (sites: (Omit<SiteConfig, 'id'> & { id?: string })[]) => request<{ sites: SiteConfig[] }>('PUT', '/api/settings/sites', { sites }),
  tags: () => request<{ tags: TagConfig[] }>('GET', '/api/tags'),
  createTag: (name: string, color: TagColor) => request<TagConfig>('POST', '/api/tags', { name, color }),
  updateTag: (id: string, patch: { name?: string; color?: TagColor }) => request<TagConfig>('PATCH', `/api/tags/${id}`, patch),
  deleteTag: (id: string) => request<void>('DELETE', `/api/tags/${id}`),
  dockerUpdate: (targets: { hostId: string; stack: string }[]) => request<Job[]>('POST', '/api/jobs/docker-update', { targets }),
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
  // the agent reads again what it reports on its own (system, APT, Docker, Home Assistant backups, UPS)
  refreshHost: (hostId: string) => request<{ scopes: string[] }>('POST', `/api/hosts/${hostId}/refresh`, {}),
  upsCommand: (hostId: string, command: UpsCommand) => request<{ ok: boolean }>('POST', `/api/hosts/${hostId}/ups/command`, { command }),
  forgetStack: (hostId: string, stack: string) => request<void>('DELETE', `/api/hosts/${hostId}/stacks/${encodeURIComponent(stack)}`),
  setStackManaged: (hostId: string, stack: string, managed: boolean) =>
    request<Host>('PUT', `/api/hosts/${hostId}/stacks/${encodeURIComponent(stack)}/managed`, { managed }),
  backups: () => request<BackupsView>('GET', '/api/backups'),
  refreshBackups: () => request<{ ok: boolean }>('POST', '/api/backups/refresh'),
  setHostBackups: (hostId: string, ids: string[]) => request<BackupGroup[]>('PUT', `/api/hosts/${hostId}/backups`, { ids }),
  updateBackup: (id: string, patch: { hostId?: string | null; staleHours?: number | null }) =>
    request<BackupGroup>('PATCH', `/api/backups/${encodeURIComponent(id)}`, patch),
  forgetBackup: (id: string) => request<void>('DELETE', `/api/backups/${encodeURIComponent(id)}`),
  pbsSettings: () => request<PbsSettings>('GET', '/api/settings/pbs'),
  savePbsSettings: (s: PbsSettingsInput) => request<PbsSettings>('PUT', '/api/settings/pbs', s),
  testPbsSettings: (s: PbsSettingsInput) => request<PbsTestResult>('POST', '/api/settings/pbs/test', s),
  pbsDisconnectPreview: () => request<PbsDisconnectPreview>('GET', '/api/settings/pbs/disconnect'),
  disconnectPbs: () => request<DisconnectReport>('POST', '/api/settings/pbs/disconnect'),
  disconnectPbsRemote: () => request<DisconnectReport>('POST', '/api/settings/pbs-remote/disconnect'),
  pbsFingerprint: (url: string) => request<{ fingerprint: string }>('POST', '/api/settings/pbs/fingerprint', { url }),
  pbsRemoteSettings: () => request<PbsRemoteSettings>('GET', '/api/settings/pbs-remote'),
  savePbsRemoteSettings: (s: PbsRemoteInput) => request<PbsRemoteSettings>('PUT', '/api/settings/pbs-remote', s),
  testPbsRemoteSettings: (s: PbsRemoteInput) => request<PbsTestResult & { namespaces?: string[] }>('POST', '/api/settings/pbs-remote/test', s),
  createPbsRemoteToken: (agent: PbsAgentLink, tokenId: string, store: string) =>
    request<PbsTokenOutcome & { settings: PbsRemoteSettings }>('POST', '/api/settings/pbs-remote/token', { agent, tokenId, store }),
  createPbsReaderToken: (tokenId: string) => request<PbsTokenOutcome & { settings: PbsRemoteSettings }>('POST', '/api/settings/pbs-remote/reader-token', { tokenId }),
  setBackupOffsite: (id: string, o: BackupOffsiteInput) => request<BackupGroup>('PUT', `/api/backups/${encodeURIComponent(id)}/offsite`, o),
  runBackupOffsite: (id: string) => request<{ ok: boolean; upid: string; jobId: string | null }>('POST', `/api/backups/${encodeURIComponent(id)}/offsite/run`),
  checkBackupOffsite: (id: string) => request<OffsiteCheck>('GET', `/api/backups/${encodeURIComponent(id)}/offsite/check`),
  detectPbs: (hostId: string) => request<PbsDetected>('POST', '/api/settings/pbs/detect', { hostId }),
  createPbsToken: (agent: PbsAgentLink, tokenId: string) => request<PbsTokenOutcome & { settings: PbsSettings }>('POST', '/api/settings/pbs/token', { agent, tokenId }),
  hostBackupJobs: (hostId: string) => request<HostBackupJobs>('GET', `/api/hosts/${hostId}/backup-jobs`),
  createBackupJob: (hostId: string, j: BackupJobInput) => request<BackupJob>('POST', `/api/hosts/${hostId}/backup-jobs`, j),
  checkBackupDatabase: (hostId: string, kind: DatabaseKind, database: DatabaseDump) =>
    request<DatabaseCheck>('POST', `/api/hosts/${hostId}/backup-database-check`, { kind, database }),
  estimateBackup: (hostId: string, archives: BackupArchive[], excludes: string[]) =>
    request<BackupEstimate[]>('POST', `/api/hosts/${hostId}/backup-estimate`, { archives, excludes }),
  updateBackupJob: (id: string, j: BackupJobInput) => request<BackupJob>('PUT', `/api/backup-jobs/${id}`, j),
  deleteBackupJob: (id: string) => request<void>('DELETE', `/api/backup-jobs/${id}`),
  discoverNextcloud: (hostId: string, workDir?: string) => request<NextcloudDiscovery>('POST', `/api/hosts/${hostId}/nextcloud/discover`, workDir ? { workDir } : {}),
  saveNextcloud: (hostId: string, s: NextcloudSettings) => request<{ created: number; updated: number; removed: number }>('PUT', `/api/hosts/${hostId}/nextcloud`, s),
  deleteNextcloud: (hostId: string) => request<{ removed: number }>('DELETE', `/api/hosts/${hostId}/nextcloud`),
  installBackupClient: (hostId: string, method: 'apt' | 'docker') => request<Job>('POST', `/api/hosts/${hostId}/backup-client`, { method }),
  setBackupClientPath: (hostId: string, path: string) => request<Host>('PUT', `/api/hosts/${hostId}/backup-client-path`, { path }),
  runBackupJob: (id: string) => request<Job>('POST', `/api/backup-jobs/${id}/run`),
  restoreCachedJob: (hostId: string, jobId: string, j?: BackupJobInput) =>
    request<BackupJob>(j ? 'PUT' : 'POST', `/api/hosts/${hostId}/backup-cache/jobs/${jobId}`, j),
  dropCachedJob: (hostId: string, jobId: string) => request<void>('DELETE', `/api/hosts/${hostId}/backup-cache/jobs/${jobId}`),
  dropCachedNextcloud: (hostId: string) => request<void>('DELETE', `/api/hosts/${hostId}/backup-cache/nextcloud`),
  createPbsCredential: (hostId: string, tokenId: string) => request<PbsTokenOutcome & { tokenId: string }>('POST', `/api/hosts/${hostId}/pbs-credential`, { tokenId }),
  pveSettings: () => request<{ clusters: PveCluster[] }>('GET', '/api/settings/pve'),
  savePveCluster: (id: string, c: PveClusterInput) => request<PveCluster>('PUT', `/api/settings/pve/clusters/${encodeURIComponent(id)}`, c),
  deletePveCluster: (id: string) => request<{ revoked: string | null; userDeleted: boolean }>('DELETE', `/api/settings/pve/clusters/${encodeURIComponent(id)}`),
  testPveCluster: (id: string, c: PveClusterInput) =>
    request<{ ok: boolean; error?: string; cluster?: string | null; nodes?: string[]; jobs?: number }>('POST', `/api/settings/pve/clusters/${encodeURIComponent(id)}/test`, c),
  detectPve: (hostId: string) => request<PveDetected>('POST', '/api/settings/pve/detect', { hostId }),
  createPveToken: (id: string, b: { hostId: string; tokenId: string; name: string; url: string; fingerprint: string }) =>
    request<PbsTokenOutcome & { cluster: PveCluster }>('POST', `/api/settings/pve/clusters/${encodeURIComponent(id)}/token`, b),
  runBulk: (hostIds: string[], action: JobAction, options?: SetupOption[], securityOnly?: boolean) =>
    request<Job[]>('POST', '/api/jobs/bulk', { hostIds, action, options, securityOnly }),

  setupProfile: () => request<SetupProfile>('GET', '/api/settings/setup'),
  saveSetupProfile: (p: SetupProfile) => request<SetupProfile>('PUT', '/api/settings/setup', p),
  setupStandard: () => request<{ autoApply: boolean; options: SetupOptions }>('GET', '/api/setup'),
  saveHostSetup: (hostId: string, overrides: SetupOverrides) => request<Host>('PUT', `/api/hosts/${hostId}/setup`, { overrides }),
  applySetup: (hostId: string) => request<Job>('POST', `/api/hosts/${hostId}/jobs`, { action: 'setup_apply' }),
  checkSetup: (hostId: string) => request<Host>('POST', `/api/hosts/${hostId}/setup/check`),
};
