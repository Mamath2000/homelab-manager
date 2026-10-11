import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { certFingerprint, createPki } from '../src/pki.js';
import { fetchFingerprint, normalizeFingerprint, pbsGet } from '../src/pbs.js';

// A local HTTPS server standing for the PBS: the token must only reach the right certificate.
let server: Server;
let url = '';
let fingerprint = '';
const seen: (string | undefined)[] = [];

before(async () => {
  const pki = await createPki();
  // a certificate issued by a CA (like ACME or an internal CA): pinning must not depend on the chain
  fingerprint = normalizeFingerprint(certFingerprint(pki.serverCert));
  server = createServer({ key: pki.serverKey, cert: pki.serverCert }, (req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ store: 'ds3' }] }));
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
