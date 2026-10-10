import type { ObjectId } from 'mongodb';
import { agentRequest, isOnline } from './agents.js';
import { hosts, settings } from './db.js';
import { publish } from './events.js';
import { hostDto } from './hostDto.js';
import { DEFAULT_FASTFETCH } from './fastfetch.js';
import { createJob } from './jobs.js';
import {
  LIST_OPTIONS,
  SETUP_OPTIONS,
  type HostDoc,
  type JobDoc,
  type ListOption,
  type SetupOption,
  type SetupOverrides,
  type SetupProfile,
  type SetupState,
  type SetupValues,
} from './types.js';

// Standardisation of the hosts: a profile (Paramètres > Standardisation) whose options are pushed to
// the agents, each host able to override them (agent/setup.go). The agent receives values, never commands; it checks them again.

export const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
export const PKG_RE = /^[a-z0-9][a-z0-9+.\-:]*$/;
export const SSH_KEY_RE =
  /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/;
export const MAX_TEXT = 64 * 1024;

const DEFAULT_ALIASES = [
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
].join('\n');

// The defaults reproduce homeSetup's dispatch_full, minus what Homelab Manager does itself
// (chk_apt.sh / up_apt.sh) and the prompt / fastfetch lines, now separate options.
export const DEFAULT_SETUP: SetupProfile = {
  _id: 'setup',
  autoApply: false,
  options: {
    packages: { enabled: true, value: ['net-tools', 'fzf', 'mosquitto-clients', 'git', 'wget', 'htop', 'rsync', 'gnupg2', 'jq', 'curl', 'ethtool', 'bc'] },
    ssh_password: { enabled: false, value: true },
    root_keys: { enabled: false, value: [] },
    root_aliases: { enabled: true, value: DEFAULT_ALIASES },
    root_prompt: { enabled: true, value: 'classic' },
    root_motd: { enabled: true, value: 'homelab' },
    user: { enabled: false, value: { name: '', sudoNoPassword: false } },
    user_keys: { enabled: false, value: [] },
    user_aliases: { enabled: false, value: DEFAULT_ALIASES },
    user_prompt: { enabled: false, value: 'classic' },
    user_motd: { enabled: false, value: 'homelab' },
  },
  fastfetch: DEFAULT_FASTFETCH,
};

export const isListOption = (k: SetupOption): k is ListOption => (LIST_OPTIONS as readonly string[]).includes(k);
export const isUserOption = (k: SetupOption) => k.startsWith('user_');

export async function loadSetupProfile(): Promise<SetupProfile> {
  const saved = (await settings.findOne({ _id: 'setup' })) as Partial<SetupProfile> | null;
  const options = { ...DEFAULT_SETUP.options };
  // options added since the profile was saved keep their default
  for (const k of SETUP_OPTIONS) {
    const o = saved?.options?.[k];
    if (o) (options as Record<string, unknown>)[k] = o;
  }
  return {
    _id: 'setup',
    autoApply: saved?.autoApply ?? DEFAULT_SETUP.autoApply,
    options,
    fastfetch: saved?.fastfetch ?? DEFAULT_SETUP.fastfetch,
  };
}

// Error message for an invalid option value, null when it is fine.
export function valueError<K extends SetupOption>(k: K, v: SetupValues[K]): string | null {
  if (k === 'packages') {
    const bad = (v as string[]).find((x) => !PKG_RE.test(x));
    if (bad) return `nom de paquet invalide : ${bad}`;
  } else if (k === 'root_keys' || k === 'user_keys') {
    const bad = (v as string[]).find((x) => !SSH_KEY_RE.test(x));
    if (bad) return `clé SSH invalide : ${bad.slice(0, 40)}…`;
  } else if (k === 'user') {
    const name = (v as SetupValues['user']).name;
    if (!USER_RE.test(name) || name === 'root') return "nom d'utilisateur invalide (minuscules, chiffres, _ et -, pas root)";
  }
  return null;
}

function fastfetchError(fastfetch: string) {
  try {
    JSON.parse(fastfetch);
    return null;
  } catch (err) {
    return `configuration fastfetch invalide : ${(err as Error).message}`;
  }
}

// forbidding passwords without pushing any key could lock the host out
function lockoutError(v: Partial<SetupValues>) {
  if (v.ssh_password !== false) return null;
  const keys = (v.root_keys?.length ?? 0) + (v.user ? (v.user_keys?.length ?? 0) : 0);
  return keys ? null : "interdire le mot de passe SSH demande des clés SSH pour root ou l'utilisateur, sinon l'hôte devient injoignable";
}

// Values applied to a host: the standard ones, changed by its overrides; options absent are not managed.
export function effectiveValues(p: SetupProfile, overrides: SetupOverrides = {}): Partial<SetupValues> {
  const out: Partial<Record<SetupOption, unknown>> = {};
  for (const k of SETUP_OPTIONS) {
    const std = p.options[k];
    const o = overrides[k];
    if (!o) {
      if (std.enabled) out[k] = std.value;
    } else if (o.mode === 'custom') {
      out[k] = o.value;
    } else if (o.mode === 'extra' && isListOption(k)) {
      out[k] = [...new Set([...(std.enabled ? (std.value as string[]) : []), ...o.add])];
    }
  }
  // the user options need the user
  if (!out.user) for (const k of SETUP_OPTIONS) if (isUserOption(k)) delete out[k];
  return out as Partial<SetupValues>;
}

// Error message for an invalid profile, null when it is fine.
export function profileError(p: SetupProfile): string | null {
  for (const k of SETUP_OPTIONS) {
    const o = p.options[k];
    // an unused user name may stay empty
    if (k === 'user' && !o.enabled) continue;
    const err = valueError(k, o.value);
    if (err) return err;
  }
  const v = effectiveValues(p);
  if ((v.root_motd === 'fastfetch' || v.user_motd === 'fastfetch') && fastfetchError(p.fastfetch)) return fastfetchError(p.fastfetch);
  return lockoutError(v);
}

// Error message for invalid host overrides, null when they are fine.
export function overridesError(p: SetupProfile, overrides: SetupOverrides): string | null {
  for (const k of SETUP_OPTIONS) {
    const o = overrides[k];
    if (o?.mode === 'custom') {
      if (o.value === undefined) return `valeur manquante pour ${k}`;
      const err = valueError(k, o.value as SetupValues[typeof k]);
      if (err) return err;
    } else if (o?.mode === 'extra') {
      if (!isListOption(k)) return `ajouts impossibles pour ${k}`;
      if (!o.add) return `ajouts manquants pour ${k}`;
      const err = valueError(k, o.add);
      if (err) return err;
    }
  }
  return lockoutError(effectiveValues(p, overrides));
}

const accountSpec = (v: Partial<SetupValues>, prefix: 'root' | 'user') => ({
  ...(v[`${prefix}_keys`] ? { sshKeys: v[`${prefix}_keys`] } : {}),
  ...(v[`${prefix}_aliases`] !== undefined ? { aliases: v[`${prefix}_aliases`] } : {}),
  ...(v[`${prefix}_prompt`] ? { prompt: v[`${prefix}_prompt`] } : {}),
  ...(v[`${prefix}_motd`] ? { motd: v[`${prefix}_motd`] } : {}),
});

// What the agent receives: the managed options (in SETUP_OPTIONS order) and only their values.
export function buildSpec(p: SetupProfile, overrides?: SetupOverrides) {
  const v = effectiveValues(p, overrides);
  const modules = SETUP_OPTIONS.filter((k) => k in v);
  return {
    modules,
    ...(v.packages ? { packages: v.packages } : {}),
    ...(v.ssh_password !== undefined ? { allowPassword: v.ssh_password } : {}),
    root: accountSpec(v, 'root'),
    ...(v.user ? { user: { ...v.user, ...accountSpec(v, 'user') } } : {}),
    ...(v.root_motd === 'fastfetch' || v.user_motd === 'fastfetch' ? { fastfetch: p.fastfetch } : {}),
  };
}

export const canSetup = (h: { capabilities?: string[] }) => !!h.capabilities?.includes('setup');

// Conformity of a host with its values (standard ones and overrides), as checked by its agent.
export async function checkHostSetup(hostId: ObjectId) {
  const host = await hosts.findOne({ _id: hostId });
  if (!host || !canSetup(host) || !isOnline(hostId.toHexString())) return;
  const p = await loadSetupProfile();
  const state = await agentRequest<SetupState>(hostId.toHexString(), 'setup_check', { setup: buildSpec(p, host.setupOverrides) }, 60_000);
  const updated = await hosts.findOneAndUpdate({ _id: hostId }, { $set: { setup: state } }, { returnDocument: 'after' });
  if (updated) publish('host', hostDto(updated));
}

export function checkAllHosts() {
  return hosts
    .find({ capabilities: 'setup' }, { projection: { _id: 1 } })
    .toArray()
    .then((list) => Promise.allSettled(list.map((h) => checkHostSetup(h._id))));
}

export async function applySetup(host: HostDoc, trigger: JobDoc['trigger']) {
  const p = await loadSetupProfile();
  return createJob(host, 'setup_apply', [], trigger, { setup: buildSpec(p, host.setupOverrides) });
}

// First connection of a new host: standard configuration if the profile says so, conformity otherwise.
export async function onAgentHello(hostId: ObjectId) {
  const host = await hosts.findOne({ _id: hostId });
  if (!host || !canSetup(host)) return;
  if (host.setupPending) {
    await hosts.updateOne({ _id: hostId }, { $unset: { setupPending: '' } });
    const p = await loadSetupProfile();
    if (p.autoApply && SETUP_OPTIONS.some((k) => p.options[k].enabled)) {
      await applySetup(host, 'enroll');
      return;
    }
  }
  await checkHostSetup(hostId);
}
