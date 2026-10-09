// Internal PKI: a CA created on first start signs
//   - the TLS certificate of the agent port (EKU serverAuth), pinned by the install command;
//   - one client certificate per agent (EKU clientAuth), from a CSR whose key never leaves the host.
// Agents check the chain against the pinned CA and the serverAuth usage, not the host name, so the
// hub address can change without reissuing anything.
import 'reflect-metadata';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import type { PkiDoc } from './types.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNING = { name: 'ECDSA', hash: 'SHA-256' } as const;
const YEAR = 365 * 24 * 3600 * 1000;
export const CLIENT_CERT_YEARS = 5;

function serial() {
  // positive 128-bit serial
  const b = randomBytes(16);
  b[0] &= 0x7f;
  return b.toString('hex');
}

async function newKeys() {
  return (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
}

async function keyToPem(key: CryptoKey) {
  const der = await webcrypto.subtle.exportKey('pkcs8', key);
  return x509.PemConverter.encode(der, 'PRIVATE KEY');
}

async function pemToKey(pem: string) {
  return webcrypto.subtle.importKey('pkcs8', x509.PemConverter.decodeFirst(pem), ALG, true, ['sign']);
}

/** sha256 of the DER certificate, lowercase hex without separators. */
export function certFingerprint(pemOrDer: string | ArrayBuffer | Buffer) {
  const der = typeof pemOrDer === 'string' ? Buffer.from(x509.PemConverter.decodeFirst(pemOrDer)) : Buffer.from(pemOrDer as ArrayBuffer);
  return createHash('sha256').update(der).digest('hex');
}

/** curl --pinnedpubkey value: sha256 of the SubjectPublicKeyInfo, base64. */
export function spkiPin(certPem: string) {
  const spki = new x509.X509Certificate(certPem).publicKey.rawData;
  return createHash('sha256').update(Buffer.from(spki)).digest('base64');
}

export async function createPki(): Promise<Omit<PkiDoc, '_id'>> {
  const now = new Date();
  const caKeys = await newKeys();
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: 'CN=Homelab Manager CA',
    notBefore: now,
    notAfter: new Date(now.getTime() + 20 * YEAR),
    signingAlgorithm: SIGNING,
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });
  const serverKeys = await newKeys();
  const server = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: 'CN=homelab-manager',
    issuer: ca.subject,
    notBefore: now,
    notAfter: new Date(now.getTime() + 10 * YEAR),
    signingAlgorithm: SIGNING,
    publicKey: serverKeys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'homelab-manager' }, { type: 'dns', value: 'localhost' }]),
      await x509.AuthorityKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });
  return {
    caCert: ca.toString('pem'),
    caKey: await keyToPem(caKeys.privateKey),
    serverCert: server.toString('pem'),
    serverKey: await keyToPem(serverKeys.privateKey),
    createdAt: now,
  };
}

/** true when the PEM is a well-formed, self-signed (proof of possession) CSR. */
export async function checkCsr(csrPem: string) {
  try {
    return await new x509.Pkcs10CertificateRequest(csrPem).verify();
  } catch {
    return false;
  }
}

/**
 * Signs an agent CSR: the subject is forced to the host id, the usage to TLS client only.
 * Throws when the CSR is malformed, not self-consistent or not an ECDSA/RSA key.
 */
export async function signClientCsr(pki: Pick<PkiDoc, 'caCert' | 'caKey'>, csrPem: string, hostId: string) {
  const csr = new x509.Pkcs10CertificateRequest(csrPem);
  if (!(await csr.verify())) throw new Error('invalid CSR signature');
  const ca = new x509.X509Certificate(pki.caCert);
  const now = new Date();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=${hostId}`,
    issuer: ca.subject,
    notBefore: new Date(now.getTime() - 5 * 60_000), // tolerate small clock skews
    notAfter: new Date(now.getTime() + CLIENT_CERT_YEARS * YEAR),
    signingAlgorithm: SIGNING,
    publicKey: csr.publicKey,
    signingKey: await pemToKey(pki.caKey),
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], false),
      await x509.AuthorityKeyIdentifierExtension.create(ca.publicKey),
    ],
  });
  const pem = cert.toString('pem');
  return { certPem: pem, fingerprint: certFingerprint(pem) };
}
