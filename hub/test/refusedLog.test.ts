import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anonymousOf, clearRefused, forgetRefused, markCreated, noteLogLine, parseConnected, parseRefused, refusedOf } from '../src/refusedLog.js';

test('parseRefused reads the client id and the address, without the port', () => {
  assert.deepEqual(parseRefused('1794318425: Client mqtt_salon [192.168.100.52:41234] disconnected: not authorised.'), { clientId: 'mqtt_salon', address: '192.168.100.52' });
  assert.deepEqual(parseRefused('Client auto-EB93C39E-8451 [127.0.0.1:45434] disconnected: not authorised.'), { clientId: 'auto-EB93C39E-8451', address: '127.0.0.1' });
  assert.equal(parseRefused('New connection from 192.168.100.52:41234 on port 1883.'), null);
  assert.equal(parseRefused('Client esp [192.168.1.5:1] disconnected: protocol error.'), null);
});

test('parseConnected reads the client id of a connection that passed', () => {
  assert.deepEqual(parseConnected('1794318426: New client connected from 192.168.0.93:52370 as mqtt-explorer-2d1a3570 (p4, c1, k60).'), { clientId: 'mqtt-explorer-2d1a3570', address: '192.168.0.93' });
  assert.deepEqual(parseConnected("New client connected from 10.0.0.5:1 as esp (p5, c1, k60, u'user')."), { clientId: 'esp', address: '10.0.0.5', user: 'user' });
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

test('the administrator can clear the whole list', () => {
  const id = 'role-d';
  for (const c of ['auto-1', 'auto-2', 'auto-3']) noteLogLine(id, `Client ${c} [10.0.0.5:1000] disconnected: not authorised.`, 1000);
  assert.equal(clearRefused(id), 3);
  assert.deepEqual(refusedOf(id, 2000), []);
  assert.equal(clearRefused('nobody'), 0);
});

test('anonymous clients: connected until they leave, gone when they log in with an account', () => {
  const id = 'role-e';
  noteLogLine(id, '1000: New client connected from 192.168.0.93:52370 as explorer (p4, c1, k60).');
  noteLogLine(id, "1001: New client connected from 10.0.0.5:5 as esp-1 (p4, c1, k60, u'esp').");
  let list = anonymousOf(id, 1_002_000);
  assert.deepEqual(list.map((a) => [a.clientId, a.connected, a.address]), [['explorer', true, '192.168.0.93']]);
  noteLogLine(id, '1500: Client explorer [192.168.0.93:52370] disconnected: connection closed by client.');
  list = anonymousOf(id, 1_502_000);
  assert.deepEqual(list.map((a) => [a.clientId, a.connected]), [['explorer', false]]);
  noteLogLine(id, '1600: New client connected from 192.168.0.93:52999 as explorer (p4, c1, k60).');
  assert.equal(anonymousOf(id, 1_602_000)[0].connected, true);
  noteLogLine(id, '1700: Client explorer closed its connection.');
  noteLogLine(id, '1800: Client explorer disconnected.');
  assert.equal(anonymousOf(id, 1_802_000)[0].connected, false);
  // a refusal is not a disconnection of an anonymous client
  noteLogLine(id, '1900: New client connected from 192.168.0.93:53000 as explorer (p4, c1, k60).');
  noteLogLine(id, '1950: Client explorer [192.168.0.93:53000] disconnected: not authorised.');
  assert.equal(anonymousOf(id, 1_952_000)[0].connected, true);
  noteLogLine(id, "2000: New client connected from 192.168.0.93:53001 as explorer (p5, c1, k60, u'me').");
  assert.deepEqual(anonymousOf(id, 2_002_000), []);
  // history older than a week is dropped
  noteLogLine(id, '3000: New client connected from 1.1.1.1:1 as old (p4, c1, k60).');
  noteLogLine(id, '3001: Client old disconnected.');
  assert.deepEqual(anonymousOf(id, 3_001_000 + 8 * 24 * 3600 * 1000), []);
});

test('log lines carry the time they were written: replayed history keeps its dates', () => {
  const id = 'role-f';
  noteLogLine(id, '1794318425: Client esp [10.0.0.5:1] disconnected: not authorised.');
  const [e] = refusedOf(id, 1794318425_000 + 1000);
  assert.equal(e.lastAt, 1794318425_000);
});
