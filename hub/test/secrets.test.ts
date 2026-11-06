import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { isSealed, loadMasterKey, MasterKeyError, open, seal, setMasterKey } from '../src/secrets.js';
import { credentialAad, openCredential, openRole, openSettings } from '../src/storedSecrets.js';
import type { RoleDoc } from '../src/types.js';

const key = randomBytes(32);

test('sealed with the master key, opened back; clear text is read as is', (t) => {
  t.after(() => setMasterKey(null));
  setMasterKey(key);
  const s = seal('secret-1', 'settings/pbs/tokenSecret');
  assert.ok(isSealed(s) && !s.includes('secret-1'));
  assert.notEqual(seal('secret-1', 'settings/pbs/tokenSecret'), s); // random IV
  assert.equal(open(s, 'settings/pbs/tokenSecret'), 'secret-1');
  assert.equal(open('clear', 'settings/pbs/tokenSecret'), 'clear');
  assert.equal(seal('', 'x'), '');
  assert.equal(seal(s, 'settings/pbs/tokenSecret'), s); // not sealed twice
});

test('a sealed secret is never opened elsewhere, with another key or without key', (t) => {
  t.after(() => setMasterKey(null));
  setMasterKey(key);
  const s = seal('secret-1', 'settings/pbs/tokenSecret');
  assert.throws(() => open(s, 'settings/pbs-remote/tokenSecret'), MasterKeyError);
  assert.throws(() => open(s.replace(/:[^:]+$/, ':AAAA'), 'settings/pbs/tokenSecret'), MasterKeyError);
  setMasterKey(randomBytes(32));
  assert.throws(() => open(s, 'settings/pbs/tokenSecret'), /pas la clé/);
  setMasterKey(null);
  assert.throws(() => open(s, 'settings/pbs/tokenSecret'), /HM_MASTER_KEY absente/);
  assert.equal(seal('secret-1', 'x'), 'secret-1'); // without key: clear, as before
});

test('master key: HM_MASTER_KEY or HM_MASTER_KEY_FILE, 32 bytes', () => {
  assert.equal(loadMasterKey({}), null);
  assert.deepEqual(loadMasterKey({ HM_MASTER_KEY: key.toString('base64') }), key);
  assert.throws(() => loadMasterKey({ HM_MASTER_KEY: 'c2hvcnQ=' }), /32 octets/);
});

test('the loaders open the stored documents', (t) => {
  t.after(() => setMasterKey(null));
  setMasterKey(key);
  const pbs = openSettings('pbs', { url: 'https://pbs:8007', tokenSecret: seal('s', 'settings/pbs/tokenSecret') });
  assert.equal(pbs!.tokenSecret, 's');
  assert.equal(openSettings('pbs', null), null);
  const role = { _id: 'r1', type: 'mqtt-broker', config: { password: seal('p', 'roles/r1/config.password'), username: 'u' } } as unknown as RoleDoc;
  assert.equal((openRole(role).config as { password: string }).password, 'p');
  // a role moved to another id is not readable
  assert.throws(() => openRole({ ...role, _id: 'r2' } as RoleDoc), MasterKeyError);
  const c = { tokenId: 'host-a@pbs!backup', tokenSecret: seal('t', credentialAad('host-a@pbs!backup')) };
  assert.equal(openCredential(c).tokenSecret, 't');
  assert.throws(() => openCredential({ ...c, tokenId: 'host-b@pbs!backup' }), MasterKeyError);
  assert.equal(openCredential(undefined), undefined);
});
