import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessChecks, agentItems, containerChecks, dataChecks, mqttChecks, parseProcStatus, rootIsReadOnly } from '../src/securityHealth.js';

const status = (list: { id: string; status: string }[], id: string) => list.find((c) => c.id === id)?.status;

test('http: bad https and cookie; https behind a clear hop: warn', () => {
  const base = { hopClear: false, cookieSecure: false, trustProxy: false as boolean | string[] };
  const http = accessChecks({ ...base, https: false });
  assert.equal(status(http, 'https'), 'bad');
  assert.equal(status(http, 'cookie'), 'bad');
  const hop = accessChecks({ ...base, https: true, hopClear: true, cookieSecure: true });
  assert.equal(status(hop, 'https'), 'warn');
  assert.equal(status(hop, 'cookie'), 'ok');
});

test('TRUST_PROXY=true is a warning, an address is fine', () => {
  const i = { https: true, hopClear: false, cookieSecure: true };
  assert.equal(status(accessChecks({ ...i, trustProxy: true }), 'trust-proxy'), 'warn');
  assert.equal(status(accessChecks({ ...i, trustProxy: ['192.168.1.20'] }), 'trust-proxy'), 'ok');
});

test('database and master key', () => {
  assert.deepEqual(dataChecks({ mongoAuth: false, masterKey: false }).map((c) => c.status), ['warn', 'warn']);
  assert.deepEqual(dataChecks({ mongoAuth: true, masterKey: true }).map((c) => c.status), ['ok', 'ok']);
});

test('agents: only the enrolled ones, each gap named', () => {
  const policy = { file: '/etc/p.json', invalid: false, agentInstall: false, deny: [], pbsFingerprints: [], pinPbs: false, pinnedPbs: '', pinFile: '' };
  const h = (name: string, extra: object) => ({ name, enrolledAt: new Date(), certFingerprint: 'x', agentMinVersion: '1.0.12', policy, ...extra }) as never;
  const items = agentItems(
    [h('good', {}), h('old', { agentMinVersion: undefined, policy: undefined }), h('late', {}), { name: 'new' } as never],
    (x) => (x.name === 'late' ? true : false),
  );
  assert.deepEqual(items.map((i) => i.name), ['old', 'late']);
  assert.match(items[0].detail, /version minimum.*politique locale/);
});

test('mqtt: anonymous broker is bad, mqtt:// is a warning, the ACL stays unknown while the bridge is on', () => {
  const b = { name: 'mosquitto', url: 'mqtts://b:8883', anonymous: false, hasAccount: true, usedByBridge: true };
  assert.equal(status(mqttChecks([b], true), 'mqtt'), 'ok');
  assert.equal(status(mqttChecks([b], true), 'mqtt-acl'), 'unknown');
  assert.equal(status(mqttChecks([b], false), 'mqtt-acl'), 'ok');
  assert.equal(status(mqttChecks([{ ...b, url: 'mqtt://b:1883' }], true), 'mqtt'), 'warn');
  assert.equal(status(mqttChecks([{ ...b, anonymous: true }], true), 'mqtt'), 'bad');
  assert.equal(status(mqttChecks([], true), 'mqtt'), 'unknown');
});

test('/proc parsing', () => {
  assert.deepEqual(parseProcStatus('Name:\tnode\nCapBnd:\t0000000000000000\nNoNewPrivs:\t1\n'), { noNewPrivs: true, capBounding: '0000000000000000' });
  assert.deepEqual(parseProcStatus('Name:\tnode\n'), { noNewPrivs: null, capBounding: null });
  assert.equal(rootIsReadOnly('1 0 0:1 / / ro,relatime - overlay overlay rw\n2 1 0:2 / /proc rw - proc proc rw'), true);
  assert.equal(rootIsReadOnly('1 0 0:1 / / rw,relatime - overlay overlay rw'), false);
  assert.equal(rootIsReadOnly(''), null);
});

test('container checks follow the facts', () => {
  const hardened = containerChecks({ uid: 1000, noNewPrivs: true, capBounding: '0000000000000000', rootReadOnly: true });
  assert.ok(hardened.every((c) => c.status === 'ok'));
  const open = containerChecks({ uid: 0, noNewPrivs: false, capBounding: '00000000a80425fb', rootReadOnly: false });
  assert.deepEqual(open.map((c) => c.status), ['bad', 'warn', 'warn', 'warn']);
  assert.ok(containerChecks({ uid: null, noNewPrivs: null, capBounding: null, rootReadOnly: null }).every((c) => c.status === 'unknown'));
});
