import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { mfaRequiredFor, passkeysEnabled, publicKeyPem } from '../src/passkeys.js';

// COSE_Key of an ES256 key (RFC 9053): {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
function coseEs256(x: Buffer, y: Buffer) {
  const bstr = (b: Buffer) => Buffer.concat([Buffer.from([0x58, b.length]), b]);
  return Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]), bstr(x), Buffer.from([0x22]), bstr(y)]);
}

test('the public key of a passkey is exported as PEM (SPKI), the form the agents read', () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = coseEs256(Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url'));
  assert.equal(publicKeyPem({ publicKey: cose.toString('base64url') }), publicKey.export({ type: 'spki', format: 'pem' }).toString());
});

test('MFA_REQUIRED applies to the admins only, and only when passkeys can be registered', () => {
  const saved = { rpId: config.webauthnRpId, required: config.mfaRequired };
  try {
    config.mfaRequired = true;
    config.webauthnRpId = undefined;
    assert.equal(passkeysEnabled(), false);
    assert.equal(mfaRequiredFor({ profile: 'admin' }), false, 'no WEBAUTHN_RP_ID: the admins are not locked out');
    config.webauthnRpId = 'hub.example.org';
    assert.equal(mfaRequiredFor({ profile: 'admin' }), true);
    assert.equal(mfaRequiredFor({ profile: 'operator' }), false);
    assert.equal(mfaRequiredFor({ profile: 'superadmin' }), false);
    config.mfaRequired = false;
    assert.equal(mfaRequiredFor({ profile: 'admin' }), false);
  } finally {
    config.webauthnRpId = saved.rpId;
    config.mfaRequired = saved.required;
  }
});
