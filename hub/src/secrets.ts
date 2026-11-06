import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Secrets stored in MongoDB, sealed with a master key kept outside the database (F-04): the keys of the authority of
// the agents, the tokens of the servers (PBS, PVE, Omada) and the password of the MQTT broker. A dump or a backup of
// the database gives none of them without the key.
//
//   HM_MASTER_KEY        32 random bytes in base64 (openssl rand -base64 32), or
//   HM_MASTER_KEY_FILE   a file that holds it (Docker secret)
//
// Optional: without a key, the secrets are stored in clear as before (a warning at start). A sealed value reads
// hmenc:v1:<iv>:<ciphertext>:<tag> (base64, AES-256-GCM); its associated data names where it is stored, so that it
// cannot be copied to another field. A value without the prefix is read as clear text: the migration seals it.

const PREFIX = 'hmenc:v1:';

export class MasterKeyError extends Error {}

function parseKey(raw: string, from: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) throw new MasterKeyError(`${from} : 32 octets en base64 attendus (openssl rand -base64 32), ${key.length} lus`);
  return key;
}

// the key of the process; tests set it with setMasterKey
let masterKey: Buffer | null | undefined;

export function loadMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const direct = env.HM_MASTER_KEY?.trim();
  if (direct) return parseKey(direct, 'HM_MASTER_KEY');
  const file = env.HM_MASTER_KEY_FILE?.trim();
  if (file) return parseKey(readFileSync(file, 'utf8'), `HM_MASTER_KEY_FILE (${file})`);
  return null;
}

function key(): Buffer | null {
  if (masterKey === undefined) masterKey = loadMasterKey();
  return masterKey;
}

export function setMasterKey(k: Buffer | null) {
  masterKey = k;
}

export const hasMasterKey = () => !!key();
export const isSealed = (v: unknown): v is string => typeof v === 'string' && v.startsWith(PREFIX);

// Sealed with the master key; as is without key, or when empty (nothing to protect) or already sealed.
export function seal(plain: string, aad: string): string {
  const k = key();
  if (!k || !plain || isSealed(plain)) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${PREFIX}${iv.toString('base64')}:${data.toString('base64')}:${c.getAuthTag().toString('base64')}`;
}

// Clear text of a stored value (a clear value is returned as is). Throws when it is sealed and the key is missing or
// another one, or the value was moved: never a silent empty secret.
export function open(value: string, aad: string): string;
export function open(value: string | undefined, aad: string): string | undefined;
export function open(value: string | undefined, aad: string): string | undefined {
  if (!isSealed(value)) return value;
  const k = key();
  if (!k) throw new MasterKeyError(`secret chiffré (${aad}) mais HM_MASTER_KEY absente : renseigner la clé maître du hub`);
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new MasterKeyError(`secret chiffré illisible (${aad})`);
  const [iv, data, tag] = parts.map((p) => Buffer.from(p, 'base64'));
  try {
    const d = createDecipheriv('aes-256-gcm', k, iv);
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    throw new MasterKeyError(`secret chiffré (${aad}) illisible avec cette HM_MASTER_KEY : ce n'est pas la clé qui l'a chiffré`);
  }
}

// The fields of an object, opened (or sealed) in place on a copy; paths are top-level keys.
export function openFields<T extends object>(o: T, fields: readonly string[], aad: (field: string) => string): T {
  const out = { ...o } as Record<string, unknown>;
  for (const f of fields) if (typeof out[f] === 'string') out[f] = open(out[f] as string, aad(f));
  return out as T;
}
