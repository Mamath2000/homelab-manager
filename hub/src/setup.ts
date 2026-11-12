import type { ObjectId } from 'mongodb';
import { agentRequest, isOnline } from './agents.js';
import { config } from './config.js';
import { hosts, settings } from './db.js';
import { publish } from './events.js';
import { hostDto } from './hostDto.js';
import { parse as parseToml } from 'smol-toml';
import { DEFAULT_FASTFETCH } from './fastfetch.js';
import { createJob } from './jobs.js';
import { DEFAULT_STARSHIP } from './starship.js';
import { logRole, logTargets, silentReason, type LogTarget } from './logs.js';
import { ROLE_ID_RE } from './roles.js';
import {
  ACCESS_OPTIONS,
  LIST_OPTIONS,
  SETUP_OPTIONS,
  type AccessReport,
  type AckedKey,
  type HostDoc,
  type JobDoc,
  type ListOption,
  type SetupOption,
  type SetupCheck,
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
    log_forward: { enabled: false, value: { role: '' } },
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
  starship: DEFAULT_STARSHIP,
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
    starship: saved?.starship ?? DEFAULT_SETUP.starship,
  };
}

// What the signed access manifest of homelab#312 held, as the hub stored it.
interface LegacyAccess {
  manifest?: { root?: { sshKeys?: string[] }; user?: { name: string; sudoNoPassword?: boolean; sshKeys?: string[] } };
}

// homelab#320: the signed access manifest is retired. Once, at start: its content (what the hosts got) becomes the
// standard values of the access options, and the host values of these options from before it, ignored while it was
// in place, are dropped (only « Non géré » stays). Then the stored manifest is deleted.
export async function migrateAccessManifest(log: { info: (o: object, m: string) => void }) {
  const legacy = (await settings.findOne({ _id: 'access' as never })) as LegacyAccess | null;
  if (!legacy) return;
  const m = legacy.manifest;
  if (m) {
    const p = await loadSetupProfile();
    const o = p.options;
    o.root_keys.value = m.root?.sshKeys ?? [];
    if (m.user) {
      o.user.value = { name: m.user.name, sudoNoPassword: m.user.sudoNoPassword === true };
      o.user_keys.value = m.user.sshKeys ?? [];
    } else {
      // no user in the manifest: the agents applied none
      o.user.enabled = false;
    }
    await settings.replaceOne({ _id: 'setup' }, p, { upsert: true });
  }
  let dropped = 0;
  for (const k of ACCESS_OPTIONS) {
    const r = await hosts.updateMany({ [`setupOverrides.${k}.mode`]: { $in: ['custom', 'extra'] } }, { $unset: { [`setupOverrides.${k}`]: '' } });
    dropped += r.modifiedCount;
  }
  await settings.deleteOne({ _id: 'access' as never });
  log.info({ fromManifest: !!m, hostValuesDropped: dropped }, 'access: signed manifest retired, its content is now the standard (homelab#320)');
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
  } else if (k === 'log_forward') {
    const role = (v as SetupValues['log_forward']).role;
    if (role && !ROLE_ID_RE.test(role)) return 'serveur de logs invalide';
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

function starshipError(starship: string) {
  try {
    parseToml(starship);
    return null;
  } catch (err) {
    return `configuration Starship invalide : ${(err as Error).message.split('\n')[0]}`;
  }
}

// forbidding passwords without pushing any key could lock the host out
function lockoutError(v: Partial<SetupValues>) {
  if (v.ssh_password !== false) return null;
  const keys = (v.root_keys?.length ?? 0) + (v.user ? (v.user_keys?.length ?? 0) : 0);
  return keys ? null : "interdire le mot de passe SSH demande des clés SSH pour root ou l'utilisateur, sinon l'hôte devient injoignable";
}

// The journals are sent to a log server that exists; no server ('') only as the own value of a host (it sends nothing).
function logForwardError(v: SetupValues['log_forward'] | undefined, standard: boolean) {
  if (!v) return null;
  if (!v.role) return standard ? "envoi des journaux : choisir un serveur de logs (Paramètres › Rôles)" : null;
  return logRole(v.role) ? null : "envoi des journaux : ce serveur de logs n'existe plus";
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
    const err = valueError(k, o.value as SetupValues[typeof k]);
    if (err) return err;
  }
  const v = effectiveValues(p);
  if ((v.root_motd === 'fastfetch' || v.user_motd === 'fastfetch') && fastfetchError(p.fastfetch)) return fastfetchError(p.fastfetch);
  if ((v.root_prompt === 'starship' || v.user_prompt === 'starship') && starshipError(p.starship)) return starshipError(p.starship);
  return logForwardError(v.log_forward, true) ?? lockoutError(v);
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
  const custom = overrides.log_forward?.mode === 'custom' ? overrides.log_forward.value : undefined;
  return logForwardError(custom, false) ?? lockoutError(effectiveValues(p, overrides));
}

const accountSpec = (v: Partial<SetupValues>, prefix: 'root' | 'user') => ({
  ...(v[`${prefix}_keys`] ? { sshKeys: v[`${prefix}_keys`] } : {}),
  ...(v[`${prefix}_aliases`] !== undefined ? { aliases: v[`${prefix}_aliases`] } : {}),
  ...(v[`${prefix}_prompt`] ? { prompt: v[`${prefix}_prompt`] } : {}),
  ...(v[`${prefix}_motd`] ? { motd: v[`${prefix}_motd`] } : {}),
});

// What a spec depends on outside the profile: what the agent of the host can do, and where each log server receives.
export interface SpecContext {
  capabilities?: string[];
  targets?: Map<string, LogTarget>;
}

// Why the journals option of a host cannot be sent to its agent (null: it can): the hub then reports it itself.
export function logForwardSkip(v: Partial<SetupValues>, ctx: SpecContext = {}): Pick<SetupCheck, 'state' | 'detail'> | null {
  if (!v.log_forward) return null;
  if (!ctx.capabilities?.includes('log_forward')) return { state: 'na', detail: "agent à mettre à jour (ou hôte sans systemd)" };
  if (v.log_forward.role && !ctx.targets?.get(v.log_forward.role)?.address) return { state: 'error', detail: 'serveur de logs introuvable, ou sans adresse connue' };
  return null;
}

// What the agent receives: the managed options (in SETUP_OPTIONS order, restricted to `only` when
// given) and their values; the user values travel with any user option (the account name). The journals option
// is resolved here: the agent gets the address of the log server, not its role.
export function buildSpec(p: SetupProfile, overrides?: SetupOverrides, only?: SetupOption[], ctx: SpecContext = {}) {
  const v = effectiveValues(p, overrides);
  const skipLogs = !!logForwardSkip(v, ctx);
  const modules = SETUP_OPTIONS.filter((k) => k in v && (!only || only.includes(k)) && !(k === 'log_forward' && skipLogs));
  return {
    modules,
    ...(v.packages ? { packages: v.packages } : {}),
    ...(v.ssh_password !== undefined ? { allowPassword: v.ssh_password } : {}),
    ...(v.log_forward && !skipLogs ? { logForward: v.log_forward.role ? ctx.targets!.get(v.log_forward.role)! : { address: '' } } : {}),
    root: accountSpec(v, 'root'),
    ...(v.user ? { user: { ...v.user, ...accountSpec(v, 'user') } } : {}),
    ...(v.root_motd === 'fastfetch' || v.user_motd === 'fastfetch' ? { fastfetch: p.fastfetch } : {}),
    ...(v.root_prompt === 'starship' || v.user_prompt === 'starship' ? { starship: p.starship } : {}),
  };
}

// FEATURE_STANDARDISATION off: no host can be standardised (no application, no check)
export const canSetup = (h: { capabilities?: string[] }) => config.featureStandardisation && !!h.capabilities?.includes('setup');

// A validation lasts as long as its key stays on the host outside the configuration: gone, or configured since,
// it is dropped (a key coming back is flagged again). An unreadable report (error, option off) changes nothing.
function prunedAckedKeys(acked: AckedKey[] | undefined, access: AccessReport | undefined) {
  if (!acked?.length || access?.status !== 'ok') return {};
  const kept = acked.filter((a) => access.keys.some((k) => !k.managed && k.account === a.account && k.fingerprint === a.fingerprint));
  return kept.length === acked.length ? {} : { ackedKeys: kept };
}

// Conformity of a host with its values (standard ones and overrides), as checked by its agent.
export async function checkHostSetup(hostId: ObjectId) {
  const host = await hosts.findOne({ _id: hostId });
  if (!host || !canSetup(host) || !isOnline(hostId.toHexString())) return;
  const p = await loadSetupProfile();
  const ctx = await specContext(host);
  const state = await agentRequest<SetupState>(hostId.toHexString(), 'setup_check', { setup: buildSpec(p, host.setupOverrides, undefined, ctx) }, 60_000);
  state.modules = withLogForward(host, state, effectiveValues(p, host.setupOverrides), ctx);
  const updated = await hosts.findOneAndUpdate({ _id: hostId }, { $set: { setup: state, ...prunedAckedKeys(host.ackedKeys, state.access) } }, { returnDocument: 'after' });
  if (updated) publish('host', hostDto(updated));
}

export const specContext = async (host: Pick<HostDoc, 'capabilities'>): Promise<SpecContext> => ({ capabilities: host.capabilities, targets: await logTargets() });

// The check of the journals option as the hub completes it: the server the host was told to send to, a silence the
// server reports (conform on the host, nothing received: logs.ts), or why the option was not sent to the agent.
export function withLogForward(host: Pick<HostDoc, '_id' | 'info' | 'setup'>, state: SetupState, v: Partial<SetupValues>, ctx: SpecContext): SetupCheck[] {
  const skip = logForwardSkip(v, ctx);
  if (skip) return [...state.modules.filter((m) => m.module !== 'log_forward'), { module: 'log_forward', ...skip }];
  const role = v.log_forward?.role;
  // a host already silent stays so until the server receives from it again, whatever the date of this check
  const wasSilent = !!host.setup?.modules.find((m) => m.module === 'log_forward')?.silent;
  return state.modules.map((m) => {
    if (m.module !== 'log_forward' || !role) return m;
    const checked: SetupCheck = { ...m, role };
    const why = m.state === 'ok' ? silentReason({ ...host, setup: { ...state, modules: [{ ...checked, silent: wasSilent }] } }, role) : null;
    return why ? { ...checked, state: 'drift' as const, detail: why, silent: true } : checked;
  });
}

export function checkAllHosts() {
  return hosts
    .find({ capabilities: 'setup' }, { projection: { _id: 1 } })
    .toArray()
    .then((list) => Promise.allSettled(list.map((h) => checkHostSetup(h._id))));
}

// Applies the values of a host, all its managed options or only some of them (bulk application).
export async function applySetup(host: HostDoc, trigger: JobDoc['trigger'], only?: SetupOption[]) {
  const p = await loadSetupProfile();
  return createJob(host, 'setup_apply', [], trigger, { setup: buildSpec(p, host.setupOverrides, only, await specContext(host)) });
}

// Bulk standardisation: the chosen options go back to the standard on the host (its own values are
// dropped), then they are applied.
const withoutOverrides = (host: HostDoc, options: SetupOption[]) => {
  const overrides = { ...host.setupOverrides } as Record<string, unknown>;
  for (const k of options) delete overrides[k];
  return overrides as SetupOverrides;
};

// Error message when the host values once reset would be refused (SSH lock-out), null otherwise.
export const resetError = (p: SetupProfile, host: HostDoc, options: SetupOption[]) => {
  const err = overridesError(p, withoutOverrides(host, options));
  return err && `${host.name} : ${err}`;
};

export async function resetAndApplySetup(p: SetupProfile, host: HostDoc, options: SetupOption[]) {
  const updated = (await hosts.findOneAndUpdate({ _id: host._id }, { $set: { setupOverrides: withoutOverrides(host, options) } }, { returnDocument: 'after' }))!;
  publish('host', hostDto(updated));
  return createJob(updated, 'setup_apply', [], 'manual', { setup: buildSpec(p, updated.setupOverrides, options, await specContext(updated)) });
}

// First connection of a new host: standard configuration if the profile says so, conformity otherwise.
export async function onAgentHello(hostId: ObjectId) {
  const host = await hosts.findOne({ _id: hostId });
  if (!host || !canSetup(host)) return;
  if (host.setupPending) {
    await hosts.updateOne({ _id: hostId }, { $unset: { setupPending: '' } });
    const p = await loadSetupProfile();
    // nothing to apply when the host manages no option (e.g. every option switched off at its creation)
    if (p.autoApply && Object.keys(effectiveValues(p, host.setupOverrides)).length) {
      await applySetup(host, 'enroll');
      return;
    }
  }
  await checkHostSetup(hostId);
}
