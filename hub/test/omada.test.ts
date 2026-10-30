import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { omadaCheck, omadaProbe, omadaSnapshot, presentedFingerprint } from '../src/omada.js';
import { certFingerprint, createPki } from '../src/pki.js';
import { normalizeFingerprint } from '../src/tlsApi.js';

// A local HTTPS server standing for the Omada controller: /api/info, the token of the application, its sites.
let server: Server;
let url = '';
let fingerprint = '';
const seen: { url?: string; authorization?: string; body: string }[] = [];

before(async () => {
  const pki = await createPki();
  fingerprint = normalizeFingerprint(certFingerprint(pki.serverCert));
  server = createServer({ key: pki.serverKey, cert: pki.serverCert }, (req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ url: req.url, authorization: req.headers.authorization, body });
      const send = (v: unknown) => (res.writeHead(200, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(v)));
      if (req.url === '/api/info') return send({ errorCode: 0, msg: 'Success.', result: { controllerVer: '5.15.20', omadacId: 'abc123' } });
      if (req.url === '/openapi/authorize/token?grant_type=client_credentials' && req.method === 'POST') {
        const b = JSON.parse(body) as { omadacId: string; client_id: string; client_secret: string };
        if (b.omadacId !== 'abc123' || b.client_id !== 'app' || b.client_secret !== 'secret') return send({ errorCode: -44106, msg: 'The client id or client secret is invalid.' });
        return send({ errorCode: 0, msg: 'Open API Get Access Token successfully.', result: { accessToken: 'AT-1', tokenType: 'bearer', expiresIn: 7200 } });
      }
      if (req.url?.startsWith('/openapi/v1/abc123/sites/s1/devices')) {
        return send({ errorCode: 0, result: { totalRows: 2, data: [
          { mac: '40-AE-30-E0-02-CC', name: 'ER707', type: 'gateway', modelName: 'ER707-M2', ip: '192.168.0.1', status: 1, firmwareVersion: '1.4.5' },
          { mac: '5c-e9-31-dc-8d-c1', name: 'SG2008P', type: 'switch', model: 'SG2008P v3.20', status: 0, firmwareVersion: '3.20' },
        ] } });
      }
      if (req.url?.startsWith('/openapi/v1/abc123/sites')) {
        if (req.headers.authorization !== 'AccessToken=AT-1') return send({ errorCode: -44112, msg: 'The access token has expired.' });
        if (req.url.includes('page=2')) return send({ errorCode: 0, result: { totalRows: 3, data: [] } });
        return send({ errorCode: 0, msg: 'Success.', result: { totalRows: 3, currentPage: 1, currentSize: 1, data: [{ siteId: 's1', name: 'vouille' }] } });
      }
      res.writeHead(404);
      res.end('not found');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const conf = (fp: string, clientSecret = 'secret') => ({ url, fingerprint: fp, clientId: 'app', clientSecret });

test('omada: pinned certificate, token of the application, then its sites', async () => {
  assert.deepEqual(await omadaCheck(conf(fingerprint)), { omadacId: 'abc123', version: '5.15.20', sites: 3 });
  assert.deepEqual(JSON.parse(seen.find((s) => s.url?.startsWith('/openapi/authorize'))!.body), { omadacId: 'abc123', client_id: 'app', client_secret: 'secret' });
  assert.equal(seen.at(-1)?.authorization, 'AccessToken=AT-1');
});

test('omada: the refusal of the controller is its message', async () => {
  await assert.rejects(omadaCheck(conf(fingerprint, 'wrong')), /client secret is invalid.*errorCode -44106/);
});

test('omada: a certificate refused gives the fingerprint it presents, never sends the secret', async () => {
  const before = seen.length;
  const other = fingerprint.replace(/^../, fingerprint.startsWith('00') ? '11' : '00');
  for (const c of [conf(''), conf(other)]) {
    const err = await omadaCheck(c).then(
      () => assert.fail('accepted'),
      (e: unknown) => e,
    );
    assert.equal(await presentedFingerprint(c, err), fingerprint);
  }
  assert.equal(seen.length, before);
  // another failure: no fingerprint offered
  const err = await omadaCheck(conf(fingerprint, 'wrong')).catch((e: unknown) => e);
  assert.equal(await presentedFingerprint(conf(fingerprint, 'wrong'), err), null);
});

test('omada: the probe asks /api/info only, without any account', async () => {
  const before = seen.length;
  assert.deepEqual(await omadaProbe({ url, fingerprint }), { omadacId: 'abc123', version: '5.15.20' });
  assert.deepEqual(seen.slice(before).map((s) => [s.url, s.authorization]), [['/api/info', undefined]]);
  // not pinned: the certificate is refused, and the one it presents is offered
  const err = await omadaProbe({ url, fingerprint: '' }).catch((e: unknown) => e);
  assert.equal(await presentedFingerprint({ url, fingerprint: '' }, err), fingerprint);
});

test('omada: snapshot of the sites and devices, MAC normalised, status 1 = connected', async () => {
  const snap = await omadaSnapshot(conf(fingerprint));
  assert.deepEqual(snap.sites, [{ id: 's1', name: 'vouille' }]);
  assert.deepEqual(snap.devices.map((d) => [d.mac, d.type, d.connected, d.siteId]), [
    ['40:AE:30:E0:02:CC', 'gateway', true, 's1'],
    ['5C:E9:31:DC:8D:C1', 'switch', false, 's1'],
  ]);
  assert.equal(snap.devices[0].model, 'ER707-M2');
  assert.equal(snap.devices[1].ip, undefined);
});
