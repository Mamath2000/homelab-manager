import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Empty variables (e.g. "PUBLIC_URL=" left in a .env file) count as unset.
function env(name: string) {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function num(name: string, fallback: number) {
  const v = Number(env(name) ?? fallback);
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  version: (JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')) as { version: string }).version,
  port: num('PORT', 3000),
  host: env('HOST') ?? '0.0.0.0',
  mongoUrl: env('MONGO_URL') ?? 'mongodb://localhost:27017/homelab',
  // URL the agents use to reach the hub. Derived from the request when unset.
  publicUrl: env('PUBLIC_URL')?.replace(/\/+$/, ''),
  webDir: env('WEB_DIR') ?? resolve(here, '../../web/dist'),
  agentBinDir: env('AGENT_BIN_DIR') ?? resolve(here, '../../agent/dist'),
  assetsDir: resolve(here, '../assets'),
  // how often the hub asks each agent to run `apt-get update`
  checkIntervalHours: num('CHECK_INTERVAL_HOURS', 12),
  sessionDays: num('SESSION_DAYS', 30),
  cookieSecure: env('COOKIE_SECURE') === 'true',
  // set when the hub sits behind a reverse proxy (X-Forwarded-* headers)
  trustProxy: env('TRUST_PROXY') === 'true',
};
