import assert from 'node:assert/strict';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { registerAuth, sessionExpiry } from '../src/auth.js';

// Requests without a session cookie never reach Mongo, so no database is needed here.
async function app() {
  const app = Fastify();
  await app.register(cookie);
  registerAuth(app);
  app.get('/api/hosts', async () => ['secret']);
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/install.sh', async () => 'script');
  return app;
}

test('protected routes refuse anonymous requests, however the path is spelled', async () => {
  const a = await app();
  for (const url of ['/api/hosts', '/%61pi/hosts', '/api/%68osts', '/api/hosts?x=1', '/api/hosts/']) {
    const res = await a.inject({ method: 'GET', url });
    assert.notEqual(res.statusCode, 200, `${url} must not be served anonymously`);
    assert.doesNotMatch(res.body, /secret/, url);
  }
});

test('public routes stay reachable', async () => {
  const a = await app();
  assert.equal((await a.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
  assert.equal((await a.inject({ method: 'GET', url: '/install.sh' })).statusCode, 200);
});

test('a session ends at its idle timeout, never after its absolute end', () => {
  const hour = 3600_000;
  const login = new Date('2026-11-09T08:00:00Z');
  const endsAt = new Date(login.getTime() + 7 * 24 * hour);
  assert.equal(sessionExpiry(endsAt, login, 12 * hour).toISOString(), '2026-11-09T20:00:00.000Z');
  // used on the last day: the absolute end wins
  const late = new Date(endsAt.getTime() - 2 * hour);
  assert.equal(sessionExpiry(endsAt, late, 12 * hour).toISOString(), endsAt.toISOString());
});
