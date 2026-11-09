import { createPublicKey, type JsonWebKey } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';
import { ObjectId } from 'mongodb';
import { config } from './config.js';
import { randomToken } from './crypto.js';
import { passkeys, users } from './db.js';
import type { PasskeyDoc, UserDoc } from './types.js';

// Passkeys (WebAuthn), second factor of the logins (homelab#291). The password stays the first factor: the passkey
// is asked once it is right, for the accounts that have one. Their public key can be exported for the agents
// (homelab#306), which will check what an admin signs with it.

const RP_NAME = 'Homelab Manager';
// a challenge waits this long for the browser (the user picks the passkey in a dialog)
const CHALLENGE_MS = 5 * 60_000;
const MAX_PENDING = 1000;

export const passkeysEnabled = () => !!config.webauthnRpId;
const origins = () => (config.webauthnOrigins.length ? config.webauthnOrigins : [`https://${config.webauthnRpId}`]);

// MFA_REQUIRED applies to the admins, and only when passkeys can be registered (WEBAUTHN_RP_ID): otherwise it would
// lock them out. The superadmin (one-time password, accounts only) and the API keys are not concerned.
export function mfaRequiredFor(user: Pick<UserDoc, 'profile'>) {
  return config.mfaRequired && passkeysEnabled() && user.profile === 'admin';
}

// Challenges waiting for the browser, in memory: a restart only makes the user try again.
class Pending<T> {
  private items = new Map<string, T & { expires: number }>();
  put(key: string, value: T) {
    const now = Date.now();
    for (const [k, v] of this.items) if (v.expires < now) this.items.delete(k);
    if (this.items.size >= MAX_PENDING) this.items.delete(this.items.keys().next().value!);
    this.items.set(key, { ...value, expires: now + CHALLENGE_MS });
  }
  // single use: a challenge is dropped once read
  take(key: string): T | null {
    const v = this.items.get(key);
    this.items.delete(key);
    return v && v.expires >= Date.now() ? v : null;
  }
}

const registrations = new Pending<{ userId: string; challenge: string }>();
const logins = new Pending<{ userId: string; challenge: string }>();

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

export const userPasskeys = (userId: ObjectId) => passkeys.find({ userId }).sort({ createdAt: 1 }).toArray();

// --- registration (from a session of the account) -------------------------------------------------------------

export async function registrationOptions(user: UserDoc, sessionId: string) {
  const existing = await userPasskeys(user._id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: config.webauthnRpId!,
    userName: user.username,
    userDisplayName: user.displayName || user.username,
    userID: new Uint8Array(user._id.id),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  registrations.put(sessionId, { userId: user._id.toHexString(), challenge: options.challenge });
  return options;
}

export async function finishRegistration(user: UserDoc, sessionId: string, name: string, response: RegistrationResponseJSON) {
  const pending = registrations.take(sessionId);
  if (!pending || pending.userId !== user._id.toHexString()) return null;
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: origins(),
    expectedRPID: config.webauthnRpId!,
    // second factor after the password: presence is enough, the provider may verify the user on top
    requireUserVerification: false,
  });
  if (!result.verified) return null;
  const { credential, credentialBackedUp } = result.registrationInfo;
  const doc: PasskeyDoc = {
    _id: new ObjectId(),
    userId: user._id,
    credentialId: credential.id,
    publicKey: b64(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    name,
    backedUp: credentialBackedUp,
    createdAt: new Date(),
  };
  await passkeys.insertOne(doc);
  return doc;
}

// --- login (after the password) ---------------------------------------------------------------------------------

// null: the account logs in with its password alone (no passkey, or passkeys disabled on this hub)
export async function loginChallenge(user: UserDoc) {
  if (!passkeysEnabled()) return null;
  const list = await userPasskeys(user._id);
  if (!list.length) return null;
  const options = await generateAuthenticationOptions({
    rpID: config.webauthnRpId!,
    allowCredentials: list.map((p) => ({ id: p.credentialId, transports: p.transports })),
    userVerification: 'preferred',
  });
  const ticket = randomToken();
  logins.put(ticket, { userId: user._id.toHexString(), challenge: options.challenge });
  return { ticket, options };
}

// The account the ticket was issued for, with whether its passkey answered; null for an unknown or expired ticket.
export async function finishLogin(ticket: string, response: AuthenticationResponseJSON) {
  const pending = logins.take(ticket);
  if (!pending) return null;
  const user = await users.findOne({ _id: new ObjectId(pending.userId) });
  if (!user) return null;
  const key = await passkeys.findOne({ userId: user._id, credentialId: response.id });
  if (!key) return { user, ok: false };
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origins(),
      expectedRPID: config.webauthnRpId!,
      credential: { id: key.credentialId, publicKey: bytes(key.publicKey), counter: key.counter, transports: key.transports },
      requireUserVerification: false,
    });
    if (!result.verified) return { user, ok: false };
    await passkeys.updateOne({ _id: key._id }, { $set: { counter: result.authenticationInfo.newCounter, lastUsedAt: new Date() } });
    return { user, ok: true };
  } catch {
    // malformed response, counter gone backwards (cloned authenticator)…
    return { user, ok: false };
  }
}

// --- public key -------------------------------------------------------------------------------------------------

// The public key as PEM (SPKI), the form the agents read; null for a key type it cannot be put in (post-quantum…).
export function publicKeyPem(p: Pick<PasskeyDoc, 'publicKey'>) {
  const cose = decodeCredentialPublicKey(bytes(p.publicKey)) as unknown as Map<number, unknown>;
  const kty = cose.get(1);
  const b = (k: number) => b64(cose.get(k) as Uint8Array);
  const crvs: Record<number, string> = { 1: 'P-256', 2: 'P-384', 3: 'P-521', 6: 'Ed25519' };
  let jwk: JsonWebKey;
  if (kty === 2) jwk = { kty: 'EC', crv: crvs[cose.get(-1) as number], x: b(-2), y: b(-3) };
  else if (kty === 1) jwk = { kty: 'OKP', crv: crvs[cose.get(-1) as number], x: b(-2) };
  else if (kty === 3) jwk = { kty: 'RSA', n: b(-1), e: b(-2) };
  else return null;
  try {
    return createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    return null;
  }
}

export function passkeyDto(p: PasskeyDoc) {
  return {
    id: p._id.toHexString(),
    name: p.name,
    backedUp: p.backedUp,
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt ?? null,
    credentialId: p.credentialId,
    publicKeyPem: publicKeyPem(p),
  };
}
