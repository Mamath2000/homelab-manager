import type { FastifyBaseLogger } from 'fastify';
import { backupJobs, hosts, roles, settings } from './db.js';
import { hasMasterKey, isSealed, MasterKeyError, open, openFields, seal } from './secrets.js';
import type { RoleDoc } from './types.js';

// Where the hub stores secrets, sealed with the master key (secrets.ts). The loaders open them; the writes store
// them as they come and resealSoon seals what is left in clear (as the migration at start does), so that no write
// path has to know about the key.

// settings documents: their secret fields (the legacy pve document is only read once, to become roles)
export const SETTINGS_SECRETS = {
  pki: ['caKey', 'serverKey'],
  uiTls: ['key'],
  pbs: ['tokenSecret'],
  'pbs-remote': ['tokenSecret', 'readerTokenSecret'],
  homeassistant: ['password'],
} as const satisfies Record<string, readonly string[]>;
type SettingsId = keyof typeof SETTINGS_SECRETS;

// declared roles: the secrets of their config
export const ROLE_SECRETS: Partial<Record<RoleDoc['type'], readonly string[]>> = {
  'mqtt-broker': ['password', 'clientKeyPem'],
  'omada-controller': ['clientSecret'],
  'pve-cluster': ['tokenSecret'],
};

const settingsAad = (id: string) => (f: string) => `settings/${id}/${f}`;
const roleAad = (id: string, f: string) => `roles/${id}/config.${f}`;
// the PBS token of a host: bound to its id, unique to the host
export const credentialAad = (tokenId: string) => `hosts/pbsCredential/${tokenId}`;
export const databasePasswordAad = (id: { toString(): string }) => `backupJobs/${id.toString()}/database.password`;

// a secret read in clear while there is a key: written since the last sealing, sealed in a second
const noteClear = (o: object, fields: readonly string[]) => {
  if (hasMasterKey() && fields.some((f) => clear((o as Record<string, unknown>)[f]))) resealSoon();
};

export function openSettings<T extends object>(id: SettingsId, doc: T | null): T | null {
  if (!doc) return doc;
  noteClear(doc, SETTINGS_SECRETS[id]);
  return openFields(doc, SETTINGS_SECRETS[id], settingsAad(id));
}

export function openRole<R extends RoleDoc>(r: R): R {
  const f = ROLE_SECRETS[r.type];
  if (!f || !r.config) return r;
  noteClear(r.config as object, f);
  return { ...r, config: openFields(r.config as object, f, (x) => roleAad(String(r._id), x)) } as R;
}

export function openCredential<C extends { tokenId: string; tokenSecret: string }>(c: C): C;
export function openCredential<C extends { tokenId: string; tokenSecret: string }>(c: C | null | undefined): C | null | undefined;
export function openCredential<C extends { tokenId: string; tokenSecret: string }>(c: C | null | undefined) {
  if (c) noteClear(c, ['tokenSecret']);
  return c && { ...c, tokenSecret: open(c.tokenSecret, credentialAad(c.tokenId)) };
}

const clear = (v: unknown): v is string => typeof v === 'string' && v !== '' && !isSealed(v);
const SEALED = /^hmenc:v1:/;

// Seals every secret still stored in clear; each update only applies to the value it read (idempotent, safe with a
// concurrent write). Nothing without master key. Returns how many were sealed.
export async function sealStored(): Promise<number> {
  if (!hasMasterKey()) return 0;
  let n = 0;
  for (const [id, fields] of Object.entries(SETTINGS_SECRETS)) {
    const doc = (await settings.findOne({ _id: id } as never)) as Record<string, unknown> | null;
    if (!doc) continue;
    for (const f of fields) {
      const v = doc[f];
      if (!clear(v)) continue;
      const r = await settings.updateOne({ _id: id, [f]: v } as never, { $set: { [f]: seal(v, settingsAad(id)(f)) } });
      n += r.modifiedCount;
    }
  }
  for (const r of await roles.find({ type: { $in: Object.keys(ROLE_SECRETS) } } as never).toArray()) {
    for (const f of ROLE_SECRETS[r.type as RoleDoc['type']]!) {
      const v = (r.config as unknown as Record<string, unknown> | undefined)?.[f];
      if (!clear(v)) continue;
      const res = await roles.updateOne({ _id: r._id, [`config.${f}`]: v } as never, { $set: { [`config.${f}`]: seal(v, roleAad(String(r._id), f)) } });
      n += res.modifiedCount;
    }
  }
  const list = await hosts.find({ 'pbsCredential.tokenSecret': { $type: 'string', $not: SEALED } }, { projection: { pbsCredential: 1 } }).toArray();
  for (const h of list) {
    const c = h.pbsCredential!;
    if (!clear(c.tokenSecret)) continue;
    const res = await hosts.updateOne({ _id: h._id, 'pbsCredential.tokenSecret': c.tokenSecret }, { $set: { 'pbsCredential.tokenSecret': seal(c.tokenSecret, credentialAad(c.tokenId)) } });
    n += res.modifiedCount;
  }
  for (const j of await backupJobs.find({ 'database.password': { $type: 'string', $not: SEALED } }, { projection: { database: 1 } }).toArray()) {
    const v = j.database?.password;
    if (!clear(v)) continue;
    const res = await backupJobs.updateOne({ _id: j._id, 'database.password': v }, { $set: { 'database.password': seal(v, databasePasswordAad(j._id)) } });
    n += res.modifiedCount;
  }
  for (const h of await hosts.find({ 'backupCache.jobs.database.password': { $type: 'string', $not: SEALED } }, { projection: { backupCache: 1 } }).toArray()) {
    for (const j of h.backupCache?.jobs ?? []) {
      const v = j.database?.password;
      if (!clear(v)) continue;
      const res = await hosts.updateOne(
        { _id: h._id },
        { $set: { 'backupCache.jobs.$[job].database.password': seal(v, databasePasswordAad(j._id)) } },
        { arrayFilters: [{ 'job._id': j._id, 'job.database.password': v }] },
      );
      n += res.modifiedCount;
    }
  }
  return n;
}

// Whether a sealed secret is stored (a hub started without its key must not run on them).
export async function anySealed(): Promise<boolean> {
  for (const [id, fields] of Object.entries(SETTINGS_SECRETS)) {
    if (await settings.findOne({ _id: id, $or: fields.map((f) => ({ [f]: SEALED })) } as never, { projection: { _id: 1 } })) return true;
  }
  const roleQuery = Object.entries(ROLE_SECRETS).flatMap(([type, fields]) => fields.map((f) => ({ type, [`config.${f}`]: SEALED })));
  if (await roles.findOne({ $or: roleQuery } as never, { projection: { _id: 1 } })) return true;
  if (await hosts.findOne({ 'pbsCredential.tokenSecret': SEALED }, { projection: { _id: 1 } })) return true;
  if (await backupJobs.findOne({ 'database.password': SEALED }, { projection: { _id: 1 } })) return true;
  return !!(await hosts.findOne({ 'backupCache.jobs.database.password': SEALED }, { projection: { _id: 1 } }));
}

// Opens every stored secret: throws (MasterKeyError) when one is not readable with this key.
export async function openAllStored() {
  for (const id of Object.keys(SETTINGS_SECRETS) as SettingsId[]) openSettings(id, (await settings.findOne({ _id: id } as never)) as object | null);
  for (const r of await roles.find({ type: { $in: Object.keys(ROLE_SECRETS) } } as never).toArray()) openRole(r as RoleDoc);
  for (const h of await hosts.find({ 'pbsCredential.tokenSecret': SEALED }, { projection: { pbsCredential: 1 } }).toArray()) openCredential(h.pbsCredential);
  for (const j of await backupJobs.find({ 'database.password': SEALED }, { projection: { database: 1 } }).toArray()) {
    open(j.database!.password!, databasePasswordAad(j._id));
  }
  for (const h of await hosts.find({ 'backupCache.jobs.database.password': SEALED }, { projection: { backupCache: 1 } }).toArray()) {
    for (const j of h.backupCache?.jobs ?? []) {
      if (j.database?.password && isSealed(j.database.password)) open(j.database.password, databasePasswordAad(j._id));
    }
  }
}

let log: FastifyBaseLogger | null = null;
let timer: NodeJS.Timeout | null = null;

// After a write of a secret: sealed within a second (the write stores what it was given).
export function resealSoon() {
  if (!hasMasterKey() || timer) return;
  timer = setTimeout(() => {
    timer = null;
    sealStored().catch((err) => log?.error({ err }, 'secrets: sealing failed'));
  }, 1000);
  timer.unref();
}

// At start, before anything reads a secret: refuses to run on sealed secrets without the key (and never creates a
// new authority then), seals what is in clear with a key, warns without.
export async function prepareStoredSecrets(logger: FastifyBaseLogger) {
  log = logger;
  if (!hasMasterKey()) {
    if (await anySealed()) throw new MasterKeyError('des secrets de la base sont chiffrés mais HM_MASTER_KEY est absente : le hub ne démarre pas sans sa clé maître');
    logger.warn('secrets: no HM_MASTER_KEY, the secrets are stored in clear in MongoDB (see docs/securite.md)');
    return;
  }
  // another key than the one that sealed them: refused before anything is sealed with it
  await openAllStored();
  const n = await sealStored();
  if (n) logger.info({ sealed: n }, 'secrets: stored secrets sealed with the master key');
}
