import { randomBytes } from 'node:crypto';
import { dynsecRun, type DynsecCommand, type DynsecResponse } from './dynsecClient.js';
import { adminBrokerOf, DYNSEC_ACCOUNT, DynsecError } from './mqttDynsec.js';
import type { MqttBrokerRole } from './types.js';

// The accounts of a broker whose dynamic-security the hub runs (mqttDynsec.ts): list with their connection state, create,
// change the password, delete. A new account gets the role FULL_ROLE (every topic): an account without role may neither
// publish nor subscribe, which would break the device the administrator is creating it for. Rights per topic come later.

export const ACCOUNT_RE = /^[A-Za-z0-9._@-]{1,64}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const FULL_ROLE = 'hlm-full';
const ACLS = ['publishClientSend', 'publishClientReceive', 'subscribePattern', 'unsubscribePattern'];

export interface Account {
  username: string;
  connected: boolean;
  connections: number;
  roles: string[];
  // the account of the hub itself: shown, never changed
  protected: boolean;
}

async function broker(role: MqttBrokerRole) {
  if (!role.config.dynsec) throw new DynsecError("la gestion des comptes n'est pas activée par le hub sur ce rôle");
  const b = await adminBrokerOf(role);
  if (!b) throw new DynsecError('adresse du broker inconnue (hôte sans adresse)');
  return b;
}

async function run(role: MqttBrokerRole, commands: DynsecCommand[]) {
  try {
    return await dynsecRun(await broker(role), commands);
  } catch (err) {
    if (err instanceof DynsecError) throw err;
    throw new DynsecError((err as Error).message, 502);
  }
}

// the plugin's messages, in the words of the UI
const MESSAGES: Record<string, string> = { 'Client already exists': 'ce compte existe déjà', 'Client not found': 'compte inconnu' };
const errorOf = (r: DynsecResponse | undefined) => (r?.error ? (MESSAGES[r.error] ?? r.error) : null);

export async function listAccounts(role: MqttBrokerRole): Promise<Account[]> {
  const [r] = await run(role, [{ command: 'listClients', verbose: true }]);
  if (errorOf(r)) throw new DynsecError(errorOf(r)!, 502);
  const clients = (r.data?.clients ?? []) as { username: string; roles?: { rolename: string }[]; connections?: unknown[] }[];
  return clients
    .map((c) => ({ username: c.username, connected: !!c.connections?.length, connections: c.connections?.length ?? 0, roles: (c.roles ?? []).map((x) => x.rolename), protected: c.username === DYNSEC_ACCOUNT }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

export const generatePassword = () => randomBytes(18).toString('base64url');

export function checkPassword(p: string | undefined) {
  if (p === undefined || p === '') return generatePassword();
  if (p.length < PASSWORD_MIN || p.length > PASSWORD_MAX) throw new DynsecError(`mot de passe : ${PASSWORD_MIN} à ${PASSWORD_MAX} caractères`, 400);
  return p;
}

export function checkName(username: string) {
  if (!ACCOUNT_RE.test(username)) throw new DynsecError('nom de compte : lettres, chiffres, . _ @ - (64 au plus)', 400);
  if (username === DYNSEC_ACCOUNT) throw new DynsecError('ce compte est celui du hub', 409);
}

/** password: generated when absent; returned so that it can be shown once. */
export async function createAccount(role: MqttBrokerRole, username: string, password?: string) {
  checkName(username);
  const pw = checkPassword(password);
  // the role exists or is made: its "already exists" is not an error
  const base: DynsecCommand[] = [{ command: 'createRole', rolename: FULL_ROLE }, ...ACLS.map((acltype) => ({ command: 'addRoleACL', rolename: FULL_ROLE, acltype, topic: '#', allow: true, priority: 5 }))];
  await run(role, base);
  const rs = await run(role, [
    { command: 'createClient', username, password: pw },
    { command: 'addClientRole', username, rolename: FULL_ROLE, priority: 5 },
  ]);
  const bad = rs.map(errorOf).find(Boolean);
  if (bad) throw new DynsecError(bad, 409);
  return { username, password: pw };
}

export async function setAccountPassword(role: MqttBrokerRole, username: string, password?: string) {
  checkName(username);
  const pw = checkPassword(password);
  const [r] = await run(role, [{ command: 'setClientPassword', username, password: pw }]);
  if (errorOf(r)) throw new DynsecError(errorOf(r)!, 409);
  return { username, password: pw };
}

export async function deleteAccount(role: MqttBrokerRole, username: string) {
  checkName(username);
  const [r] = await run(role, [{ command: 'deleteClient', username }]);
  if (errorOf(r)) throw new DynsecError(errorOf(r)!, 409);
}

// Anonymous clients: dynamic-security gives them the rights of the group set with setAnonymousGroup. They are accepted
// while that group holds the role LEGACY_ROLE (every topic); without it they still connect but may neither publish nor
// subscribe. Changed on the fly, no restart.
export const LEGACY_ROLE = 'legacy';
export const ANONYMOUS_GROUP = 'anonymous';

export async function getAnonymousAllowed(role: MqttBrokerRole) {
  const [r] = await run(role, [{ command: 'getGroup', groupname: ANONYMOUS_GROUP }]);
  if (r?.error) return false;
  const roles = ((r.data?.group as { roles?: { rolename: string }[] } | undefined)?.roles ?? []).map((x) => x.rolename);
  return roles.includes(LEGACY_ROLE);
}

export async function setAnonymousAllowed(role: MqttBrokerRole, allowed: boolean) {
  const commands: DynsecCommand[] = allowed
    ? [
        // made again when missing: the answers "already exists" are not errors
        { command: 'createRole', rolename: LEGACY_ROLE },
        ...ACLS.map((acltype) => ({ command: 'addRoleACL', rolename: LEGACY_ROLE, acltype, topic: '#', allow: true, priority: 5 })),
        { command: 'createGroup', groupname: ANONYMOUS_GROUP },
        { command: 'setAnonymousGroup', groupname: ANONYMOUS_GROUP },
        { command: 'addGroupRole', groupname: ANONYMOUS_GROUP, rolename: LEGACY_ROLE, priority: 5 },
      ]
    : [{ command: 'removeGroupRole', groupname: ANONYMOUS_GROUP, rolename: LEGACY_ROLE }];
  await run(role, commands);
  const now = await getAnonymousAllowed(role);
  if (now !== allowed) throw new DynsecError("le broker n'a pas pris le changement en compte", 502);
  return now;
}

export async function accountExists(role: MqttBrokerRole, username: string) {
  const [r] = await run(role, [{ command: 'getClient', username }]);
  return !r?.error;
}

// The account a managed role connects with (probes, Home Assistant bridge), typed or generated in the dialog of the role:
// made on the broker when it does not exist, else its password changed. The role itself is written by its route.
// keep: the password was not typed (the one stored in the role): an existing account is left as it is (it may be shared
// with devices), only a missing one is made.
export async function syncAccount(role: MqttBrokerRole, username: string, password: string, keep = false) {
  if (keep && (await accountExists(role, username))) return undefined;
  try {
    await createAccount(role, username, password);
    return 'created' as const;
  } catch (err) {
    if (!(err instanceof DynsecError) || err.message !== 'ce compte existe déjà') throw err;
    await setAccountPassword(role, username, password);
    return 'password' as const;
  }
}
