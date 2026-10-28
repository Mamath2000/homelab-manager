import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ObjectId } from 'mongodb';
import { equipmentDto, uplinkError } from '../src/equipments.js';
import { NATIVE_STALE_MS, dayOf, evaluateEquipment, evaluateEquipments, nativeStatus } from '../src/monitoring.js';
import { registerEquipmentRoutes } from '../src/routes/equipments.js';
import type { EquipmentDoc, ProbeDoc, ProbeState } from '../src/types.js';

const now = Date.UTC(2026, 9, 28, 12);
const equipment = (o: Partial<EquipmentDoc> = {}): EquipmentDoc => ({ _id: new ObjectId(), name: 'Switch salon', type: 'switch', source: 'manual', createdAt: new Date(now), ...o });
const probe = (e: EquipmentDoc, name: string, state?: ProbeState, message?: string): ProbeDoc => ({
  _id: new ObjectId(), subject: { kind: 'equipment', id: e._id }, name, target: { type: 'ping', host: '192.168.1.2' }, runFrom: 'hub',
  intervalSec: 60, timeoutSec: 10, retries: 0, createdAt: new Date(now), ...(state ? { state } : {}), ...(message ? { message } : {}),
});

test('uplink: must exist and never lead back to the equipment', () => {
  // a -> b -> c
  const up = new Map<string, string | undefined>([['a', 'b'], ['b', 'c'], ['c', undefined]]);
  const upOf = (id: string) => (up.has(id) ? up.get(id) : null);
  assert.equal(uplinkError('a', 'b', upOf), null);
  assert.equal(uplinkError(null, 'a', upOf), null);
  assert.equal(uplinkError('x', 'nope', upOf), 'équipement amont introuvable');
  assert.match(uplinkError('a', 'a', upOf)!, /boucle/);
  // c below a would close the chain
  assert.match(uplinkError('c', 'a', upOf)!, /boucle/);
});

test('a manual equipment has no connection domain: its probes tell everything', () => {
  const e = equipment();
  assert.equal(nativeStatus(e, now), null);
  assert.deepEqual(evaluateEquipment(e, { now, probes: [] }), { level: 'ok', domains: {} });
  const s = evaluateEquipment(e, { now, probes: [probe(e, 'Ping', 'up'), probe(e, 'Interface web', 'down', 'code 502')] });
  assert.equal(s.level, 'alert');
  assert.deepEqual(Object.keys(s.domains), ['services']);
  assert.deepEqual(dayOf(s.domains.services), { level: 'alert', reasons: ['Interface web : code 502'] });
});

test('a synced equipment: native checks of its source, unknown once the source is silent', () => {
  const checks = [{ key: 'connected', label: 'Connexion', level: 'alert' as const, reason: 'Déconnecté du contrôleur' }];
  assert.equal(nativeStatus(equipment({ source: 'omada' }), now)?.level, 'unknown');
  const fresh = equipment({ source: 'omada', externalId: 'aa:bb', native: { syncedAt: new Date(now - 60_000), checks } });
  assert.deepEqual(dayOf(nativeStatus(fresh, now)), { level: 'alert', reasons: ['Déconnecté du contrôleur'] });
  const silent = equipment({ source: 'omada', externalId: 'aa:bb', native: { syncedAt: new Date(now - NATIVE_STALE_MS - 1), checks } });
  assert.deepEqual(nativeStatus(silent, now), { level: 'unknown', checks: [], reason: 'Source muette' });
  // unknown is left out of the level: the probe still says the service is up
  assert.equal(evaluateEquipment(silent, { now, probes: [probe(silent, 'UI', 'up')] }).level, 'ok');
});

test('status of every equipment: each one with its own probes', () => {
  const a = equipment();
  const b = equipment({ name: 'VTO' });
  const hostProbe: ProbeDoc = { ...probe(a, 'host'), subject: { kind: 'host', id: a._id }, state: 'down' };
  const all = evaluateEquipments([a, b], [probe(b, 'Ping', 'down', 'pas de réponse'), hostProbe], now);
  assert.equal(all[a._id.toHexString()].level, 'ok');
  assert.equal(all[b._id.toHexString()].level, 'alert');
});

test('dto: optional fields as null, a square per probe', () => {
  const e = equipment({ ip: '192.168.1.2' });
  const d = equipmentDto(e, [probe(e, 'Ping')]);
  assert.equal(d.siteId, null);
  assert.equal(d.uplinkId, null);
  assert.equal(d.ip, '192.168.1.2');
  assert.deepEqual(d.probes.map((p) => [p.name, p.state]), [['Ping', 'unknown']]);
});

test('equipment bodies: bad values are refused before any handler', async () => {
  const a = Fastify();
  registerEquipmentRoutes(a);
  const send = (method: 'POST' | 'PATCH', url: string, payload: unknown) => a.inject({ method, url, payload });
  assert.equal((await send('POST', '/api/equipments', { name: 'x' })).statusCode, 400);
  assert.equal((await send('POST', '/api/equipments', { name: '', type: 'switch' })).statusCode, 400);
  assert.equal((await send('POST', '/api/equipments', { name: 'x', type: 'router' })).statusCode, 400);
  assert.equal((await send('PATCH', '/api/equipments/x', {})).statusCode, 400);
  // checked before the database is read
  const ip = await send('POST', '/api/equipments', { name: 'x', type: 'switch', ip: '192.168.1.300' });
  assert.equal(ip.statusCode, 400);
  assert.equal(ip.json().error, 'adresse IP invalide');
});
