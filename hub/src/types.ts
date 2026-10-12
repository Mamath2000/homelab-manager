import type { ObjectId } from 'mongodb';

export interface Package {
  name: string;
  current: string;
  candidate: string;
  repo: string;
  security: boolean;
  // added by the hub: the upgrade will require a reboot
  reboot?: boolean;
}

export interface InstalledPackage {
  name: string;
  from: string;
  to: string;
  at: number; // unix ms
}

export interface AptReport {
  checkedAt: number;
  listsUpdatedAt: number;
  upgradable: Package[];
  held: string[];
  rebootRequired: boolean;
  rebootPkgs: string[];
  // absent with agents older than 0.1.1
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
  // MAC addresses of the network interfaces (agents >= 0.2): link with a Proxmox VE guest
  macs?: string[] | null;
}

export interface AptSummary {
  upgradable: number;
  security: number;
  held: number;
  rebootRequired: boolean;
  // pending upgrades that will require a reboot once installed
  rebootPending: number;
  // packages apt-get autoremove would remove; null when the agent does not report it
  autoremovable: number | null;
}

// Docker compose stacks reported by the agent (see agent/protocol.go).
export interface DockerContainer {
  id: string;
  name: string;
  state: string; // running, exited, restarting, paused, created, dead
  status: string;
  health?: string; // healthy, unhealthy, starting
  imageId: string;
}

export interface DockerService {
  name: string;
  image: string;
  containers: DockerContainer[];
  // container outside the compose file (created by another container): logs only
  external?: boolean;
}

export type StackStatus = 'running' | 'partial' | 'stopped' | 'down';

export interface DockerStack {
  name: string;
  workingDir: string;
  configFiles: string[];
  envFiles: string[];
  status: StackStatus;
  services: DockerService[];
}

export interface DockerImage {
  ref: string;
  id: string; // image the tag points to locally
  digest: string; // registry digest it was pulled from ("" for local builds)
  // every registry digest of the local image (agents >= this field; older ones only send digest)
  digests?: string[];
}

export interface DockerReport {
  checkedAt: number;
  engine: string;
  compose: string;
  stacks: DockerStack[];
  images: DockerImage[];
}

// Last registry check (docker_check): digest of each tag on its registry.
export interface DockerUpdates {
  checkedAt: number;
  images: { ref: string; digest?: string; error?: string }[];
}

export interface HostDoc {
  _id: ObjectId;
  name: string;
  group?: string;
  // legacy bearer token (agents before TLS): such hosts must be reinstalled
  tokenHash?: string;
  // single-use enrollment code of the install command (sha256), valid until enrollExpiresAt
  enrollCodeHash?: string;
  enrollExpiresAt?: Date;
  // sha256 of the client certificate the agent authenticates with (mTLS)
  certFingerprint?: string;
  certIssuedAt?: Date;
  createdAt: Date;
  enrolledAt?: Date;
  lastSeenAt?: Date;
  lastAutoCheckAt?: Date;
  agentVersion?: string;
  // actions announced by the agent (absent with old agents)
  capabilities?: string[];
  // sha256 of the agent binary, compared with the one the hub distributes
  agentHash?: string;
  lastAgentUpdateAt?: Date;
  // sha256 of the binary the last automatic update installed
  lastAgentUpdateHash?: string;
  // packages upgraded during the last 24 h (see installed.ts)
  recentlyInstalled?: InstalledPackage[];
  info?: HostInfo;
  apt?: AptReport;
  aptSummary?: AptSummary;
  docker?: DockerReport;
  dockerUpdates?: DockerUpdates;
  lastDockerAutoCheckAt?: Date;
  // local images changed since the last registry check: a docker_check is due as soon as the host is free
  dockerRecheck?: boolean;
  // compose stacks managed elsewhere (own update system...): listed, but no state nor action
  unmanagedStacks?: string[];
  // standardisation: what this host does differently from the standard configuration, last check
  setupOverrides?: SetupOverrides;
  setup?: SetupState;
  // new host: the standard configuration is applied at its first connection (Paramètres > Standardisation)
  setupPending?: boolean;
  // not connected permanently (laptop...): being offline is expected, neither an error nor an alert
  roaming?: boolean;
  // Proxmox VE guest this host is (one of its MAC addresses), recomputed at each PVE poll; see pve.ts
  pve?: HostPveLink | null;
  // backups run by the agent (see backupJobs.ts): its PBS token, and the last definition it applied
  // store: datastore the token was given rights on (token created by the command of the UI); unknown otherwise
  pbsCredential?: { tokenId: string; tokenSecret: string; updatedAt: Date; store?: string };
  backupSync?: { hash: string; at: Date; error?: string | null };
}

export interface HostPveLink {
  cluster: string;
  vmid: number;
  type: 'lxc' | 'qemu';
  node: string;
  name: string;
  // part of an enabled backup job of the cluster
  covered: boolean;
}

// Standardisation of the hosts (see setup.ts and agent/setup.go): options in three sections, the
// system, root and an optional user. Ids are also the ones of the agent checks.
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
export const PROMPT_STYLES = ['none', 'classic', 'starship'] as const;
export const MOTD_STYLES = ['none', 'homelab', 'fastfetch'] as const;
export type PromptStyle = (typeof PROMPT_STYLES)[number];
export type MotdStyle = (typeof MOTD_STYLES)[number];

export interface SetupValues {
  packages: string[];
  ssh_password: boolean; // password logins allowed
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
// options whose host value can be the standard list plus additions
export const LIST_OPTIONS = ['packages', 'root_keys', 'user_keys'] as const;
export type ListOption = (typeof LIST_OPTIONS)[number];

// enabled: part of the standard configuration (applied, checked); value: also the default of a host
export type SetupOptions = { [K in SetupOption]: { enabled: boolean; value: SetupValues[K] } };

export interface SetupProfile {
  _id: 'setup';
  // applied to a new host at its first connection
  autoApply: boolean;
  options: SetupOptions;
  fastfetch: string; // JSON configuration of fastfetch (welcome screen 'fastfetch')
  starship: string; // TOML configuration of Starship (prompt 'starship')
}

// Host value of an option, absent: the standard one. off: neither applied nor checked; extra: the
// standard list plus these items.
export type SetupOverride<K extends SetupOption> = { mode: 'off' } | { mode: 'custom'; value: SetupValues[K] } | { mode: 'extra'; add: string[] };
export type SetupOverrides = { [K in SetupOption]?: SetupOverride<K> };

export interface SetupCheck {
  module: SetupOption;
  state: 'ok' | 'drift' | 'na' | 'error';
  detail?: string;
}

export interface SetupState {
  checkedAt: number;
  user: string;
  modules: SetupCheck[];
}

export const APT_ACTIONS = ['apt_report', 'apt_update', 'apt_upgrade', 'apt_autoremove'] as const;
// hosts without APT (Unraid...) do not announce apt_update
export const hasApt = (h: { capabilities?: string[] }) => !!h.capabilities?.includes('apt_update');
export const DOCKER_ACTIONS = ['docker_up', 'docker_stop', 'docker_restart', 'docker_update'] as const;
export const JOB_ACTIONS = [
  'apt_report',
  'apt_update',
  'apt_upgrade',
  'apt_autoremove',
  'reboot',
  'agent_update',
  'docker_check',
  ...DOCKER_ACTIONS,
  'setup_apply',
] as const;
// backup_run: launched from the backup job only (it names the job), never through the generic job routes
export type JobAction = (typeof JOB_ACTIONS)[number] | 'backup_run' | 'backup_install';
export type JobStatus = 'running' | 'success' | 'failed';

export interface JobDoc {
  _id: ObjectId;
  hostId: ObjectId;
  hostName: string;
  action: JobAction;
  packages: string[];
  // docker actions: target stack, and service when the action is limited to one
  stack?: string;
  service?: string;
  // setup_apply: options applied
  modules?: SetupOption[];
  // backup_run: the backup job (BackupJobDoc) and its name
  backupJobId?: ObjectId;
  backupJobName?: string;
  // backup_install: apt | docker
  method?: 'apt' | 'docker';
  trigger: 'manual' | 'schedule' | 'homeassistant' | 'enroll';
  status: JobStatus;
  createdAt: Date;
  finishedAt?: Date;
  exitCode?: number;
  error?: string;
  log: string;
}

export const ROLES = ['admin', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
// built-in recovery account, see hub/src/cli.ts
export const SUPERADMIN = 'superadmin';

export interface UserDoc {
  _id: ObjectId;
  username: string;
  // optional full name shown in the UI; the username stays the login
  displayName?: string;
  role: Role | typeof SUPERADMIN;
  passwordHash: string | null;
  // temporary password (new account or reset): everything but changing it is refused
  mustChangePassword?: boolean;
  // superadmin only: the one-time password is refused after this date
  passwordExpiresAt?: Date;
  createdAt: Date;
  lastLoginAt?: Date;
}

export interface SessionDoc {
  _id: string; // sha256 of the cookie token
  userId: ObjectId;
  expiresAt: Date;
}

// Internal PKI of the hub (see pki.ts): its CA signs the TLS certificate of the agent port and
// the client certificates of the agents.
export interface PkiDoc {
  _id: 'pki';
  caCert: string; // PEM
  caKey: string; // PKCS#8 PEM
  serverCert: string;
  serverKey: string;
  createdAt: Date;
}

export interface AgentSettings {
  _id: 'agents';
  autoUpdate: boolean;
  // URL of the hub UI (links, and host of the agent address); empty: the address used in the browser
  hubUrl: string;
  // port the agents reach the TLS agent server on (published port of AGENT_TLS_PORT)
  agentPort: number;
  // how often the hub asks each agent to run `apt-get update` (0 = never)
  checkIntervalHours: number;
}

export interface HomeAssistantSettings {
  _id: 'homeassistant';
  enabled: boolean;
  broker: string; // mqtt://host:1883, mqtts://...
  username: string;
  password: string;
  topic: string; // prefix of the state / command topics
  discoveryPrefix: string;
  publicUrl: string; // link to the UI in Home Assistant ("Visit"); empty: the hub URL of the agent settings
}

// --- Backups (Proxmox Backup Server, see pbs.ts) ------------------------------------------

export interface PbsDatastoreUsage {
  store: string;
  total: number; // bytes
  used: number;
  avail: number;
}

export interface PbsSettings {
  _id: 'pbs';
  enabled: boolean;
  url: string; // https://pbs:8007
  // sha256 of the PBS certificate (AB:CD:...), pinned; empty: verified against the system CAs
  fingerprint: string;
  tokenId: string; // user@realm!token
  tokenSecret: string;
  // last poll
  polledAt?: Date;
  pollError?: string | null;
  datastores?: PbsDatastoreUsage[];
  // retention applied by the PBS (prune jobs, options of the datastores), see pbs.ts
  prune?: { store: string; ns: string; schedule: string | null; keep: Record<string, number> }[];
  // backups run by the agents: client image where proxmox-backup-client is not installed (the default
  // time zone of their jobs is the TZ of the hub, see backupJobs.ts)
  clientImage?: string;
}

// One backup group of the PBS: datastore + namespace + type + id.
export interface BackupDoc {
  _id: string; // <store>/<ns>/<type>/<id>
  store: string;
  ns: string; // "" : root namespace
  type: string; // host | vm | ct
  backupId: string;
  comment?: string; // notes of the group (guest name for vm / ct)
  owner?: string;
  count: number;
  lastBackup: number; // unix ms of the last snapshot
  size: number | null; // bytes of the last snapshot
  verify: 'ok' | 'failed' | null; // verification of the last snapshot
  // host it belongs to, chosen by hand from the host page; null: orphan, not followed
  hostId: ObjectId | null;
  staleHours?: number | null; // own threshold (hours), else the rhythm of the group
  times?: BackupSnapshot[]; // last snapshots, oldest first
  retention?: number | null; // finest period kept by the prune policy (ms)
  seenAt: Date; // last poll that saw it
  gone?: boolean; // no longer on the PBS
  // vzdump: attached by the PVE poll to the host of the guest; managed: written by a backup job of the
  // hub (backupJobs.ts); haos: destination of the Home Assistant backups of a HAOS host, reported by its
  // agent (haBackups.ts, not on the PBS). None is attached by hand.
  source?: 'vzdump' | 'managed' | 'haos';
  pve?: BackupPve;
  managed?: BackupManaged;
  ha?: BackupHa;
  // expected by a PVE job but never seen on the PBS yet
  placeholder?: boolean;
}

// One snapshot of the history of a group: its date and its verification; size and note when known
// (absent from the history stored before them, filled again by the next poll or report).
export interface BackupSnapshot {
  t: number; // unix ms
  verify: 'ok' | 'failed' | null;
  size?: number | null; // bytes
  note?: string | null; // PBS: comment of the snapshot (vzdump: guest name); Home Assistant: name of the backup
  automatic?: boolean; // Home Assistant: made by the automatic backups
}

// --- Proxmox VE clusters (see pve.ts) -------------------------------------------------------

export interface PveCluster {
  id: string; // short name, e.g. vouille
  name: string;
  url: string; // https://pve1:8006
  fingerprint: string;
  tokenId: string; // user@realm!token
  tokenSecret: string;
  enabled: boolean;
  // filled by the poll
  timezone?: string; // of the nodes: the schedules are wall-clock times of it
  polledAt?: Date;
  pollError?: string | null;
  guests?: number;
}

export interface PveSettings {
  _id: 'pve';
  clusters: PveCluster[];
}

// Backup job of a cluster, as seen by one guest.
export interface PveJobRef {
  id: string;
  schedule: string;
  enabled: boolean;
  nextRun: number | null; // unix ms
  storage: string;
  // datastore and namespace of the storage on the followed PBS; null: another target
  store: string | null;
  ns: string | null;
}

export interface PveTaskResult {
  upid: string;
  at: number; // end, unix ms
  ok: boolean;
  error?: string;
}

export interface GuestDoc {
  _id: string; // <cluster>/<vmid>
  cluster: string;
  vmid: number;
  type: 'lxc' | 'qemu';
  node: string;
  name: string;
  macs: string[];
  jobs: PveJobRef[];
  lastTask?: PveTaskResult | null;
  tz: string;
  seenAt: Date;
}

// Backup of directories defined in the hub and run by the agent of the host (see backupJobs.ts).
export interface BackupArchive {
  name: string; // <name>.pxar
  path: string;
}

export interface BackupRun {
  start: number; // unix ms
  end: number;
  ok: boolean;
  error?: string | null;
  trigger: string; // schedule | catchup | manual
  jobId?: ObjectId | null; // JobDoc of the run
  prepared?: PreparedDump[]; // dumps of the preparation of the run
}

// Size of a dump of a run and of its database, reported by the agent (-1: unknown).
export interface PreparedDump {
  archive: string;
  database?: string; // empty: PostgreSQL globals, or the whole cluster
  dbSize: number;
  dumpSize: number;
}

// Dump made by the agent before the backup (agent/prepare.go): its sub-directories of workDir become
// archives of the snapshot (preparedArchives in backupJobs.ts).
export interface BackupPrepare {
  type: 'postgres' | 'mongodb';
  mode?: 'databases' | 'cluster'; // postgres
  databases: string[];
  container?: string; // mongodb
  workDir: string;
  keep: number; // dumps kept on the host after the backup (0: removed once sent)
  cleanup?: boolean; // first form (agent 0.2.0 in development): true = keep 0, false = keep 1
}

export interface BackupJobDoc {
  _id: ObjectId;
  hostId: ObjectId;
  name: string;
  archives: BackupArchive[];
  excludes: string[];
  store: string;
  ns: string;
  backupId: string; // fixed at creation: the group on the PBS
  schedule: string; // calendar event (calendar.ts)
  timezone: string;
  enabled: boolean;
  prepare?: BackupPrepare | null;
  createdAt: Date;
  updatedAt: Date;
  lastRun?: BackupRun | null;
}

export interface BackupManaged {
  jobId: string;
  name: string;
  tz: string;
  schedule: string;
  enabled: boolean;
  lastRun?: { at: number; ok: boolean; error?: string | null; prepared?: PreparedDump[] } | null;
  // dump made before the backup
  prepare?: BackupPrepare | null;
  // the agent applied the current definition
  synced: boolean;
  // creation of the job (unix ms): runs scheduled before it are not expected
  since?: number;
}

// Destination (backup agent of Core) of the Home Assistant backups, see haBackups.ts.
export interface BackupHa {
  agentId: string; // backup.local, hassio.local, sftp_storage...
  // the automatic backups go to this destination
  automatic: boolean;
  schedule: { recurrence: string; days: string[]; time: string | null } | null;
  tz: string; // of Home Assistant
  // unix ms of the automatic backups (all destinations)
  next: number | null;
  lastAttempted: number | null;
  lastCompleted: number | null;
  // last automatic backup that failed to reach this destination
  failedAt: number | null;
  // destination that could not be listed
  error: string | null;
}

export interface BackupPve {
  cluster: string;
  vmid: number;
  tz: string;
  jobs: PveJobRef[]; // jobs writing this group
  lastTask?: PveTaskResult | null;
}
