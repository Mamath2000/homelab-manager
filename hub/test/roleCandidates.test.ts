import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCandidates } from '../src/agents.js';

test('cleanCandidates keeps the version and the dynsec state of a broker', () => {
  const [c] = cleanCandidates([{ type: 'mqtt-broker', process: 'mosquitto', port: 1883, scheme: 'mqtt', version: '2.1.2', dynsec: true }]);
  assert.equal(c.version, '2.1.2');
  assert.equal(c.dynsec, true);
});

test('cleanCandidates drops a malformed version and anything on an Omada controller', () => {
  const [a] = cleanCandidates([{ type: 'mqtt-broker', process: 'mosquitto', port: 1883, scheme: 'mqtt', version: '2.1; rm', dynsec: 'yes' }]);
  assert.equal(a.version, undefined);
  assert.equal(a.dynsec, undefined);
  const [o] = cleanCandidates([{ type: 'omada-controller', process: 'java', port: 8043, scheme: 'https', version: '2.1.2', dynsec: true }]);
  assert.equal(o.version, undefined);
  assert.equal(o.dynsec, undefined);
});
