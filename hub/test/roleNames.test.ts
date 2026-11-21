import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { siteRoleNames } from '../src/roles.js';

const h1 = new ObjectId();
const h2 = new ObjectId();
const h3 = new ObjectId();
const hostsById: Record<string, { name: string; siteId?: string }> = { [String(h1)]: { name: 'ct-mqtt', siteId: 'v' }, [String(h2)]: { name: 'mqtt2', siteId: 'v' }, [String(h3)]: { name: 'nosite' } };
const role = (id: string, type: string, host: ObjectId, day: number, config: object = {}) => ({ _id: id, type, name: id, carrier: { kind: 'host', id: host }, createdAt: new Date(day), config }) as never;
const run = (list: never[]) => siteRoleNames(list, (id) => hostsById[id], () => undefined, (id) => (id === 'v' ? 'Vouillé' : undefined));

test('site, duplicate on the same site, no site', () => {
  const n = run([role('b', 'mqtt-broker', h2, 2), role('a', 'mqtt-broker', h1, 1), role('c', 'mqtt-broker', h3, 3), role('p', 'pve-cluster', h1, 1), role('o', 'omada-controller', h1, 1, { siteId: 'v' }), role('o2', 'omada-controller', h1, 1, {})]);
  assert.equal(n.get('a'), 'MQTT — Vouillé');
  assert.equal(n.get('b'), 'MQTT — Vouillé (mqtt2)');
  assert.equal(n.get('c'), 'MQTT — nosite');
  assert.equal(n.get('p'), 'PVE — Vouillé');
  assert.equal(n.get('o'), 'Omada — Vouillé');
  assert.equal(n.get('o2'), 'o2');
});

test('idempotent', () => {
  const first = run([role('a', 'mqtt-broker', h1, 1), role('b', 'mqtt-broker', h2, 2)]);
  const again = run([{ ...role('a', 'mqtt-broker', h1, 1), name: first.get('a') }, { ...role('b', 'mqtt-broker', h2, 2), name: first.get('b') }] as never[]);
  assert.deepEqual([...again], [...first]);
});
