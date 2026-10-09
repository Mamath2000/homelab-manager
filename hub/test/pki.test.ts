import assert from 'node:assert/strict';
import { X509Certificate as NodeCert, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { webcrypto } from 'node:crypto';
import { certFingerprint, createPki, signClientCsr, spkiPin } from '../src/pki.js';

async function csrFor(cn: string) {
  const keys = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${cn}`,
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
  });
  return csr.toString('pem');
}

test('the CA signs a server certificate for TLS server use only', async () => {
  const pki = await createPki();
  const ca = new NodeCert(pki.caCert);
  const server = new NodeCert(pki.serverCert);
  assert.ok(ca.ca);
  assert.ok(server.verify(ca.publicKey));
  assert.ok(server.checkIssued(ca));
  assert.deepEqual(server.keyUsage, ['1.3.6.1.5.5.7.3.1']); // serverAuth
  // the PEM private key matches the certificate
  const pub = createPublicKey(createPrivateKey(pki.serverKey)).export({ type: 'spki', format: 'der' });
  assert.deepEqual(pub, server.publicKey.export({ type: 'spki', format: 'der' }));
});

test('agent CSRs become client certificates named after the host, whatever they ask for', async () => {
  const pki = await createPki();
  const { certPem, fingerprint } = await signClientCsr(pki, await csrFor('evil'), 'host123');
  const cert = new NodeCert(certPem);
  assert.equal(cert.subject, 'CN=host123');
  assert.deepEqual(cert.keyUsage, ['1.3.6.1.5.5.7.3.2']); // clientAuth only
  assert.ok(cert.verify(new NodeCert(pki.caCert).publicKey));
  assert.equal(fingerprint, certFingerprint(certPem));
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
});

test('malformed or tampered CSRs are refused', async () => {
  const pki = await createPki();
  await assert.rejects(signClientCsr(pki, 'not a csr', 'h'));
  // a CSR whose public key is swapped no longer verifies
  const good = new x509.Pkcs10CertificateRequest(await csrFor('h'));
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' });
  const raw = Buffer.from(good.rawData);
  const spki = Buffer.from(good.publicKey.rawData);
  const idx = raw.indexOf(spki);
  assert.ok(idx > 0);
  other.copy(raw, idx);
  await assert.rejects(signClientCsr(pki, x509.PemConverter.encode(raw, 'CERTIFICATE REQUEST'), 'h'));
});

test('the SPKI pin is the base64 sha256 curl expects', async () => {
  const pki = await createPki();
  const pin = spkiPin(pki.serverCert);
  assert.match(pin, /^[A-Za-z0-9+/]{43}=$/);
  assert.notEqual(pin, spkiPin(pki.caCert));
});
