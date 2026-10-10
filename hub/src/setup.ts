import type { ObjectId } from 'mongodb';
import { agentRequest, isOnline } from './agents.js';
import { hosts, settings } from './db.js';
import { publish } from './events.js';
import { hostDto } from './hostDto.js';
import { createJob } from './jobs.js';
import { SETUP_MODULES, type HostDoc, type JobDoc, type SetupModule, type SetupProfile, type SetupState } from './types.js';

// Standardisation of the hosts: a profile (Paramètres > Standardisation) whose modules are pushed to
// the agents (agent/setup.go). The agent receives values, never commands; it checks them again.

export const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
export const PKG_RE = /^[a-z0-9][a-z0-9+.\-:]*$/;
export const SSH_KEY_RE =
  /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/;
export const PROXY_RE = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/?$/;
export const MAX_TEXT = 64 * 1024;

// The defaults reproduce homeSetup's dispatch_full, minus what Homelab Manager does itself
// (chk_apt.sh / up_apt.sh) and the prompt / fastfetch lines, now separate modules.
export const DEFAULT_SETUP: SetupProfile = {
  _id: 'setup',
  autoApply: false,
  modules: ['packages', 'aliases', 'prompt', 'motd'],
  user: '',
  sudoNoPassword: false,
  packages: ['net-tools', 'fzf', 'mosquitto-clients', 'git', 'wget', 'htop', 'rsync', 'gnupg2', 'jq', 'curl', 'ethtool', 'bc'],
  sshKeys: [],
  allowPassword: true,
  aliases: [
    '# some more ls aliases',
    "alias ll='ls -lh'",
    "alias la='ls -Ahl'",
    "alias l='ls -CFh'",
    "alias du='du -hs'",
    "alias df='df -h'",
    "alias up='sudo apt-get update && sudo apt-get dist-upgrade'",
    '',
    "alias dockps=\"docker ps --format 'CONTAINER ID : {{.ID}} | Name: {{.Names}}'\"",
    "alias dc='docker compose'",
    '',
    "alias vp='sudo netstat -tlnp | grep '",
    "alias ddu='sudo du -h --max-depth=0 '",
    '',
  ].join('\n'),
  prompt: 'classic',
  motd: 'homelab',
  aptProxy: '',
  sshConfig: '',
};

export async function loadSetupProfile(): Promise<SetupProfile> {
  return { ...DEFAULT_SETUP, ...((await settings.findOne({ _id: 'setup' })) as SetupProfile | null), _id: 'setup' };
}

// Error message for an invalid profile, null when it is fine.
export function profileError(p: SetupProfile): string | null {
  if (p.user && !USER_RE.test(p.user)) return "nom d'utilisateur invalide (minuscules, chiffres, _ et -)";
  const pkg = p.packages.find((x) => !PKG_RE.test(x));
  if (pkg) return `nom de paquet invalide : ${pkg}`;
  const key = p.sshKeys.find((k) => !SSH_KEY_RE.test(k));
  if (key) return `clé SSH invalide : ${key.slice(0, 40)}…`;
  if (p.aptProxy && !PROXY_RE.test(p.aptProxy)) return 'proxy APT invalide (http://hôte:port)';
  if (p.modules.includes('ssh_password') && !p.allowPassword && !p.modules.includes('ssh_keys')) {
    return "interdire le mot de passe SSH demande aussi le module « Clés SSH », sinon l'hôte devient injoignable";
  }
  return null;
}

export const hostUser = (h: HostDoc, p: SetupProfile) => h.setupUser ?? p.user;

// What the agent receives: the modules and only the parameters they need.
export function buildSpec(p: SetupProfile, modules: SetupModule[], user: string) {
  const ordered = SETUP_MODULES.filter((m) => modules.includes(m));
  const has = (m: SetupModule) => ordered.includes(m);
  return {
    user,
    modules: ordered,
    ...(has('user') ? { sudoNoPassword: p.sudoNoPassword } : {}),
    ...(has('packages') ? { packages: p.packages } : {}),
    ...(has('ssh_keys') ? { sshKeys: p.sshKeys } : {}),
    ...(has('ssh_password') ? { allowPassword: p.allowPassword } : {}),
    ...(has('aliases') ? { aliases: p.aliases } : {}),
    ...(has('prompt') ? { prompt: p.prompt } : {}),
    ...(has('motd') ? { motd: p.motd } : {}),
    ...(has('apt_proxy') ? { aptProxy: p.aptProxy } : {}),
    ...(has('ssh_config') ? { sshConfig: p.sshConfig } : {}),
  };
}

export const canSetup = (h: { capabilities?: string[] }) => !!h.capabilities?.includes('setup');

// Conformity of a host with the standard configuration, as checked by its agent.
export async function checkHostSetup(hostId: ObjectId) {
  const host = await hosts.findOne({ _id: hostId });
  if (!host || !canSetup(host) || !isOnline(hostId.toHexString())) return;
  const p = await loadSetupProfile();
  const state = await agentRequest<SetupState>(hostId.toHexString(), 'setup_check', { setup: buildSpec(p, p.modules, hostUser(host, p)) }, 60_000);
  const updated = await hosts.findOneAndUpdate({ _id: hostId }, { $set: { setup: state } }, { returnDocument: 'after' });
  if (updated) publish('host', hostDto(updated));
}

export function checkAllHosts() {
  return hosts
    .find({ capabilities: 'setup' }, { projection: { _id: 1 } })
    .toArray()
    .then((list) => Promise.allSettled(list.map((h) => checkHostSetup(h._id))));
}

export async function applySetup(host: HostDoc, modules: SetupModule[], user: string | undefined, trigger: JobDoc['trigger']) {
  const p = await loadSetupProfile();
  const u = user ?? hostUser(host, p);
  if (user !== undefined && user !== host.setupUser) await hosts.updateOne({ _id: host._id }, { $set: { setupUser: user } });
  return createJob(host, 'setup_apply', [], trigger, { setup: buildSpec(p, modules, u) });
}

// First connection of a new host: standard configuration if the profile says so, conformity otherwise.
export async function onAgentHello(hostId: ObjectId) {
  const host = await hosts.findOne({ _id: hostId });
  if (!host || !canSetup(host)) return;
  if (host.setupPending) {
    await hosts.updateOne({ _id: hostId }, { $unset: { setupPending: '' } });
    const p = await loadSetupProfile();
    if (p.autoApply && p.modules.length) {
      await applySetup(host, p.modules, undefined, 'enroll');
      return;
    }
  }
  await checkHostSetup(hostId);
}
