import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roleUrl } from '../src/probes.js';

test('broker role: address typed, else first private IP of the host', () => {
  const ips = ['172.17.0.1/16', '192.168.1.40/24', 'fe80::1/64'];
  assert.equal(roleUrl({ scheme: 'mqtt', port: 1883 }, ips), 'mqtt://192.168.1.40:1883');
  assert.equal(roleUrl({ scheme: 'mqtts', port: 8883, address: 'broker.lan' }, ips), 'mqtts://broker.lan:8883');
  assert.equal(roleUrl({ scheme: 'mqtt', port: 1883, address: 'fd00::5' }, ips), 'mqtt://[fd00::5]:1883');
});

test('broker role: no address known gives no URL', () => {
  assert.equal(roleUrl({ scheme: 'mqtt', port: 1883 }, ['127.0.0.1/8']), '');
  assert.equal(roleUrl({ scheme: 'mqtt', port: 1883 }, null), '');
});
