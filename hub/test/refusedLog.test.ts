import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetRefused, noteRefused, parseRefused, refusedOf } from '../src/refusedLog.js';

test('parseRefused reads the client id and the address, without the port', () => {
  assert.deepEqual(parseRefused('1794318425: Client mqtt_salon [192.168.100.52:41234] disconnected: not authorised.'), { clientId: 'mqtt_salon', address: '192.168.100.52' });
  assert.deepEqual(parseRefused('Client auto-EB93C39E-8451 [127.0.0.1:45434] disconnected: not authorised.'), { clientId: 'auto-EB93C39E-8451', address: '127.0.0.1' });
  assert.equal(parseRefused('New connection from 192.168.100.52:41234 on port 1883.'), null);
  assert.equal(parseRefused('Client esp [192.168.1.5:1] disconnected: protocol error.'), null);
});

test('refused connections are counted per client id, newest first, and forgotten', () => {
  const id = 'role-a';
  noteRefused(id, 'Client esp-1 [10.0.0.5:1000] disconnected: not authorised.', 1000);
  noteRefused(id, 'Client esp-1 [10.0.0.5:1001] disconnected: not authorised.', 2000);
  noteRefused(id, 'Client z2m [10.0.0.9:1002] disconnected: not authorised.', 3000);
  noteRefused(id, 'something else', 4000);
  const list = refusedOf(id, 5000);
  assert.deepEqual(list.map((e) => [e.clientId, e.count]), [['z2m', 1], ['esp-1', 2]]);
  assert.equal(list[1].firstAt, 1000);
  assert.equal(list[1].lastAt, 2000);
  forgetRefused(id, 'esp-1');
  assert.deepEqual(refusedOf(id, 5000).map((e) => e.clientId), ['z2m']);
  // older than a week: gone
  assert.deepEqual(refusedOf(id, 3000 + 8 * 24 * 3600 * 1000), []);
  assert.deepEqual(refusedOf('other', 0), []);
});
