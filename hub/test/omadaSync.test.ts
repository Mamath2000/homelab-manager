import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { autoProbes, candidatesFor, nativeOf, providedBy } from '../src/omadaSync.js';
import type { OmadaDevice } from '../src/types.js';

const device = (o: Partial<OmadaDevice> = {}): OmadaDevice => ({ mac: 'AA:BB:CC:DD:EE:FF', name: 'SG2008P', type: 'switch', model: 'SG2008P', ip: '192.168.0.4', firmware: '3.20', connected: true, siteId: 'o1', ...o });
const eq = (name: string, o: object = {}) => ({ _id: new ObjectId(), name, source: 'manual' as const, ...o });

test('native checks: connected or not', () => {
  assert.deepEqual(nativeOf(device()).checks, [{ key: 'connected', label: 'Connecté au contrôleur', level: 'ok' }]);
  const loaded = nativeOf(device({ cpu: 12, mem: 90 })).checks;
  assert.deepEqual(loaded.map((c) => [c.key, c.level]), [['connected', 'ok'], ['cpu', 'ok'], ['memory', 'warn']]);
  assert.equal(loaded[2].reason, 'Mémoire à 90 %');
  assert.equal(nativeOf(device({ cpu: 97 })).checks[1].level, 'alert');
  assert.equal(nativeOf(device({ connected: false })).checks[0].level, 'alert');
});

test('provided by the source: type, site of the homelab (when matched), address', () => {
  assert.deepEqual(providedBy(device(), { o1: 'vouille' }), { type: 'switch', siteId: 'vouille', ip: '192.168.0.4' });
  assert.deepEqual(providedBy(device({ ip: undefined }), {}), { type: 'switch' });
});

test('candidates: the address first, else the name on the same site; linked ones are never offered', () => {
  const list = [eq('Switch bureau', { ip: '192.168.0.4' }), eq('SG2008P', { siteId: 'vouille' }), eq('SG2008P', { siteId: 'jarsay' }), eq('Omada', { ip: '192.168.0.4', source: 'omada' })];
  assert.deepEqual(candidatesFor(device(), list).map((e) => e.name), ['Switch bureau']);
  assert.deepEqual(candidatesFor(device({ ip: '10.0.0.9' }), list, 'vouille').map((e) => e.siteId), ['vouille']);
  assert.deepEqual(candidatesFor(device({ ip: undefined }), list), []);
});

test('automatic probes: a ping and the web interface, none without an address, none twice', () => {
  const id = new ObjectId();
  assert.deepEqual(autoProbes(id, '192.168.0.4', []).map((p) => p.target), [{ type: 'ping', host: '192.168.0.4' }, { type: 'http', url: 'https://192.168.0.4/', insecure: true }]);
  assert.deepEqual(autoProbes(id, undefined, []), []);
  assert.deepEqual(autoProbes(id, '192.168.0.4', [{ target: { type: 'ping', host: '192.168.0.4' } }]).map((p) => p.name), ['Interface web']);
});
