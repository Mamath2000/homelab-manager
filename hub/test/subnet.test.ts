import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressIn, inSubnet, networkOf } from '../src/subnet.js';

test('subnets: network of a gateway address or an { ip, mask }, membership', () => {
  assert.equal(networkOf('192.168.10.1/24'), '192.168.10.0/24');
  assert.equal(networkOf({ ip: '192.168.2.0', mask: 24 }), '192.168.2.0/24');
  assert.equal(networkOf('192.168.2.0/24'), '192.168.2.0/24');
  assert.equal(networkOf('10.1.2.3/8'), '10.0.0.0/8');
  assert.equal(networkOf('pas une adresse'), null);
  assert.equal(networkOf('192.168.1.1/33'), null);
  assert.ok(inSubnet('192.168.100.241', '192.168.100.0/24'));
  assert.ok(!inSubnet('192.168.101.241', '192.168.100.0/24'));
  assert.ok(inSubnet('8.8.8.8', '0.0.0.0/0'));
  // a host with several addresses: the one in the networks of the tunnel
  assert.equal(addressIn(['192.168.101.241', '192.168.100.241'], ['192.168.0.0/24', '192.168.100.0/24']), '192.168.100.241');
  assert.equal(addressIn(['172.17.0.1'], ['192.168.0.0/24']), '');
});
