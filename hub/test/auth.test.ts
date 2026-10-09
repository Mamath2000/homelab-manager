import assert from 'node:assert/strict';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { registerAuth } from '../src/auth.js';

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
