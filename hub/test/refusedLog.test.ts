import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetRefused, markCreated, noteLogLine, parseConnected, parseRefused, refusedOf } from '../src/refusedLog.js';

test('parseRefused reads the client id and the address, without the port', () => {
  assert.deepEqual(parseRefused('1794318425: Client mqtt_salon [192.168.100.52:41234] disconnected: not authorised.'), { clientId: 'mqtt_salon', address: '192.168.100.52' });
  assert.deepEqual(parseRefused('Client auto-EB93C39E-8451 [127.0.0.1:45434] disconnected: not authorised.'), { clientId: 'auto-EB93C39E-8451', address: '127.0.0.1' });
  assert.equal(parseRefused('New connection from 192.168.100.52:41234 on port 1883.'), null);
  assert.equal(parseRefused('Client esp [192.168.1.5:1] disconnected: protocol error.'), null);
});

test('parseConnected reads the client id of a connection that passed', () => {
  assert.equal(parseConnected('1794318426: New client connected from 192.168.0.93:52370 as mqtt-explorer-2d1a3570 (p4, c1, k60).'), 'mqtt-explorer-2d1a3570');
  assert.equal(parseConnected('Client x [10.0.0.5:1] disconnected: not authorised.'), null);
});

test('refused connections are counted per client id, newest first', () => {
  const id = 'role-a';
  noteLogLine(id, 'Client esp-1 [10.0.0.5:1000] disconnected: not authorised.', 1000);
  noteLogLine(id, 'Client esp-1 [10.0.0.5:1001] disconnected: not authorised.', 2000);
  noteLogLine(id, 'Client z2m [10.0.0.9:1002] disconnected: not authorised.', 3000);
  noteLogLine(id, 'something else', 4000);
  const list = refusedOf(id, 5000);
  assert.deepEqual(list.map((e) => [e.clientId, e.count]), [['z2m', 1], ['esp-1', 2]]);
  assert.equal(list[1].firstAt, 1000);
  assert.equal(list[1].lastAt, 2000);
  // older than a week: gone
  assert.deepEqual(refusedOf(id, 3000 + 8 * 24 * 3600 * 1000), []);
  assert.deepEqual(refusedOf('other', 0), []);
});

test('the last message of a client wins: a connection that passes clears its refusals', () => {
  const id = 'role-b';
  noteLogLine(id, 'Client Test [10.0.0.5:1000] disconnected: not authorised.', 1000);
  noteLogLine(id, 'Client Other [10.0.0.6:1000] disconnected: not authorised.', 1500);
  markCreated(id, 'Test', 'user-test', 2000);
  assert.equal(refusedOf(id, 2500).find((e) => e.clientId === 'Test')?.account, 'user-test');
  // refused again after the account was made: still listed, with the account (wrong password)
  noteLogLine(id, 'Client Test [10.0.0.5:1001] disconnected: not authorised.', 3000);
  const again = refusedOf(id, 3500).find((e) => e.clientId === 'Test')!;
  assert.ok(again.lastAt > again.accountAt!);
  noteLogLine(id, 'New client connected from 10.0.0.5:1002 as Test (p4, c1, k60).', 4000);
  assert.deepEqual(refusedOf(id, 4500).map((e) => e.clientId), ['Other']);
});

test('the administrator can clear a refused client', () => {
  const id = 'role-c';
  noteLogLine(id, 'Client esp-9 [10.0.0.5:1000] disconnected: not authorised.', 1000);
  assert.equal(forgetRefused(id, 'esp-9'), true);
  assert.equal(forgetRefused(id, 'esp-9'), false);
  assert.deepEqual(refusedOf(id, 2000), []);
  noteLogLine(id, 'Client esp-9 [10.0.0.5:1001] disconnected: not authorised.', 3000);
  assert.equal(refusedOf(id, 3500).length, 1);
});
