import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { registerAgentSocket } from './agents.js';
import { registerAuth } from './auth.js';
import { config } from './config.js';
import { closeDb, connectDb } from './db.js';
import { registerEvents } from './events.js';
import { flushLogs, recoverJobs } from './jobs.js';
import { registerHostRoutes } from './routes/hosts.js';
import { registerInstallRoutes } from './routes/install.js';
import { registerJobRoutes } from './routes/jobs.js';
import { loadHomeAssistantSettings, registerAgentSettingsRoutes, registerSettingsRoutes } from './routes/settings.js';
import { HomeAssistantBridge } from './homeassistant/bridge.js';
import { startScheduler } from './scheduler.js';

// forceCloseConnections: app.close() also drops the hijacked SSE streams instead of waiting for clients.
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  trustProxy: config.trustProxy,
  forceCloseConnections: true,
});

await connectDb();
await recoverJobs();

await app.register(cookie);
await app.register(websocket, { options: { maxPayload: 1 << 20 } });

registerAuth(app);
registerEvents(app);
registerHostRoutes(app);
registerJobRoutes(app);
registerInstallRoutes(app);
const bridge = new HomeAssistantBridge(app.log);
registerSettingsRoutes(app, bridge);
registerAgentSettingsRoutes(app, bridge);
registerAgentSocket(app);
app.get('/api/health', async () => ({ ok: true, version: config.version }));

// Serve the built React UI, with SPA fallback for client-side routes.
const hasWeb = existsSync(config.webDir);
if (hasWeb) await app.register(fastifyStatic, { root: config.webDir });
app.setNotFoundHandler((req, reply) => {
  if (hasWeb && req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/agent/')) {
    return reply.sendFile('index.html');
  }
  return reply.code(404).send({ error: 'not found' });
});

const flushTimer = setInterval(() => flushLogs().catch((err) => app.log.error({ err }, 'log flush failed')), 2000);
const stopScheduler = startScheduler(app.log);
await bridge.apply(await loadHomeAssistantSettings());

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(flushTimer);
  stopScheduler();
  await bridge.stop(false);
  await flushLogs().catch(() => {});
  await app.close();
  await closeDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
