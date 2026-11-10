import assert from 'node:assert/strict';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { before, test } from 'node:test';
import { securityOf, versionAtLeast } from '../src/mqttSecurity.js';
import { createPki, issueMqttCert } from '../src/pki.js';
import { withStoredKey } from '../src/routes/roles.js';
import type { MqttBrokerRole, RoleCandidate } from '../src/types.js';

const role = (port: number) => ({ config: { port } }) as Pick<MqttBrokerRole, 'config'>;
const host = (c: Partial<RoleCandidate>) => ({ roleCandidates: [{ type: 'mqtt-broker', process: 'mosquitto', port: 1883, scheme: 'mqtt', ...c } as RoleCandidate] });

test('versionAtLeast', () => {
  assert.equal(versionAtLeast('2.1.2', 2, 1), true);
  assert.equal(versionAtLeast('2.0.21', 2, 1), false);
  assert.equal(versionAtLeast('3.0', 2, 1), true);
  assert.equal(versionAtLeast('x', 2, 1), false);
});

test('securityOf: unavailable, available, active', () => {
  assert.equal(securityOf(role(1883), null).state, 'unavailable');
  assert.equal(securityOf(role(1883), host({ process: 'nanomq', version: '2.1.2' })).state, 'unavailable');
  assert.equal(securityOf(role(1883), host({})).state, 'unavailable');
  const old = securityOf(role(1883), host({ version: '2.0.21' }));
  assert.equal(old.state, 'unavailable');
  assert.match(old.reason!, /2\.1/);
  assert.equal(securityOf(role(1883), host({ version: '2.1.2' })).state, 'available');
  assert.equal(securityOf(role(1883), host({ version: '2.1.2', dynsec: true })).state, 'active');
  assert.equal(securityOf(role(9999), host({ version: '2.1.2' })).state, 'unavailable');
});

test('securityOf: the role keeps its port after an activation, the TLS listener of the hub is not the role', () => {
  const activated = { config: { port: 1883, dynsec: { enabledAt: new Date() } } } as Pick<MqttBrokerRole, 'config'>;
  assert.equal(securityOf(activated, host({ version: '2.1.2', dynsec: true })).state, 'active');
  assert.equal(securityOf({ config: { port: 8883 } } as Pick<MqttBrokerRole, 'config'>, host({ version: '2.1.2', dynsec: true })).state, 'unavailable');
});

test('withStoredKey keeps the stored TLS material when the form sends none', () => {
  const stored = { type: 'mqtt-broker', config: { scheme: 'mqtts', port: 8883, username: 'hlm', password: '', caPem: 'CA', clientCertPem: 'CERT', clientKeyPem: 'KEY' } } as never;
  const kept = withStoredKey({ scheme: 'mqtts', port: 8883, username: 'hlm' } as never, stored);
  assert.deepEqual([kept.caPem, kept.clientCertPem, kept.clientKeyPem], ['CA', 'CERT', 'KEY']);
  const plain = withStoredKey({ scheme: 'mqtt', port: 1883, username: '' } as never, stored);
  assert.equal(plain.caPem, undefined);
});

let pki: Awaited<ReturnType<typeof createPki>>;
before(async () => {
  pki = await createPki();
});

test('issueMqttCert: server certificate with the names of the host, client certificate with the account as CN', async () => {
  const server = await issueMqttCert(pki, 'server', 'mosquitto', ['192.168.100.111', 'mqtt.lo']);
  const s = new X509Certificate(server.cert);
  assert.match(s.subjectAltName ?? '', /IP Address:192\.168\.100\.111/);
  assert.match(s.subjectAltName ?? '', /DNS:mqtt\.lo/);
  assert.ok(s.verify(new X509Certificate(pki.caCert).publicKey), 'signed by the CA');
  const client = await issueMqttCert(pki, 'client', 'hlm');
  const c = new X509Certificate(client.cert);
  assert.equal(c.subject, 'CN=hlm');
  assert.ok(c.checkPrivateKey(createPrivateKey(client.key)));
  assert.ok(c.verify(new X509Certificate(pki.caCert).publicKey), 'signed by the CA');
});

test('adminBroker: the hub administers on the TLS listener with its own certificate, whatever the connection of the role', async () => {
  const { adminBroker } = await import('../src/mqttDynsec.js');
  const role = { _id: 'vouille', config: { scheme: 'mqtt', port: 1883, username: 'hlm-vouille', password: 'x', dynsec: { enabledAt: new Date(), clientNotAfter: new Date(), caPem: 'CA', clientCertPem: 'CERT', clientKeyPem: 'KEY' } } } as unknown as MqttBrokerRole;
  const admin = adminBroker(role, ['192.168.100.10'])!;
  assert.equal(admin.url, 'mqtts://192.168.100.10:8883');
  assert.deepEqual([admin.tls?.caPem, admin.tls?.clientCertPem, admin.tls?.clientKeyPem], ['CA', 'CERT', 'KEY']);
  assert.equal(adminBroker({ ...role, config: { ...role.config, dynsec: undefined } } as unknown as MqttBrokerRole, ['192.168.100.10']), null);
  assert.equal(adminBroker(role, []), null);
});
