import { createHash, createPublicKey, verify } from 'node:crypto';
import { SSH_KEY_RE, USER_RE } from './setup.js';
import type { AccessBundle, AccessManifest, AccessSettings } from './types.js';

// Signed access manifest (issue #312): root keys, sudo user and its keys, signed OFFLINE (tools/access-manifest.sh,
// ssh-keygen -Y sign). The hub checks the bundle when it is uploaded, to refuse junk early and to show who signed;
// the agents check it again against their own anchor, which is what protects the hosts (agent/access.go).

export const ACCESS_NAMESPACE = 'homelab-manager-access';
export const MAX_PAYLOAD = 256 * 1024;
const MAX_KEYS = 50;
const MAX_SIGNERS = 10;
// DER prefix of an Ed25519 SubjectPublicKeyInfo
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

class Reader {
  private pos = 0;
  constructor(private b: Buffer) {}
  take(n: number) {
    if (n < 0 || this.pos + n > this.b.length) throw new Error('données tronquées');
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  u8() {
    return this.take(1)[0];
  }
  u32() {
    return this.take(4).readUInt32BE(0);
  }
  str() {
    return this.take(this.u32());
  }
  get rest() {
    return this.b.length - this.pos;
  }
}

const wireString = (b: Buffer | string) => {
  const data = typeof b === 'string' ? Buffer.from(b) : b;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, data]);
};

export interface SshPub {
  type: string;
  key: Buffer;
  app?: Buffer;
  blob: Buffer;
}

export function parsePublicBlob(blob: Buffer): SshPub {
  const r = new Reader(blob);
  const type = r.str().toString();
  const key = r.str();
  let app: Buffer | undefined;
  if (type === 'sk-ssh-ed25519@openssh.com') app = r.str();
  else if (type !== 'ssh-ed25519') throw new Error(`type de clé non pris en charge : ${type} (ed25519 et sk-ed25519 seulement)`);
  if (key.length !== 32 || r.rest !== 0) throw new Error('clé publique malformée');
  return { type, key, app, blob };
}

export function parseKeyLine(line: string): SshPub {
  const f = line.trim().split(/\s+/);
  if (f.length < 2) throw new Error('clé publique malformée');
  const pub = parsePublicBlob(Buffer.from(f[1], 'base64'));
  if (pub.type !== f[0]) throw new Error('type de clé incohérent');
  return pub;
}

export const fingerprint = (blob: Buffer) => 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');

function verifySignature(pub: SshPub, signed: Buffer, sig: Buffer) {
  const r = new Reader(sig);
  const format = r.str().toString();
  const raw = r.str();
  if (format !== pub.type || raw.length !== 64) throw new Error('signature malformée');
  let msg = signed;
  if (pub.type === 'sk-ssh-ed25519@openssh.com') {
    const flags = r.u8();
    const counter = r.u32();
    // the security key must have checked the presence of its holder (touch)
    if (!(flags & 1)) throw new Error('clé de sécurité : toucher (présence) absent');
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    msg = Buffer.concat([createHash('sha256').update(pub.app!).digest(), Buffer.from([flags]), c, createHash('sha256').update(signed).digest()]);
  }
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, pub.key]), format: 'der', type: 'spki' });
  if (!verify(null, msg, key, raw)) throw new Error('signature invalide');
}

// Signer of an armored SSHSIG over message, once the signature is checked.
export function verifySshsig(armored: string, message: Buffer): SshPub {
  const body = armored
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('-----'))
    .join('');
  const raw = Buffer.from(body, 'base64');
  if (raw.subarray(0, 6).toString() !== 'SSHSIG') throw new Error('signature malformée');
  const r = new Reader(raw.subarray(6));
  if (r.u32() !== 1) throw new Error('version de signature non prise en charge');
  const pubBlob = r.str();
  const ns = r.str();
  const reserved = r.str();
  const hashAlg = r.str().toString();
  const sig = r.str();
  if (r.rest !== 0) throw new Error('signature malformée');
  if (ns.toString() !== ACCESS_NAMESPACE) throw new Error('signature faite pour un autre usage (espace de noms)');
  if (hashAlg !== 'sha256' && hashAlg !== 'sha512') throw new Error('algorithme de hachage non pris en charge');
  const digest = createHash(hashAlg).update(message).digest();
  const signed = Buffer.concat([Buffer.from('SSHSIG'), wireString(ns), wireString(reserved), wireString(hashAlg), wireString(digest)]);
  const pub = parsePublicBlob(pubBlob);
  verifySignature(pub, signed, sig);
  return pub;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function keyList(v: unknown, who: string) {
  if (!Array.isArray(v) || v.length > MAX_KEYS || v.some((k) => typeof k !== 'string' || !SSH_KEY_RE.test(k))) {
    throw new Error(`${who} : clés SSH invalides (${MAX_KEYS} au plus)`);
  }
  return v as string[];
}

// Same rules as validateManifest in agent/access.go.
export function parseManifest(payload: Buffer): AccessManifest {
  let m: unknown;
  try {
    m = JSON.parse(payload.toString());
  } catch {
    throw new Error('manifeste illisible (JSON)');
  }
  if (!isObject(m)) throw new Error('manifeste illisible');
  const allowed = ['v', 'serial', 'issuedAt', 'expiresAt', 'signers', 'root', 'user'];
  const extra = Object.keys(m).find((k) => !allowed.includes(k));
  if (extra) throw new Error(`champ inconnu : ${extra}`);
  if (m.v !== 1) throw new Error('version de manifeste non prise en charge');
  if (!Number.isInteger(m.serial) || (m.serial as number) < 1) throw new Error('numéro de série invalide');
  if (!Number.isInteger(m.issuedAt)) throw new Error("date d'émission invalide");
  if (m.expiresAt !== undefined && !Number.isInteger(m.expiresAt)) throw new Error("date d'expiration invalide");
  if (!Array.isArray(m.signers) || !m.signers.length || m.signers.length > MAX_SIGNERS) throw new Error('signataires : 1 à 10 clés');
  for (const s of m.signers) {
    if (typeof s !== 'string') throw new Error('signataire invalide');
    parseKeyLine(s);
  }
  if (!isObject(m.root)) throw new Error('root manquant');
  const out: AccessManifest = {
    v: 1,
    serial: m.serial as number,
    issuedAt: m.issuedAt as number,
    ...(m.expiresAt !== undefined ? { expiresAt: m.expiresAt as number } : {}),
    signers: m.signers as string[],
    root: { sshKeys: keyList(m.root.sshKeys ?? [], 'root') },
  };
  if (m.user !== undefined) {
    const u = m.user;
    if (!isObject(u) || typeof u.name !== 'string' || !USER_RE.test(u.name) || u.name === 'root') throw new Error("nom d'utilisateur invalide (minuscules, chiffres, _ et -, pas root)");
    out.user = { name: u.name, sudoNoPassword: u.sudoNoPassword === true, sshKeys: keyList(u.sshKeys ?? [], 'utilisateur') };
  }
  return out;
}

// Checks an uploaded bundle: well formed, signed, by a key the manifest itself lists. The hosts decide
// whether this signer is theirs.
export function checkBundle(b: AccessBundle) {
  if (b.payload.length > MAX_PAYLOAD * 2) throw new Error('manifeste trop gros');
  const payload = Buffer.from(b.payload, 'base64');
  if (!payload.length || payload.length > MAX_PAYLOAD) throw new Error('manifeste illisible');
  const manifest = parseManifest(payload);
  const signer = verifySshsig(b.signature, payload);
  if (!manifest.signers.some((s) => parseKeyLine(s).blob.equals(signer.blob))) throw new Error('la clé de signature doit figurer parmi les signataires du manifeste');
  return { manifest, signer: fingerprint(signer.blob) };
}

// SHA256 fingerprint of any authorized_keys line (the types the agent cannot sign with included).
export function lineFingerprint(line: string) {
  const blob = Buffer.from(line.trim().split(/\s+/)[1] ?? '', 'base64');
  return blob.length ? fingerprint(blob) : '';
}

const describeKey = (line: string) => ({ type: line.trim().split(/\s+/)[0], fingerprint: lineFingerprint(line), comment: line.trim().split(/\s+/).slice(2).join(' ') });

// What the interface shows of the active manifest.
export function accessSummary(a: AccessSettings | null) {
  if (!a) return null;
  const m = a.manifest;
  return {
    serial: m.serial,
    issuedAt: m.issuedAt,
    expiresAt: m.expiresAt ?? null,
    signer: a.signer,
    signers: m.signers.map(describeKey),
    root: m.root.sshKeys.map(describeKey),
    user: m.user ? { name: m.user.name, sudoNoPassword: m.user.sudoNoPassword, keys: m.user.sshKeys.map(describeKey) } : null,
    uploadedAt: a.uploadedAt,
  };
}
