// Optional TLS port of the UI (HTTPS_PORT, homelab#315), next to the http one: same application, same routes, the
// requests are handed to the Fastify router. Certificate: the files of HTTPS_CERT_FILE / HTTPS_KEY_FILE, else one
// issued by the CA of the hub for the UI alone (never the pinned certificate of the agent port), renewed by the hub.
// Browsers reaching it directly accept an exception for this certificate; a reverse proxy checks it against the CA
// (/agent/ca.pem on the agent port) and the name homelab-manager. The CA is not meant to be imported in a browser or
// an OS: it has no name constraint.
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { loadAgentSettings } from './agentUpdate.js';
import { config } from './config.js';
import { settings } from './db.js';
import { certFingerprint, issueUiCert } from './pki.js';
import { loadPki } from './pkiStore.js';
import { seal } from './secrets.js';
import { openSettings } from './storedSecrets.js';
import type { UiTlsDoc } from './types.js';

const DAY = 24 * 3600 * 1000;
const RENEW_BEFORE = 30 * DAY;

export interface UiTls {
  cert: string;
  key: string;
  fingerprint: string;
}

// Names of the issued certificate: the fixed ones, HTTPS_SAN, and the host of the hub URL (Paramètres > Agent).
export function uiSans(extra: string[], hubUrl: string) {
  const out = ['homelab-manager', 'localhost', '127.0.0.1', ...extra];
  try {
    if (hubUrl) out.push(new URL(hubUrl).hostname);
  } catch {
    // an invalid hub URL adds nothing
  }
  return [...new Set(out.map((s) => s.toLowerCase().replace(/^\[|\]$/g, '')))].sort();
}

// The stored certificate is kept while it has the same names and more than 30 days left.
export function needsIssue(doc: Pick<UiTlsDoc, 'sans' | 'notAfter'> | null, sans: string[], now = new Date()) {
  return !doc || doc.sans.join(',') !== sans.join(',') || new Date(doc.notAfter).getTime() - now.getTime() < RENEW_BEFORE;
}

export async function loadUiTls(log: FastifyBaseLogger): Promise<UiTls> {
  if (config.httpsCertFile || config.httpsKeyFile) {
    if (!config.httpsCertFile || !config.httpsKeyFile) throw new Error('HTTPS_CERT_FILE and HTTPS_KEY_FILE go together');
    const cert = readFileSync(config.httpsCertFile, 'utf8');
    return { cert, key: readFileSync(config.httpsKeyFile, 'utf8'), fingerprint: certFingerprint(cert) };
  }
  const sans = uiSans(config.httpsSan, (await loadAgentSettings()).hubUrl);
  let doc = openSettings('uiTls', (await settings.findOne({ _id: 'uiTls' })) as UiTlsDoc | null);
  if (needsIssue(doc, sans)) {
    const issued = await issueUiCert(await loadPki(), sans);
    doc = { _id: 'uiTls', ...issued, sans, createdAt: new Date() };
    await settings.replaceOne({ _id: 'uiTls' }, { ...doc, key: seal(issued.key, 'settings/uiTls/key') }, { upsert: true });
    log.info({ sans, notAfter: issued.notAfter }, 'https: certificate of the UI issued');
  }
  return { cert: doc!.cert, key: doc!.key, fingerprint: certFingerprint(doc!.cert) };
}

export async function startUiTlsServer(app: FastifyInstance, log: FastifyBaseLogger) {
  const tls = await loadUiTls(log);
  const server: Server = createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, (req, res) => app.routing(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.httpsPort, config.host, () => resolve());
  });
  log.info({ port: config.httpsPort, fingerprint: tls.fingerprint.match(/../g)!.join(':').toUpperCase() }, 'https: UI listening');
  // daily: renewal, and a new hub URL taken into account, without a restart
  let current = tls.fingerprint;
  const timer = setInterval(() => {
    loadUiTls(log).then(
      (next) => {
        if (next.fingerprint === current) return;
        server.setSecureContext({ key: next.key, cert: next.cert });
        current = next.fingerprint;
      },
      (err) => log.error({ err }, 'https: certificate of the UI not renewed'),
    );
  }, DAY);
  timer.unref();
  return {
    async close() {
      clearInterval(timer);
      // the SSE streams stay open otherwise (forceCloseConnections covers the server of Fastify only)
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
