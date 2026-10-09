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

export interface HostDoc {
  _id: ObjectId;
  name: string;
  group?: string;
  tokenHash: string;
  createdAt: Date;
  enrolledAt?: Date;
  lastSeenAt?: Date;
  lastAutoCheckAt?: Date;
  agentVersion?: string;
  // actions announced by the agent (absent with old agents)
  capabilities?: string[];
  info?: HostInfo;
  apt?: AptReport;
  aptSummary?: AptSummary;
}

export const JOB_ACTIONS = ['apt_report', 'apt_update', 'apt_upgrade', 'apt_autoremove', 'reboot'] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];
export type JobStatus = 'running' | 'success' | 'failed';

export interface JobDoc {
  _id: ObjectId;
  hostId: ObjectId;
  hostName: string;
  action: JobAction;
  packages: string[];
  trigger: 'manual' | 'schedule' | 'homeassistant';
  status: JobStatus;
  createdAt: Date;
  finishedAt?: Date;
  exitCode?: number;
  error?: string;
  log: string;
}

export interface UserDoc {
  _id: ObjectId;
  username: string;
  passwordHash: string;
  createdAt: Date;
}

export interface SessionDoc {
  _id: string; // sha256 of the cookie token
  userId: ObjectId;
  expiresAt: Date;
}

export interface HomeAssistantSettings {
  _id: 'homeassistant';
  enabled: boolean;
  broker: string; // mqtt://host:1883, mqtts://...
  username: string;
  password: string;
  topic: string; // prefix of the state / command topics
  discoveryPrefix: string;
}
