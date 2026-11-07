import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Empty variables count as unset.
function env(name: string) {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function num(name: string, fallback: number) {
  const v = Number(env(name) ?? fallback);
  return Number.isFinite(v) ? v : fallback;
}

const list = (name: string) => (env(name) ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// COOKIE_SECURE: true forces the Secure attribute (the session never works over http), false never sets it, unset:
// set when the request came over https (TLS port of the UI, or a trusted proxy saying so)
function cookieSecure(): boolean | 'auto' {
  const v = env('COOKIE_SECURE');
  return v === 'true' ? true : v === 'false' ? false : 'auto';
}

// TRUST_PROXY: true trusts any client for the X-Forwarded-* headers (only safe when the port is reachable by the
// proxy alone), or a list of addresses / ranges of the proxies (10.0.0.5,192.168.1.0/24), the other clients being
// taken at their word
export function parseTrustProxy(v: string | undefined): boolean | string[] {
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  version: (JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')) as { version: string }).version,
  port: num('PORT', 3000),
  // TLS port for the agents (install script, binaries, enrollment, WebSocket)
  agentTlsPort: num('AGENT_TLS_PORT', 3443),
  host: env('HOST') ?? '0.0.0.0',
  // optional: the logs also go to this file (stdout stays the main output)
  logFile: env('LOG_FILE'),
  mongoUrl: env('MONGO_URL') ?? 'mongodb://localhost:27017/homelab',
  // optional account of MongoDB (compose: MONGO_USERNAME / MONGO_PASSWORD of the .env); authSource: where it is defined
  // (admin for the root account the mongo image creates)
  mongoUsername: env('MONGO_USERNAME'),
  mongoPassword: env('MONGO_PASSWORD'),
  mongoAuthSource: env('MONGO_AUTH_SOURCE') ?? 'admin',
  webDir: env('WEB_DIR') ?? resolve(here, '../../web/dist'),
  agentBinDir: env('AGENT_BIN_DIR') ?? resolve(here, '../../agent/dist'),
  assetsDir: resolve(here, '../assets'),
  sessionDays: num('SESSION_DAYS', 30),
  cookieSecure: cookieSecure(),
  // set when the hub sits behind a reverse proxy (X-Forwarded-* headers)
  trustProxy: parseTrustProxy(env('TRUST_PROXY')),
  // optional TLS port of the UI (uiTls.ts), next to the http one: 0 = off
  httpsPort: num('HTTPS_PORT', 0),
  // port the browsers reach it at, when it is published on another one (the http port redirects there)
  httpsPublicPort: num('HTTPS_PUBLIC_PORT', 0),
  // certificate and key of the UI, as files (PEM); unset: issued by the CA of the hub
  httpsCertFile: env('HTTPS_CERT_FILE'),
  httpsKeyFile: env('HTTPS_KEY_FILE'),
  // more names / IP of the issued certificate
  httpsSan: list('HTTPS_SAN'),
  // the http port while the TLS one is on: redirect (pages to https, logins refused) or local (127.0.0.1 only)
  httpMode: env('HTTP_MODE') === 'local' ? ('local' as const) : ('redirect' as const),
  // Nextcloud AIO plugin of the backups (homelab#148): particular to one setup, hidden unless set
  featureBackupNextcloudAio: env('FEATURE_BACKUP_NEXTCLOUD_AIO') === 'true',
  // release channel: the dev and prod images are the same one (promoted as is), so only the deployment tells them apart
  channel: env('CHANNEL') === 'dev' ? ('dev' as const) : ('prod' as const),
  // standardisation of the hosts (setup.ts): hidden and inactive unless set
  featureStandardisation: env('FEATURE_STANDARDISATION') === 'true',
  // folder (read only) where the signed access manifest is dropped by `make access-publish` (accessFile.ts)
  accessDir: env('ACCESS_DIR') ?? '/access',
};
