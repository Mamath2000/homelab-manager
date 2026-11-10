// Internal PKI: a CA created on first start signs
//   - the TLS certificate of the agent port (EKU serverAuth), pinned by the install command;
//   - one client certificate per agent (EKU clientAuth), from a CSR whose key never leaves the host.
// Agents check the chain against the pinned CA and the serverAuth usage, not the host name, so the
// hub address can change without reissuing anything.
import 'reflect-metadata';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { isIP } from 'node:net';
import * as x509 from '@peculiar/x509';
import type { PkiDoc } from './types.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNING = { name: 'ECDSA', hash: 'SHA-256' } as const;
const DAY = 24 * 3600 * 1000;
const YEAR = 365 * DAY;
// Lifetimes of the certificates of the agent link, renewed before they end (certRenew.ts, homelab#302).
export const CLIENT_CERT_DAYS = 365;
export const SERVER_CERT_DAYS = 730;

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
  const server = await agentPortCert(ca, caKeys.privateKey, serverKeys.publicKey, now);
  return {
    caCert: ca.toString('pem'),
    caKey: await keyToPem(caKeys.privateKey),
    serverCert: server.toString('pem'),
    serverKey: await keyToPem(serverKeys.privateKey),
    createdAt: now,
  };
}

// TLS certificate of the agent port. The agents check it against the CA they pinned, not by itself: it is reissued
// for the same key (renewServerCert), which keeps the pin of the install command (spkiPin) unchanged.
async function agentPortCert(ca: x509.X509Certificate, caKey: CryptoKey, publicKey: CryptoKey | x509.PublicKey, now: Date) {
  return x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: 'CN=homelab-manager',
    issuer: ca.subject,
    notBefore: new Date(now.getTime() - 5 * 60_000),
    notAfter: new Date(now.getTime() + SERVER_CERT_DAYS * DAY),
    signingAlgorithm: SIGNING,
    publicKey,
    signingKey: caKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'homelab-manager' }, { type: 'dns', value: 'localhost' }]),
      await x509.AuthorityKeyIdentifierExtension.create(ca.publicKey),
    ],
  });
}

/** The certificate of the agent port issued again for its own key. */
export async function renewServerCert(pki: Pick<PkiDoc, 'caCert' | 'caKey' | 'serverCert'>, now = new Date()) {
  const ca = new x509.X509Certificate(pki.caCert);
  const current = new x509.X509Certificate(pki.serverCert);
  const cert = await agentPortCert(ca, await pemToKey(pki.caKey), current.publicKey, now);
  return { certPem: cert.toString('pem'), notAfter: cert.notAfter };
}

/** End of validity of a PEM certificate. */
export const certNotAfter = (pem: string) => new x509.X509Certificate(pem).notAfter;

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
  return signClientKey(pki, csr.publicKey, hostId);
}

/**
 * Signs a client certificate for a public key already proven: the one of a CSR, or the one an agent presented in its
 * mutual TLS handshake (renewal, certRenew.ts). spki: DER SubjectPublicKeyInfo.
 */
export async function signClientKey(pki: Pick<PkiDoc, 'caCert' | 'caKey'>, publicKey: x509.PublicKey | Buffer, hostId: string) {
  const ca = new x509.X509Certificate(pki.caCert);
  const now = new Date();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=${hostId}`,
    issuer: ca.subject,
    notBefore: new Date(now.getTime() - 5 * 60_000), // tolerate small clock skews
    notAfter: new Date(now.getTime() + CLIENT_CERT_DAYS * DAY),
    signingAlgorithm: SIGNING,
    publicKey: publicKey instanceof x509.PublicKey ? publicKey : new x509.PublicKey(new Uint8Array(publicKey)),
    signingKey: await pemToKey(pki.caKey),
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], false),
      await x509.AuthorityKeyIdentifierExtension.create(ca.publicKey),
    ],
  });
  const pem = cert.toString('pem');
  return { certPem: pem, fingerprint: certFingerprint(pem), notAfter: cert.notAfter };
}

// Certificate of the TLS port of the UI (uiTls.ts), distinct from the one of the agent port: the agents pin that one,
// this one is reissued (names, renewal) without touching them. 397 days: what Apple devices still accept, whoever the issuer.
export const UI_CERT_DAYS = 397;

export async function issueUiCert(pki: Pick<PkiDoc, 'caCert' | 'caKey'>, sans: string[]) {
  const ca = new x509.X509Certificate(pki.caCert);
  const keys = await newKeys();
  const now = new Date();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: 'CN=homelab-manager',
    issuer: ca.subject,
    notBefore: new Date(now.getTime() - 5 * 60_000),
    notAfter: new Date(now.getTime() + UI_CERT_DAYS * 24 * 3600 * 1000),
    signingAlgorithm: SIGNING,
    publicKey: keys.publicKey,
    signingKey: await pemToKey(pki.caKey),
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension(sans.map((value) => ({ type: isIP(value.replace(/^\[|\]$/g, '')) ? ('ip' as const) : ('dns' as const), value: value.replace(/^\[|\]$/g, '') }))),
      await x509.AuthorityKeyIdentifierExtension.create(ca.publicKey),
    ],
  });
  return { cert: cert.toString('pem'), key: await keyToPem(keys.privateKey), notAfter: cert.notAfter };
}

// Certificates of a Mosquitto broker with dynamic-security (mqttDynsec.ts), signed by the same CA: the server one for its
// TLS listener (names: the IPs of its host), the client one for the account of the hub (the broker takes the CN as the
// account). The key is generated here and never leaves the hub, except the one of the server that the agent installs.
export const MQTT_CERT_DAYS = 365;

export async function issueMqttCert(pki: Pick<PkiDoc, 'caCert' | 'caKey'>, kind: 'server' | 'client', cn: string, sans: string[] = []) {
  const ca = new x509.X509Certificate(pki.caCert);
  const keys = await newKeys();
  const now = new Date();
  const names = sans.map((v) => v.replace(/^\[|\]$/g, '')).filter(Boolean);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=${cn}`,
    issuer: ca.subject,
    notBefore: new Date(now.getTime() - 5 * 60_000),
    notAfter: new Date(now.getTime() + MQTT_CERT_DAYS * DAY),
    signingAlgorithm: SIGNING,
    publicKey: keys.publicKey,
    signingKey: await pemToKey(pki.caKey),
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([kind === 'server' ? x509.ExtendedKeyUsage.serverAuth : x509.ExtendedKeyUsage.clientAuth], false),
      ...(kind === 'server' && names.length ? [new x509.SubjectAlternativeNameExtension(names.map((value) => ({ type: isIP(value) ? ('ip' as const) : ('dns' as const), value })))] : []),
      await x509.AuthorityKeyIdentifierExtension.create(ca.publicKey),
    ],
  });
  return { cert: cert.toString('pem'), key: await keyToPem(keys.privateKey), notAfter: cert.notAfter };
}
