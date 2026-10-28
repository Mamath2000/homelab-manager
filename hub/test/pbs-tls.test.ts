import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { certFingerprint, createPki } from '../src/pki.js';
import { fetchFingerprint, normalizeFingerprint, pbsGet } from '../src/pbs.js';
import { apiRequest } from '../src/tlsApi.js';

// A local HTTPS server standing for the PBS: the token must only reach the right certificate.
let server: Server;
let url = '';
let fingerprint = '';
const seen: (string | undefined)[] = [];
const writes: { method?: string; type?: string; body: string }[] = [];

before(async () => {
  const pki = await createPki();
  // a certificate issued by a CA (like ACME or an internal CA): pinning must not depend on the chain
  fingerprint = normalizeFingerprint(certFingerprint(pki.serverCert));
  server = createServer({ key: pki.serverKey, cert: pki.serverCert }, (req, res) => {
    seen.push(req.headers.authorization);
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.method !== 'GET') writes.push({ method: req.method, type: req.headers['content-type'], body });
      // a write the PBS refuses explains why in its message
      if (req.url?.endsWith('/refused')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: null, message: 'missing Datastore.Modify' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: req.method === 'GET' ? [{ store: 'ds3' }] : null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const conn = (fp: string) => ({ url, fingerprint: fp, tokenId: 'hm@pbs!t', tokenSecret: 'secret' });

test('the fingerprint read from the server is the one of its certificate', async () => {
  assert.equal(await fetchFingerprint(url), fingerprint);
});

test('pinned fingerprint: the request goes through', async () => {
  const data = await pbsGet<{ store: string }[]>(conn(fingerprint), '/admin/datastore');
  assert.deepEqual(data, [{ store: 'ds3' }]);
  assert.equal(seen.at(-1), 'PBSAPIToken=hm@pbs!t:secret');
});

test('another fingerprint: refused before the token is sent', async () => {
  const before = seen.length;
  const other = fingerprint.replace(/^../, fingerprint.startsWith('00') ? '11' : '00');
  await assert.rejects(pbsGet(conn(other), '/admin/datastore'), /empreinte du certificat inattendue/);
  assert.equal(seen.length, before);
});

test('no fingerprint: an untrusted certificate is refused', async () => {
  const before = seen.length;
  await assert.rejects(pbsGet(conn(''), '/admin/datastore'));
  assert.equal(seen.length, before);
});

test('write: JSON body, pinned the same way, message of a refusal', async () => {
  const c = { url, fingerprint, authorization: 'PBSAPIToken=hm@pbs!t:secret', defaultPort: 8007, denied: { 401: '401', 403: '403' }, unreachable: 'down' };
  assert.equal(await apiRequest(c, 'POST', '/config/remote', { name: 'vouille' }), null);
  assert.deepEqual(writes.at(-1), { method: 'POST', type: 'application/json', body: '{"name":"vouille"}' });
  await assert.rejects(apiRequest(c, 'PUT', '/config/refused', {}), /HTTP 400 sur PUT \/config\/refused : missing Datastore.Modify/);
});
