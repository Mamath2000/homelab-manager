import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:https';
import { test } from 'node:test';
import Fastify from 'fastify';
import { config, parseTrustProxy } from '../src/config.js';
import { createPki, issueUiCert, UI_CERT_DAYS } from '../src/pki.js';
import { cookieSecure, isLoopback, registerHttpPolicy, transport } from '../src/transport.js';
import { needsIssue, uiSans } from '../src/uiTls.js';

const LAN = '192.168.1.50';
const PROXY = '192.168.1.20';

function probe(trustProxy: boolean | string[]) {
  const app = Fastify({ trustProxy });
  app.get('/t', async (req) => ({ ...transport(req), secure: cookieSecure(req), ip: req.ip }));
  return app;
}

test('TRUST_PROXY: true, false or a list of addresses', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('true'), true);
  assert.deepEqual(parseTrustProxy('10.0.0.5, 192.168.1.0/24'), ['10.0.0.5', '192.168.1.0/24']);
});

test('loopback addresses', () => {
  for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopback(ip), ip);
  for (const ip of ['192.168.1.1', '::ffff:10.0.0.1', '', undefined]) assert.ok(!isLoopback(ip), String(ip));
});

test('auto cookie: Secure when a trusted proxy says https, not from anyone else', async (t) => {
  t.after(() => (config.cookieSecure = 'auto'));
  config.cookieSecure = 'auto';
  const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-for': '10.9.9.9' };
  const app = probe([PROXY]);
  const viaProxy = (await app.inject({ url: '/t', headers, remoteAddress: PROXY })).json();
  assert.deepEqual(viaProxy, { https: true, direct: false, hopClear: true, secure: true, ip: '10.9.9.9' });
  // another machine of the LAN sending the same headers is taken at its word: plain http, its own address
  const spoofed = (await app.inject({ url: '/t', headers, remoteAddress: LAN })).json();
  assert.deepEqual(spoofed, { https: false, direct: false, hopClear: false, secure: false, ip: LAN });
  // a proxy on the loopback (same host, network_mode: host): no hop in clear to report
  const local = (await probe(true).inject({ url: '/t', headers, remoteAddress: '127.0.0.1' })).json();
  assert.equal(local.hopClear, false);
  assert.equal(local.secure, true);
});

test('COOKIE_SECURE=true and false win over the transport', async (t) => {
  t.after(() => (config.cookieSecure = 'auto'));
  const app = probe(false);
  config.cookieSecure = true;
  assert.equal((await app.inject({ url: '/t', remoteAddress: LAN })).json().secure, true);
  config.cookieSecure = false;
  assert.equal((await app.inject({ url: '/t', headers: { 'x-forwarded-proto': 'https' }, remoteAddress: '127.0.0.1' })).json().secure, false);
});

async function policyApp(trustProxy: boolean | string[] = [PROXY]) {
  const app = Fastify({ trustProxy });
  registerHttpPolicy(app);
  app.get('/api/health', async () => ({ ok: true }));
  app.post('/api/auth/login', async () => ({ ok: true }));
  app.get('/api/hosts', async () => ['h']);
  app.get('/', async () => 'page');
  app.setNotFoundHandler((_req, reply) => reply.send('spa'));
  return app;
}

test('http port, mode redirect: pages go to https, logins and keys are refused', async (t) => {
  const saved = { ...config };
  t.after(() => Object.assign(config, { httpsPort: saved.httpsPort, httpsPublicPort: saved.httpsPublicPort, httpMode: saved.httpMode }));
  Object.assign(config, { httpsPort: 4443, httpsPublicPort: 8443, httpMode: 'redirect' });
  const app = await policyApp();
  const from = (remoteAddress: string, opts: Record<string, unknown> = {}) => app.inject({ remoteAddress, headers: { host: 'hub.lan:5445', ...(opts.headers as object) }, ...opts });

  const page = await from(LAN, { url: '/hosts/abc?x=1' });
  assert.equal(page.statusCode, 308);
  assert.equal(page.headers.location, 'https://hub.lan:8443/hosts/abc?x=1');
  assert.equal((await from(LAN, { url: '/' })).statusCode, 308);

  const login = await from(LAN, { method: 'POST', url: '/api/auth/login', payload: {} });
  assert.equal(login.statusCode, 403);
  assert.deepEqual(login.json(), { error: 'https_required', url: 'https://hub.lan:8443' });
  // spelled otherwise, still the login route
  assert.equal((await from(LAN, { method: 'POST', url: '/%61pi/auth/login', payload: {} })).statusCode, 403);
  assert.equal((await from(LAN, { url: '/api/hosts', headers: { authorization: 'Bearer hm_x' } })).statusCode, 403);

  // left alone: health, the loopback, a trusted proxy that got the request over https
  assert.equal((await from(LAN, { url: '/api/health' })).statusCode, 200);
  assert.equal((await from('127.0.0.1', { url: '/' })).statusCode, 200);
  assert.equal((await from(PROXY, { url: '/', headers: { 'x-forwarded-proto': 'https' } })).statusCode, 200);
  // the same header from anyone else does not escape the redirection
  assert.equal((await from(LAN, { url: '/', headers: { 'x-forwarded-proto': 'https' } })).statusCode, 308);
});

test('http port without the TLS one: nothing changes', async (t) => {
  const saved = config.httpsPort;
  t.after(() => (config.httpsPort = saved));
  config.httpsPort = 0;
  const app = await policyApp();
  assert.equal((await app.inject({ url: '/', remoteAddress: LAN })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: {}, remoteAddress: LAN })).statusCode, 200);
});

test('certificate of the UI: issued by the CA, for the UI names, not the agent certificate', async () => {
  const pki = await createPki();
  const sans = uiSans(['hub.lan', '192.168.1.10', 'HUB.lan'], 'http://homelab.example:5445');
  assert.deepEqual(sans, ['127.0.0.1', '192.168.1.10', 'homelab-manager', 'homelab.example', 'hub.lan', 'localhost']);
  const ui = await issueUiCert(pki, sans);
  const cert = new X509Certificate(ui.cert);
  assert.ok(cert.checkIssued(new X509Certificate(pki.caCert)));
  assert.deepEqual(cert.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  assert.match(cert.subjectAltName!, /IP Address:192\.168\.1\.10/);
  assert.match(cert.subjectAltName!, /DNS:hub\.lan/);
  const days = (new Date(cert.validTo).getTime() - Date.now()) / 86_400_000;
  assert.ok(days <= UI_CERT_DAYS && days > UI_CERT_DAYS - 1, String(days));
  assert.notEqual(cert.publicKey.export({ type: 'spki', format: 'pem' }), new X509Certificate(pki.serverCert).publicKey.export({ type: 'spki', format: 'pem' }));
});

test('certificate of the UI: reissued when the names change or 30 days before its end', () => {
  const now = new Date('2026-01-01');
  const later = (days: number) => new Date(now.getTime() + days * 86_400_000);
  assert.ok(needsIssue(null, ['a'], now));
  assert.ok(!needsIssue({ sans: ['a'], notAfter: later(100) }, ['a'], now));
  assert.ok(needsIssue({ sans: ['a'], notAfter: later(100) }, ['a', 'b'], now));
  assert.ok(needsIssue({ sans: ['a'], notAfter: later(29) }, ['a'], now));
});

test('TLS port: the same app answers, over https, streams included', async (t) => {
  const pki = await createPki();
  const ui = await issueUiCert(pki, uiSans([], ''));
  const app = Fastify();
  app.get('/proto', async (req) => ({ ...transport(req), secure: cookieSecure(req) }));
  // like the SSE stream of events.ts: a hijacked reply written by hand
  app.get('/stream', (_req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.raw.write('data: 1\n\n');
    reply.raw.end('data: 2\n\n');
  });
  await app.ready();
  const server = createServer({ key: ui.key, cert: ui.cert }, (req, res) => app.routing(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => (server.closeAllConnections(), server.close()));
  const port = (server.address() as AddressInfo).port;
  const get = (path: string) =>
    new Promise<string>((resolve, reject) => {
      // checked like a reverse proxy would: the CA of the hub and the name homelab-manager
      const req = request({ host: '127.0.0.1', port, path, ca: pki.caCert, servername: 'homelab-manager' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.end();
    });
  assert.deepEqual(JSON.parse(await get('/proto')), { https: true, direct: true, hopClear: false, secure: true });
  assert.equal(await get('/stream'), 'data: 1\n\ndata: 2\n\n');
});
