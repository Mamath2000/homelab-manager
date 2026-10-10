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
  // compose stacks managed elsewhere (own update system...): listed, but no state nor action
  unmanagedStacks?: string[];
  // standardisation: what this host does differently from the standard configuration, last check
  setupOverrides?: SetupOverrides;
  setup?: SetupState;
  // new host: the standard configuration is applied at its first connection (Paramètres > Standardisation)
  setupPending?: boolean;
  // not connected permanently (laptop...): being offline is expected, neither an error nor an alert
  roaming?: boolean;
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
export type JobAction = (typeof JOB_ACTIONS)[number];
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
