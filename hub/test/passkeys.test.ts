import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { ObjectId } from 'mongodb';
import { mfaRequiredFor, passkeysEnabled, REAUTH_MS, reauthNeeded } from '../src/passkeys.js';
import { createPki } from '../src/pki.js';

// @simplewebauthn/server brings @peculiar/x509 too: two versions side by side share the global container of tsyringe
// and break the certificates of the hub (package.json overrides keep a single one)
test('the PKI of the hub is still created with the WebAuthn library loaded', async () => {
  const pki = await createPki();
  assert.match(pki.caCert, /BEGIN CERTIFICATE/);
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

test('a proof of the session younger than REAUTH_MS covers the sensitive actions', async () => {
  const saved = config.webauthnRpId;
  try {
    const user = { _id: new ObjectId() };
    const now = Date.now();
    config.webauthnRpId = undefined;
    assert.equal(await reauthNeeded(user, undefined, now), false, 'no passkey on this hub: nothing to prove');
    config.webauthnRpId = 'hub.example.org';
    assert.equal(await reauthNeeded(user, new Date(now - REAUTH_MS), now), false);
  } finally {
    config.webauthnRpId = saved;
  }
});
