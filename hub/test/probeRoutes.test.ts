import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerProbeRoutes } from '../src/routes/probes.js';

// The routes that need no database: the schema, the validation of the targets and the test of a probe.
async function app() {
  const a = Fastify();
  registerProbeRoutes(a);
  return a;
}

test('probe test: refuses what the schema or the target validation refuses', async () => {
  const a = await app();
  const post = (payload: unknown) => a.inject({ method: 'POST', url: '/api/probes/test', payload });
  assert.equal((await post({})).statusCode, 400);
  assert.equal((await post({ target: { type: 'smtp', host: 'x' } })).statusCode, 400);
  // what a type needs
  assert.equal((await post({ target: { type: 'ping' } })).statusCode, 400);
  assert.equal((await post({ target: { type: 'tcp', host: 'x' } })).statusCode, 400);
  assert.equal((await post({ target: { type: 'http' } })).statusCode, 400);
  assert.equal((await post({ target: { type: 'mqtt', brokerId: 'v' } })).statusCode, 400);
  assert.equal((await post({ target: { type: 'tcp', host: 'x', port: 70000 } })).statusCode, 400);
  const option = await post({ target: { type: 'ping', host: '-f' } });
  assert.equal(option.statusCode, 400);
  assert.equal(option.json().error, 'adresse invalide');
  assert.equal((await post({ target: { type: 'http', url: 'ftp://host/' } })).statusCode, 400);
  assert.equal((await post({ target: { type: 'mqtt', brokerId: 'v', topic: 'a/#' } })).statusCode, 400);
});

test('probe test: measures a tcp port without saving anything', async () => {
  const a = await app();
  const server = createServer((s) => s.end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const up = await a.inject({ method: 'POST', url: '/api/probes/test', payload: { target: { type: 'tcp', host: '127.0.0.1', port }, timeoutSec: 2 } });
    assert.equal(up.statusCode, 200);
    assert.equal(up.json().state, 'up');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  const down = await a.inject({ method: 'POST', url: '/api/probes/test', payload: { target: { type: 'tcp', host: '127.0.0.1', port }, timeoutSec: 2 } });
  assert.equal(down.json().state, 'down');
});

test('probe and broker bodies: bad values are refused before any handler', async () => {
  const a = await app();
  const send = (method: 'POST' | 'PUT', url: string, payload: unknown) => a.inject({ method, url, payload });
  const target = { type: 'ping', host: '192.168.1.1' };
  assert.equal((await send('POST', '/api/hosts/x/probes', { name: '', target })).statusCode, 400);
  assert.equal((await send('POST', '/api/hosts/x/probes', { name: 'ok', target, retries: 9 })).statusCode, 400);
  assert.equal((await send('POST', '/api/hosts/x/probes', { name: 'ok', target, intervalSec: 1 })).statusCode, 400);
  assert.equal((await send('POST', '/api/settings/mqtt-brokers', { name: 'v', url: 'http://x', username: '' })).statusCode, 400);
  assert.equal((await send('POST', '/api/settings/mqtt-brokers', { name: 'v', url: 'mqtt://x:1883' })).statusCode, 400);
  // past the schema: refused afterwards for the unknown host (404 once the database answers), not by the schema
  assert.notEqual((await send('POST', '/api/hosts/x/probes', { name: 'ok', target })).statusCode, 400);
});
