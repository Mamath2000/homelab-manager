import type { ObjectId } from 'mongodb';
import type { UpsReport } from './ups.js';

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

// Network an agent reaches the hub (and the PBS) through, chosen when the host is created; absent: lan
export const ACCESS_NETWORKS = ['lan', 'tailscale'] as const;
export type AccessNetwork = (typeof ACCESS_NETWORKS)[number];

export interface HostDoc {
  _id: ObjectId;
  name: string;
  // free text of the first versions, moved to a tag at start (migrateGroups)
  group?: string;
  siteId?: string;
  tags?: string[];
  // absent: lan. Fixed at creation: changing it means reinstalling the agent
  accessNetwork?: Exclude<AccessNetwork, 'lan'>;
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
  ups?: UpsReport;
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
  // an offline host raises a critical alert instead of a warning
  critical?: boolean;
  // not published to Home Assistant (no device, not counted in the totals)
  haExcluded?: boolean;
  // Proxmox VE guest this host is (one of its MAC addresses), recomputed at each PVE poll; see pve.ts
  pve?: HostPveLink | null;
  // backups run by the agent (see backupJobs.ts): its PBS token, and the last definition it applied
  // store: datastore the token was given rights on (token created by the command of the UI); unknown otherwise
  pbsCredential?: { tokenId: string; tokenSecret: string; updatedAt: Date; store?: string };
  backupSync?: { hash: string; at: Date; error?: string | null };
  // Nextcloud AIO plugin of this host (nextcloud.ts): what its generated backup jobs back up
  nextcloud?: NextcloudPlugin | null;
}

// Settings of the Nextcloud AIO plugin of a host: one datastore per part backed up (null: not backed up).
export interface NextcloudPlugin {
  workDir: string; // database/ and config/ below it
  keep: number; // dumps kept on the host
  schedule: string;
  enabled: boolean;
  database: string | null;
  config: string | null;
  users: { id: string; store: string }[];
  // data directory found by the agent at the last save (directories of the users)
  dataDir: string;
  updatedAt: Date;
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
// offsite_run: copy to the secondary PBS, run by the hub (offsite.ts); backupJobName names the backup
export type JobAction = (typeof JOB_ACTIONS)[number] | 'backup_run' | 'backup_install' | 'offsite_run';
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

// API key of an account (`Authorization: Bearer hm_…`): only its hash is stored. The key has the rights
// of the account's role.
export interface ApiKeyDoc {
  _id: ObjectId;
  userId: ObjectId;
  name: string;
  hash: string; // sha256 of the key
  createdAt: Date;
  lastUsedAt?: Date;
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
  // host name or IP of the hub on the tailnet, typed by hand; empty: the Tailscale access network is not offered
  tailscaleHub: string;
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

// Agent that administers a PBS (pbsAgent.ts): the host it runs on, natively or in a container,
// found by pbs_detect and validated by the admin.
export interface PbsAgentLink {
  hostId: string;
  mode: 'native' | 'container';
  container?: string;
}

export interface PbsSettings {
  _id: 'pbs';
  enabled: boolean;
  // agent that creates the tokens on this PBS (all of them: monitoring, hosts)
  agent?: PbsAgentLink;
  url: string; // https://pbs:8007
  // sha256 of the PBS certificate (AB:CD:...), pinned; empty: verified against the system CAs
  fingerprint: string;
  tokenId: string; // user@realm!token
  tokenSecret: string;
  // address of the PBS for the hosts of the Tailscale access network (same certificate); empty: they cannot back up
  tailscaleUrl?: string;
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
  // copy to the secondary PBS (offsite.ts); written by the routes and the poll of the secondary only
  offsite?: BackupOffsite;
}

// Copy of a group to the secondary PBS: the sync job of its datastore and namespace, pulled by the
// secondary. Enabled by the admin; the rest is the poll of the secondary and the runs followed.
export interface BackupOffsite {
  enabled: boolean;
  jobId: string; // sync job of its datastore and namespace (offsite.ts syncJobId)
  since: number; // enabled at (ms)
  // the sync job could not be created / updated (reconciliation)
  error?: string | null;
  // poll of the secondary: the copied group
  lastBackup?: number | null; // unix ms of the last snapshot copied
  count?: number;
  verify?: 'ok' | 'failed' | null;
  size?: number | null; // of the last snapshot copied
  times?: BackupSnapshot[]; // last snapshots on the secondary, oldest first (timeline)
  // last run of its sync job, for this group (a group can fail in a run that copies others)
  lastRun?: { start: number; end: number; ok: boolean; error?: string } | null;
  // run of its sync job being followed by the hub: its task and the job of the hub (Activité); current: this
  // group is the one being copied
  running?: { upid: string; start: number; jobId: string; current?: boolean } | null;
  // last task recorded as a job (a run the hub did not follow is recorded at the next poll)
  recordedUpid?: string | null;
}

// Secondary PBS (settings._id 'pbs-remote'): pulls from the main PBS the groups chosen one by one.
export interface PbsRemoteSettings {
  _id: 'pbs-remote';
  enabled: boolean;
  agent?: PbsAgentLink;
  url: string;
  fingerprint: string;
  store: string; // target datastore, the one the token of the hub has rights on
  tokenId: string; // token of the hub on the secondary
  tokenSecret: string;
  readerTokenId: string; // token on the main PBS, used by the secondary to pull
  readerTokenSecret: string;
  // remote entry last written on the secondary (hash of address, fingerprint, reader token)
  remoteHash?: string;
  // daily series of the copies, started by the agent of the secondary (agent offsite.go): HH:MM
  startTime?: string;
  agentAck?: string | null; // hash of the definition the agent applied
  agentError?: string | null; // the agent refused the definition
  agentReport?: (OffsiteSeriesReport & { receivedAt: Date }) | null;
  polledAt?: Date;
  pollError?: string | null;
  usage?: PbsDatastoreUsage | null;
}

// State of the series, as the agent of the secondary reports it (offsite_report).
export interface OffsiteSeriesReport {
  hash: string;
  day: string; // last series started (YYYY-MM-DD), "": never
  total: number; // jobs of that series
  pending: string[]; // not started yet
  running?: { jobId?: string; upid: string; start: number } | null; // sync task running (jobId: one of ours)
  nextStart: number; // unix ms, 0: nothing to copy
  error?: string;
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
  agent?: { hostId: string }; // node whose agent created the token (pveAgent.ts)
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

// Sites, described in the settings (display order of the dashboard); a host belongs to one of them
// (siteId). main: main site, vpn: reached through a VPN, external: supervised from afar.
export const SITE_KINDS = ['main', 'vpn', 'external'] as const;
export type SiteKind = (typeof SITE_KINDS)[number];
export interface SiteConfig {
  id: string;
  name: string;
  kind: SiteKind;
  color: TagColor;
}
export interface SitesSettings {
  _id: 'sites';
  sites: SiteConfig[];
}

// Tags put on the hosts (several per host), with their colour chosen at creation.
export const TAG_COLORS = ['zinc', 'red', 'orange', 'amber', 'lime', 'emerald', 'teal', 'sky', 'blue', 'violet', 'pink'] as const;
export type TagColor = (typeof TAG_COLORS)[number];
export interface TagConfig {
  id: string;
  name: string;
  color: TagColor;
}
export interface TagsSettings {
  _id: 'tags';
  tags: TagConfig[];
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
  trigger: string; // schedule | catchup | connect | manual
  jobId?: ObjectId | null; // JobDoc of the run
  dumps?: DumpInfo[]; // database job: the dumps of the run
}

// Size of a dump of a run and of its database, reported by the agent (-1: unknown).
export interface DumpInfo {
  archive: string;
  database?: string; // empty: PostgreSQL globals, or the whole cluster
  dbSize: number;
  dumpSize: number;
}

// Kind of backup job: directories, or the dump of databases (agent/database.go), whose dumps (one
// sub-directory of workDir each) are the archives of the snapshot (dumpArchives in backupJobs.ts).
export type BackupJobKind = 'directories' | 'postgres' | 'mongodb' | 'nextcloud';

export interface DatabaseDump {
  mode?: 'databases' | 'cluster' | 'database' | 'config'; // postgres: databases | cluster; nextcloud: database | config
  databases: string[];
  container?: string; // mongodb
  workDir: string;
  keep: number; // dumps kept on the host after the backup (0: removed once sent)
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
  schedule: string; // calendar event (calendar.ts); empty when connectEveryDays is set
  // roaming hosts: instead of a schedule, run when the agent connects, at most once every N days
  // (since the last successful run)
  connectEveryDays?: number;
  timezone: string;
  enabled: boolean;
  kind?: BackupJobKind; // absent: directories
  database?: DatabaseDump | null;
  // first form of the database jobs (agent 0.2.0 in development): read as kind + database
  prepare?: (DatabaseDump & { type: 'postgres' | 'mongodb'; cleanup?: boolean }) | null;
  // generated by a plugin (nextcloud.ts): changed or removed through it only
  plugin?: JobPlugin | null;
  createdAt: Date;
  updatedAt: Date;
  lastRun?: BackupRun | null;
}

// part of a Nextcloud AIO instance a generated job backs up: database, config or user:<id>
export interface JobPlugin {
  name: 'nextcloud';
  part: string;
}

export interface BackupManaged {
  jobId: string;
  name: string;
  tz: string;
  schedule: string;
  connectEveryDays?: number;
  enabled: boolean;
  lastRun?: { at: number; ok: boolean; error?: string | null; dumps?: DumpInfo[] } | null;
  kind?: BackupJobKind;
  database?: DatabaseDump | null;
  plugin?: JobPlugin | null;
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

// Alerts of a host over the last days (alerts.ts): latest observed level of the day in each domain, with its reasons
export type AlertLevel = 'ok' | 'warn' | 'alert';
export type AlertDomain = 'system' | 'apt' | 'docker' | 'backup' | 'offsite' | 'ups';
export interface DayAlert {
  level: AlertLevel;
  reasons: string[];
}
export interface HostAlertDoc {
  _id?: ObjectId;
  hostId: ObjectId;
  day: string; // YYYY-MM-DD, time zone of the hub
  // one field per domain (see monitoring.ts DOMAINS)
  system?: DayAlert;
  apt?: DayAlert;
  docker?: DayAlert;
  backup?: DayAlert;
  offsite?: DayAlert;
  ups?: DayAlert;
  updatedAt: Date;
  expiresAt: Date;
}
