import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import type { MqttTls } from './types.js';

// TLS side of the connections to an MQTT broker (the roles of the hub): the options of the client, and the check of
// what the administrator typed. The server certificate is always verified (never rejectUnauthorized: false).

const PEM_RE = /^-----BEGIN [A-Z ]+-----[\s\S]+-----END [A-Z ]+-----\s*$/;
export const PEM_MAX = 16_384;

const has = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/** Options of mqtt.connect for a TLS link: {} when there is nothing to pin or present. */
export function tlsOptions(tls: MqttTls | undefined) {
  if (!tls) return {};
  return {
    ...(has(tls.caPem) ? { ca: tls.caPem } : {}),
    ...(has(tls.clientCertPem) && has(tls.clientKeyPem) ? { cert: tls.clientCertPem, key: tls.clientKeyPem } : {}),
  };
}

/** What identifies a TLS config, to reopen a connection when it changes (never the key itself). */
export function tlsKey(tls: MqttTls | undefined) {
  if (!tls) return '';
  return createHash('sha256').update(JSON.stringify([tls.caPem ?? '', tls.clientCertPem ?? '', tls.clientKeyPem ?? ''])).digest('hex').slice(0, 16);
}

/**
 * null: the TLS material fits a link of this scheme, else why not. keyKept: the key is the one stored (absent from the
 * body), checked with the certificate by the caller once resolved.
 */
export function tlsError(tls: MqttTls, scheme: string): string | null {
  const { caPem, clientCertPem, clientKeyPem } = tls;
  if (!has(caPem) && !has(clientCertPem) && !has(clientKeyPem)) return null;
  if (scheme !== 'mqtts' && scheme !== 'wss') return 'certificats inutilisables : choisir mqtts ou wss';
  for (const [name, v] of [['autorité (CA)', caPem], ['certificat client', clientCertPem], ['clé privée', clientKeyPem]] as const) {
    if (!has(v)) continue;
    if (v.length > PEM_MAX) return `${name} : trop long`;
    if (!PEM_RE.test(v.trim())) return `${name} : format PEM attendu`;
  }
  if (has(caPem)) {
    try {
      new X509Certificate(caPem);
    } catch {
      return 'autorité (CA) : certificat illisible';
    }
  }
  if (has(clientCertPem) !== has(clientKeyPem)) return 'certificat client et clé privée vont ensemble';
  if (has(clientCertPem) && has(clientKeyPem)) {
    try {
      const cert = new X509Certificate(clientCertPem);
      if (!cert.checkPrivateKey(createPrivateKey(clientKeyPem))) return 'la clé privée ne correspond pas au certificat client';
      if (new Date(cert.validTo).getTime() < Date.now()) return 'certificat client expiré';
    } catch {
      return 'certificat client ou clé privée illisible';
    }
  }
  return null;
}

/** The TLS material of a role config (undefined when it has none), as the pool and the tests take it. */
export function tlsOf(c: MqttTls): MqttTls | undefined {
  const tls = { ...(has(c.caPem) ? { caPem: c.caPem } : {}), ...(has(c.clientCertPem) ? { clientCertPem: c.clientCertPem } : {}), ...(has(c.clientKeyPem) ? { clientKeyPem: c.clientKeyPem } : {}) };
  return Object.keys(tls).length ? tls : undefined;
}
