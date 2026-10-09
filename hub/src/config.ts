import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  mongoUrl: process.env.MONGO_URL ?? 'mongodb://localhost:27017/homelab',
  // URL the agents use to reach the hub. Derived from the request when unset.
  publicUrl: process.env.PUBLIC_URL?.replace(/\/+$/, ''),
  webDir: process.env.WEB_DIR ?? resolve(here, '../../web/dist'),
  agentBinDir: process.env.AGENT_BIN_DIR ?? resolve(here, '../../agent/dist'),
  assetsDir: resolve(here, '../assets'),
  // how often the hub asks each agent to run `apt-get update`
  checkIntervalHours: Number(process.env.CHECK_INTERVAL_HOURS ?? 12),
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  // set when the hub sits behind a reverse proxy (X-Forwarded-* headers)
  trustProxy: process.env.TRUST_PROXY === 'true',
};
