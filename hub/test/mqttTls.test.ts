import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { before, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { settingsDiff } from '../src/audit.js';
import { PEM_MAX, tlsError, tlsKey, tlsOf, tlsOptions } from '../src/mqttTls.js';
import { createPki, signClientKey } from '../src/pki.js';
import { roleView } from '../src/roleView.js';
import { configError, toConfig, withStoredKey } from '../src/routes/roles.js';
import type { MqttBrokerRole } from '../src/types.js';

let caPem: string;
let certPem: string;
let keyPem: string;
let otherKeyPem: string;

const keypair = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });

before(async () => {
  const pki = await createPki();
  caPem = pki.caCert;
  const { publicKey, privateKey } = keypair();
  keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  otherKeyPem = keypair().privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  certPem = (await signClientKey(pki, publicKey.export({ type: 'spki', format: 'der' }), 'hlm')).certPem;
});

test('tls: nothing typed is fine on any scheme, material needs a TLS scheme', () => {
  assert.equal(tlsError({}, 'mqtt'), null);
  assert.equal(tlsError({ caPem: '  ' }, 'mqtt'), null);
  assert.ok(tlsError({ caPem }, 'mqtt'));
  assert.ok(tlsError({ caPem }, 'ws'));
  assert.equal(tlsError({ caPem }, 'mqtts'), null);
  assert.equal(tlsError({ caPem }, 'wss'), null);
});

test('tls: the certificate and its key go together and must match', () => {
  assert.equal(tlsError({ caPem, clientCertPem: certPem, clientKeyPem: keyPem }, 'mqtts'), null);
  assert.equal(tlsError({ clientCertPem: certPem }, 'mqtts'), 'certificat client et clé privée vont ensemble');
  assert.equal(tlsError({ clientKeyPem: keyPem }, 'mqtts'), 'certificat client et clé privée vont ensemble');
  assert.equal(tlsError({ clientCertPem: certPem, clientKeyPem: otherKeyPem }, 'mqtts'), 'la clé privée ne correspond pas au certificat client');
});

test('tls: garbage, other formats and oversized values are refused', () => {
  assert.equal(tlsError({ caPem: 'not a certificate' }, 'mqtts'), 'autorité (CA) : format PEM attendu');
  assert.equal(tlsError({ caPem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----' }, 'mqtts'), 'autorité (CA) : certificat illisible');
  assert.equal(tlsError({ caPem: 'x'.repeat(PEM_MAX + 1) }, 'mqtts'), 'autorité (CA) : trop long');
  assert.equal(tlsError({ clientCertPem: certPem, clientKeyPem: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' }, 'mqtts'), 'certificat client ou clé privée illisible');
});

test('tls: options of the client, the server certificate is never left unchecked', () => {
  assert.deepEqual(tlsOptions(undefined), {});
  assert.deepEqual(tlsOptions({ caPem }), { ca: caPem });
  // a certificate without its key is not presented
  assert.deepEqual(tlsOptions({ clientCertPem: certPem }), {});
  const o = tlsOptions({ caPem, clientCertPem: certPem, clientKeyPem: keyPem });
  assert.deepEqual(o, { ca: caPem, cert: certPem, key: keyPem });
  assert.equal('rejectUnauthorized' in o, false);
});

test('tls: the key of a connection tells a change, without holding the secret', () => {
  assert.equal(tlsKey(undefined), '');
  const a = tlsKey({ caPem, clientCertPem: certPem, clientKeyPem: keyPem });
  assert.notEqual(a, tlsKey({ caPem, clientCertPem: certPem, clientKeyPem: otherKeyPem }));
  assert.equal(a, tlsKey({ caPem, clientCertPem: certPem, clientKeyPem: keyPem }));
  assert.equal(a.includes('PRIVATE'), false);
  assert.equal(tlsOf({}), undefined);
  assert.deepEqual(tlsOf({ caPem }), { caPem });
});

test('roles: mqtt-broker config takes the TLS fields, checked with the scheme', () => {
  const base = { port: 8883, username: '' };
  assert.equal(configError('mqtt-broker', { ...base, scheme: 'mqtts', caPem, clientCertPem: certPem, clientKeyPem: keyPem }), null);
  assert.ok(configError('mqtt-broker', { ...base, scheme: 'mqtt', caPem }));
  assert.ok(configError('mqtt-broker', { ...base, scheme: 'mqtts', clientCertPem: certPem }));
  const c = toConfig('mqtt-broker', { ...base, scheme: 'mqtts', caPem: `${caPem}\n`, clientCertPem: certPem, clientKeyPem: keyPem }, '');
  assert.deepEqual(c, { scheme: 'mqtts', port: 8883, username: '', password: '', caPem: caPem.trim(), clientCertPem: certPem.trim(), clientKeyPem: keyPem.trim() });
  // cleared: nothing stored
  assert.deepEqual(toConfig('mqtt-broker', { ...base, scheme: 'mqtts', caPem: '', clientCertPem: '', clientKeyPem: '' }, ''), { scheme: 'mqtts', port: 8883, username: '', password: '' });
});

const role = (config: MqttBrokerRole['config']): MqttBrokerRole => ({ _id: 'mqtt', type: 'mqtt-broker', name: 'MQTT', carrier: { kind: 'host', id: new ObjectId() }, config, createdAt: new Date() });

test('roles: an edit that sends the certificate without a key keeps the stored key', () => {
  const stored = role({ scheme: 'mqtts', port: 8883, username: '', password: '', caPem, clientCertPem: certPem, clientKeyPem: keyPem });
  const edit = { scheme: 'mqtts' as const, port: 8883, username: '', caPem, clientCertPem: certPem };
  assert.equal(withStoredKey(edit, stored).clientKeyPem, keyPem);
  // a typed key replaces it, a cleared certificate drops it, another type of role has none
  assert.equal(withStoredKey({ ...edit, clientKeyPem: otherKeyPem }, stored).clientKeyPem, otherKeyPem);
  assert.equal(withStoredKey({ ...edit, clientCertPem: '' }, stored).clientKeyPem, undefined);
  assert.equal(withStoredKey(edit, undefined).clientKeyPem, undefined);
  assert.equal(configError('mqtt-broker', withStoredKey(edit, stored)), null);
});

test('roles: the view says there is a key, never gives it; the audit does not log the PEMs', () => {
  const r = role({ scheme: 'mqtts', port: 8883, username: '', password: 'p', caPem, clientCertPem: certPem, clientKeyPem: keyPem });
  const v = roleView(r, null) as unknown as { config: Record<string, unknown>; hasClientKey: boolean };
  assert.equal(v.hasClientKey, true);
  assert.equal('clientKeyPem' in v.config, false);
  assert.equal('password' in v.config, false);
  assert.equal(JSON.stringify(v).includes('PRIVATE KEY'), false);
  const d = settingsDiff({ scheme: 'mqtts' }, r.config);
  assert.ok(d.changed.includes('clientKeyPem'));
  assert.equal(JSON.stringify(d.values).includes('BEGIN'), false);
});
