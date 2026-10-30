import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ObjectId } from 'mongodb';
import { authorize } from '../src/profiles.js';
import { fromLegacy, newRoleId, pbsRoles, ROLE_DEFS, roleConflict } from '../src/roles.js';
import { clusterOf, roleOf } from '../src/pve.js';
import { roleView } from '../src/roleView.js';
import { configError, registerRoleRoutes, toConfig } from '../src/routes/roles.js';
import { matchHaBroker, registerSettingsRoutes } from '../src/routes/settings.js';
import type { HomeAssistantBridge } from '../src/homeassistant/bridge.js';
import type { MqttBroker, MqttBrokerConfig, OmadaControllerConfig, PbsRemoteSettings, PbsSettings, RoleDoc } from '../src/types.js';

const broker = (name: string, hostId: ObjectId, port = 1883): RoleDoc => ({
  _id: newRoleId(name, () => false),
  type: 'mqtt-broker',
  name,
  carrier: { kind: 'host', id: hostId },
  config: { scheme: 'mqtt', port, username: '', password: '' },
  createdAt: new Date(),
});
const config = (port: number): MqttBrokerConfig => ({ scheme: 'mqtt', port, username: '', password: '' });

test('roles: id from the name, unique among the roles', () => {
  assert.equal(newRoleId('Mosquitto Vouillé', () => false), 'mosquitto-vouille');
  assert.equal(newRoleId('***', () => false), 'role');
  const taken = new Set(['mqtt', 'mqtt-2']);
  assert.equal(newRoleId('MQTT', (id) => taken.has(id)), 'mqtt-3');
});

test('roles: a broker is activated only on a port its agent detected', () => {
  const def = ROLE_DEFS['mqtt-broker'];
  const host = { roleCandidates: [{ type: 'mqtt-broker' as const, process: 'mosquitto', port: 1883, scheme: 'mqtt' }] };
  assert.equal(def.carrierError(host, config(1883)), null);
  assert.ok(def.carrierError(host, config(8883)));
  assert.ok(def.carrierError({}, config(1883)));
});

test('roles: same broker on a carrier, name taken, the role edited is not its own conflict', () => {
  const a = new ObjectId();
  const b = new ObjectId();
  const list = [broker('Vouille', a)];
  assert.equal(roleConflict(list, 'mqtt-broker', 'Jarsay', b, config(1883)), null);
  assert.equal(roleConflict(list, 'mqtt-broker', 'Autre', a, config(8883)), null);
  assert.equal(roleConflict(list, 'mqtt-broker', 'Autre', a, config(1883)), 'ce rôle est déjà déclaré sur cet hôte');
  assert.equal(roleConflict(list, 'mqtt-broker', 'VOUILLE', b, config(1883)), 'un rôle de ce type porte déjà ce nom');
  assert.equal(roleConflict(list, 'mqtt-broker', 'Vouille', a, config(1883), 'vouille'), null);
});

test('roles: a role of a host keeps its id, its settings and its host', () => {
  const hostId = new ObjectId();
  const at = new Date();
  const r = fromLegacy(hostId, { id: 'vouille', type: 'mqtt-broker', name: 'Vouille', scheme: 'mqtts', port: 8883, address: 'mqtt.lan', username: 'u', password: 'p' }, at);
  assert.deepEqual(r, { _id: 'vouille', type: 'mqtt-broker', name: 'Vouille', carrier: { kind: 'host', id: hostId }, config: { scheme: 'mqtts', port: 8883, address: 'mqtt.lan', username: 'u', password: 'p' }, createdAt: at });
  assert.equal('address' in fromLegacy(hostId, { id: 'x', type: 'mqtt-broker', name: 'X', scheme: 'mqtt', port: 1883, username: '', password: '' }, at).config, false);
});

test('roles: bad bodies are refused before any handler', async () => {
  const a = Fastify();
  registerRoleRoutes(a);
  const carrier = { kind: 'host', id: new ObjectId().toHexString() };
  const post = (url: string, payload: unknown) => a.inject({ method: 'POST', url, payload });
  assert.equal((await post('/api/roles', { type: 'mqtt-broker', carrier, name: 'v', config: { scheme: 'http', port: 1883, username: '' } })).statusCode, 400);
  assert.equal((await post('/api/roles', { type: 'mqtt-broker', carrier, name: 'v', config: { scheme: 'mqtt', port: 0, username: '' } })).statusCode, 400);
  assert.equal((await post('/api/roles', { type: 'mqtt-broker', carrier, name: 'v', config: { scheme: 'mqtt', port: 1883 } })).statusCode, 400);
  assert.equal((await post('/api/roles', { type: 'pbs', carrier, name: 'v', config: { scheme: 'mqtt', port: 1883, username: '' } })).statusCode, 400);
  // a Proxmox VE cluster has its own routes (routes/backups.ts)
  assert.equal((await post('/api/roles', { type: 'pve-cluster', carrier, name: 'v', config: { scheme: 'mqtt', port: 1883, username: '' } })).statusCode, 400);
  assert.equal((await post('/api/roles', { type: 'mqtt-broker', carrier: { kind: 'equipment', id: carrier.id }, name: 'v', config: { scheme: 'mqtt', port: 1883, username: '' } })).statusCode, 400);
  assert.equal((await post('/api/roles', { type: 'mqtt-broker', carrier, name: '', config: { scheme: 'mqtt', port: 1883, username: '' } })).statusCode, 400);
  assert.equal((await a.inject({ method: 'PUT', url: '/api/roles/x', payload: { name: 'v' } })).statusCode, 400);
  // past the schema: unknown role, from the cache (empty without a database)
  assert.equal((await a.inject({ method: 'PUT', url: '/api/roles/x', payload: { name: 'v', config: { scheme: 'mqtt', port: 1883, username: '' } } })).statusCode, 404);
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/roles/x' })).statusCode, 404);
});

test('roles: every profile reads them, only the admins write them', () => {
  for (const p of ['admin', 'operator', 'viewer'] as const) assert.ok(authorize(p, 'GET', '/api/roles'), p);
  for (const [m, r] of [['POST', '/api/roles'], ['PUT', '/api/roles/:id'], ['DELETE', '/api/roles/:id'], ['POST', '/api/roles/test']]) {
    assert.ok(authorize('admin', m, r), `admin ${m} ${r}`);
    assert.ok(!authorize('operator', m, r), `operator ${m} ${r}`);
    assert.ok(!authorize('viewer', m, r), `viewer ${m} ${r}`);
  }
});

test('roles: the broker of Home Assistant typed before the roles is the role with the same address and account', () => {
  const hostId = new ObjectId();
  const brokers: MqttBroker[] = [
    { id: 'vouille', name: 'Vouille', url: 'mqtt://192.168.100.20:1883', username: '', password: '', hostId },
    { id: 'tls', name: 'TLS', url: 'mqtts://mqtt.lan:8883', username: 'ha', password: 'p', hostId },
    { id: 'nowhere', name: 'Nowhere', url: '', username: '', password: '', hostId },
  ];
  assert.equal(matchHaBroker(brokers, { broker: 'mqtt://192.168.100.20:1883/', username: '', password: '' })?.id, 'vouille');
  assert.equal(matchHaBroker(brokers, { broker: 'MQTTS://mqtt.lan:8883', username: 'ha', password: 'p' })?.id, 'tls');
  // another account: kept as typed, linked by hand
  assert.equal(matchHaBroker(brokers, { broker: 'mqtts://mqtt.lan:8883', username: 'ha', password: 'other' }), null);
  assert.equal(matchHaBroker(brokers, { broker: 'mqtt://mqtt.lan:1883', username: '', password: '' }), null);
  assert.equal(matchHaBroker(brokers, { broker: '', username: '', password: '' }), null);
});

test('roles: Home Assistant names its broker by a role id', async () => {
  const a = Fastify();
  registerSettingsRoutes(a, {} as HomeAssistantBridge);
  const put = (payload: unknown) => a.inject({ method: 'PUT', url: '/api/settings/homeassistant', payload });
  const base = { enabled: true, topic: 'homelab-manager', discoveryPrefix: 'homeassistant' };
  assert.equal((await put({ ...base, brokerRoleId: 'Bad id' })).statusCode, 400);
  assert.equal((await put({ ...base, brokerRoleId: 'x/../y' })).statusCode, 400);
  assert.equal((await a.inject({ method: 'POST', url: '/api/settings/homeassistant/test', payload: {} })).statusCode, 400);
});

test('roles: a Proxmox VE cluster is a pve-cluster role carried by its node, its id kept', () => {
  const node = new ObjectId();
  const at = new Date();
  const c = { id: 'vouille', name: 'Vouillé', url: 'https://pve1:8006', fingerprint: 'AB', tokenId: 'homelab@pve!monitor', tokenSecret: 's', agent: { hostId: node.toHexString() }, timezone: 'Europe/Paris', guests: 12 };
  const r = roleOf(c, 'pve-vouille', at);
  assert.deepEqual(r, { _id: 'pve-vouille', type: 'pve-cluster', name: 'Vouillé', carrier: { kind: 'host', id: node }, config: { url: c.url, fingerprint: 'AB', tokenId: c.tokenId, tokenSecret: 's', timezone: 'Europe/Paris', guests: 12, cluster: 'vouille' }, createdAt: at });
  assert.deepEqual(clusterOf(r), c);
  const def = ROLE_DEFS['pve-cluster'];
  assert.equal(def.carrierError({ capabilities: ['pve'] }, r.config), null);
  assert.ok(def.carrierError({ capabilities: ['docker'] }, r.config));
  // never the secret
  const v = roleView(r, { name: 'pve1', info: undefined });
  assert.equal('tokenSecret' in v.config, false);
  assert.equal(v.hasSecret, true);
  assert.equal(v.account, 'homelab@pve!monitor');
  assert.equal(v.summary, '12 VM / CT');
  assert.equal(roleView({ ...r, config: { ...r.config, polledAt: at, pollError: 'refusé' } }, null).status?.state, 'error');
});

test('roles: the PBS of the backups are roles once connected, carried by the host of their agent, never a secret shown', () => {
  const node = new ObjectId();
  const copy = new ObjectId();
  const pbs = { _id: 'pbs', url: 'https://pbs:8007', fingerprint: '', tokenId: 'homelab@pbs!monitor', tokenSecret: 'SECRET-MAIN', mountRoot: '/srv/pbs-restore', agent: { hostId: node.toHexString(), mode: 'native' }, datastores: [{ store: 'main', total: 1, used: 0, avail: 1 }] } as PbsSettings;
  const remote = { _id: 'pbs-remote', url: 'https://copy:8007', fingerprint: '', store: 'copy', tokenId: 'hub@pbs!copy', tokenSecret: 'SECRET-COPY', readerTokenId: 'r@pbs!r', readerTokenSecret: 'SECRET-READER', agent: { hostId: copy.toHexString(), mode: 'container', container: 'pbs' } } as PbsRemoteSettings;
  const list = pbsRoles(pbs, remote);
  assert.deepEqual(list.map((r) => [r._id, r.carrier.id.toHexString()]), [['pbs-primary', node.toHexString()], ['pbs-offsite', copy.toHexString()]]);
  // typed but not connected (no token yet), or without its agent: not a role
  assert.equal(pbsRoles({ ...pbs, tokenSecret: '' }, null).length, 0);
  assert.equal(pbsRoles({ ...pbs, agent: undefined }, null).length, 0);
  assert.equal(pbsRoles(null, { ...remote, tokenSecret: '' }).length, 0);
  for (const r of list) {
    const v = JSON.stringify(roleView(r, null));
    assert.ok(!v.includes('SECRET'), v);
  }
  assert.equal(roleView(list[0], null).summary, '1 datastore');
  // one of each in the homelab
  assert.equal(roleConflict(list, 'pbs-primary', 'PBS principal', node, list[0].config), 'un rôle PBS principal est déjà déclaré');
  assert.equal(ROLE_DEFS['pbs-primary'].carrierError({ capabilities: ['pbs'] }, pbs), null);
});

const omada = (name: string, hostId: ObjectId, url = 'https://192.168.0.8:8043'): RoleDoc => ({
  _id: newRoleId(name, () => false),
  type: 'omada-controller',
  name,
  carrier: { kind: 'host', id: hostId },
  config: { url, fingerprint: '', clientId: 'app', clientSecret: 'SECRET-OMADA' },
  createdAt: new Date(),
});
const omadaConfig = (url: string): OmadaControllerConfig => ({ url, fingerprint: '', clientId: 'app', clientSecret: 's' });

test('roles: an Omada controller per site, the same address twice on a host is the same controller', () => {
  const a = new ObjectId();
  const b = new ObjectId();
  const list = [omada('Vouille', a)];
  // typed by hand: any host carries it
  assert.equal(ROLE_DEFS['omada-controller'].carrierError({}, omadaConfig('https://x:8043')), null);
  assert.equal(roleConflict(list, 'omada-controller', 'Jarsay', a, omadaConfig('https://192.168.1.8:8043')), null);
  assert.equal(roleConflict(list, 'omada-controller', 'Jarsay', b, omadaConfig('https://192.168.0.8:8043')), null);
  assert.equal(roleConflict(list, 'omada-controller', 'Autre', a, omadaConfig('HTTPS://192.168.0.8:8043/')), 'ce rôle est déjà déclaré sur cet hôte');
  assert.equal(roleConflict(list, 'omada-controller', 'vouille', b, omadaConfig('https://192.168.1.8:8043')), 'un rôle de ce type porte déjà ce nom');
  // a broker of the same name is another type
  assert.equal(roleConflict(list, 'mqtt-broker', 'Vouille', a, config(1883)), null);
});

test('roles: the client secret of an Omada controller is never shown', () => {
  const v = roleView(omada('Vouille', new ObjectId()), { name: 'ct-omada', info: undefined });
  assert.ok(!JSON.stringify(v).includes('SECRET'), JSON.stringify(v));
  assert.equal('clientSecret' in v.config, false);
  assert.equal(v.hasSecret, true);
  assert.equal(v.account, 'app');
  assert.equal(v.url, 'https://192.168.0.8:8043');
  assert.equal(v.status, null);
});

test('roles: the config of each declared type, its fields only', () => {
  const fp = 'ab'.repeat(32);
  assert.equal(configError('mqtt-broker', { scheme: 'mqtt', port: 1883, username: '' }), null);
  assert.equal(configError('mqtt-broker', { scheme: 'mqtt', port: 1883 }), 'username manquant');
  assert.ok(configError('mqtt-broker', { scheme: 'mqtt', port: 1883, username: '', clientId: 'app' }));
  assert.equal(configError('omada-controller', { url: 'https://192.168.0.8:8043', clientId: 'app', clientSecret: 's', fingerprint: fp }), null);
  // absent secret: the stored one
  assert.equal(configError('omada-controller', { url: 'https://omada.lan', clientId: 'app' }), null);
  assert.equal(configError('omada-controller', { url: 'https://omada.lan' }), 'clientId manquant');
  assert.equal(configError('omada-controller', { url: 'https://omada.lan', clientId: '  ' }), 'client_id manquant');
  assert.ok(configError('omada-controller', { url: 'http://omada.lan:8088', clientId: 'app' }));
  assert.ok(configError('omada-controller', { url: 'https://omada.lan/openapi', clientId: 'app' }));
  assert.ok(configError('omada-controller', { url: 'https://omada.lan', clientId: 'app', fingerprint: 'abcd' }));
  assert.ok(configError('omada-controller', { url: 'https://omada.lan', clientId: 'app', port: 8043 }));
  assert.deepEqual(toConfig('omada-controller', { url: ' https://omada.lan:8043/ ', clientId: ' app ', fingerprint: fp }, 's'), {
    url: 'https://omada.lan:8043',
    fingerprint: 'AB:'.repeat(31) + 'AB',
    clientId: 'app',
    clientSecret: 's',
  });
});

test('roles: bad Omada bodies are refused before any handler reads the database', async () => {
  const a = Fastify();
  registerRoleRoutes(a);
  const carrier = { kind: 'host', id: new ObjectId().toHexString() };
  const post = (url: string, payload: unknown) => a.inject({ method: 'POST', url, payload });
  const ok = { url: 'https://192.168.0.8:8043', clientId: 'app', clientSecret: 's' };
  assert.equal((await post('/api/roles', { type: 'omada-controller', carrier, name: 'v', config: { ...ok, url: 'ftp://x' } })).statusCode, 400);
  assert.equal((await post('/api/roles', { type: 'omada-controller', carrier, name: 'v', config: { ...ok, scheme: 'mqtt' } })).statusCode, 400);
  assert.equal((await post('/api/roles', { type: 'omada-controller', carrier, name: 'v', config: { ...ok, clientSecret: '' } })).statusCode, 400);
  assert.equal((await post('/api/roles', { type: 'omada-controller', carrier, name: 'v', config: { ...ok, clientSecret: 'x'.repeat(257) } })).statusCode, 400);
  assert.equal((await post('/api/roles/test', { type: 'omada-controller', carrier, config: { ...ok, fingerprint: 'zz' } })).statusCode, 400);
  // no secret typed and none stored: nothing is tried
  assert.deepEqual((await post('/api/roles/test', { type: 'omada-controller', carrier, config: { url: ok.url, clientId: 'app' } })).json(), { ok: false, error: 'client_secret manquant' });
});
