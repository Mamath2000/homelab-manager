import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerSecurityHeaders } from '../src/securityHeaders.js';

async function app(trustProxy = false) {
  const app = Fastify({ trustProxy });
  await registerSecurityHeaders(app);
  app.get('/', async () => 'ok');
  return app;
}

test('every response carries the security headers', async () => {
  const res = await (await app()).inject({ method: 'GET', url: '/' });
  const csp = String(res.headers['content-security-policy']);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
});

test('no HSTS over plain http', async () => {
  const res = await (await app()).inject({ method: 'GET', url: '/' });
  assert.equal(res.headers['strict-transport-security'], undefined);
});

test('HSTS when a trusted proxy says the browser is on https', async () => {
  const res = await (await app(true)).inject({ method: 'GET', url: '/', headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(res.headers['strict-transport-security'], 'max-age=604800');
});

test('no HSTS from a proxy header nobody trusts', async () => {
  const res = await (await app(false)).inject({ method: 'GET', url: '/', headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(res.headers['strict-transport-security'], undefined);
});
