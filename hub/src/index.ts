import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { registerAuth } from './auth.js';
import { config } from './config.js';
import { closeDb, connectDb } from './db.js';
import { migrateGroups } from './catalog.js';
import { migrateEnabled } from './disconnect.js';
import { registerEvents, subscribe } from './events.js';
import { flushLogs, recoverJobs } from './jobs.js';
import { bootstrapSuperadmin } from './superadmin.js';
import { registerHostRoutes } from './routes/hosts.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerSiteRoutes } from './routes/sites.js';
import { registerProbeRoutes } from './routes/probes.js';
import { registerRoleRoutes } from './routes/roles.js';
import { loadRoles, migrateHostRoles } from './roles.js';
import { registerEquipmentRoutes } from './routes/equipments.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerBackupRoutes } from './routes/backups.js';
import { registerBackupJobRoutes } from './routes/backupJobs.js';
import { registerOffsiteRoutes } from './routes/offsite.js';
import { registerPbsMountRoutes } from './routes/pbsMount.js';
import { registerNextcloudRoutes } from './routes/nextcloud.js';
import { refreshManaged } from './backupJobs.js';
import { startPbsPoller } from './pbs.js';
import { startOffsitePoller } from './offsite.js';
import { startMountReconciler } from './pbsMount.js';
import { startPvePoller } from './pve.js';
import { startProbes } from './probes.js';
import { registerUserRoutes } from './routes/users.js';
import { registerSummaryRoutes } from './routes/summary.js';
import { registerHealthRoutes } from './health.js';
import { loadHaBridgeSettings, migrateHaBroker, registerAgentSettingsRoutes, registerSettingsRoutes } from './routes/settings.js';
import { registerAgentDownloadRoute } from './routes/install.js';
import { HomeAssistantBridge } from './homeassistant/bridge.js';
import { startScheduler } from './scheduler.js';
import { startAlerts } from './alerts.js';
import { startAgentServer } from './agentServer.js';

// forceCloseConnections: app.close() also drops the hijacked SSE streams instead of waiting for clients.
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  trustProxy: config.trustProxy,
  forceCloseConnections: true,
});

await connectDb();
await migrateGroups();
await migrateEnabled();
await migrateHostRoles();
await loadRoles();
await migrateHaBroker();
await recoverJobs();
await bootstrapSuperadmin();
// groups of the backup jobs: also covers the definitions stored by an older hub
await refreshManaged();

await app.register(cookie);

registerAuth(app);
registerEvents(app);
registerHostRoutes(app);
registerJobRoutes(app);
registerSiteRoutes(app);
registerProbeRoutes(app);
registerRoleRoutes(app);
registerEquipmentRoutes(app);
registerSetupRoutes(app);
registerBackupRoutes(app);
registerBackupJobRoutes(app);
registerOffsiteRoutes(app);
registerPbsMountRoutes(app);
registerNextcloudRoutes(app);
registerUserRoutes(app);
registerSummaryRoutes(app);
registerHealthRoutes(app);
const bridge = new HomeAssistantBridge(app.log);
registerSettingsRoutes(app, bridge);
registerAgentSettingsRoutes(app, bridge);
registerAgentDownloadRoute(app);
app.get('/api/health', async () => ({ ok: true, version: config.version }));
// The agents moved to the TLS port: an old install / upgrade command fails with an explanation
// instead of piping the UI page into sh.
app.get('/install.sh', (_req, reply) =>
  reply
    .type('text/x-shellscript')
    .send(
      `#!/bin/sh\necho "error: the agents now use the TLS port of the hub: copy the install command from the hub UI (Hôtes > hôte > Nouvelle commande d'installation)" >&2\nexit 1\n`,
    ),
);

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
const stopAlerts = startAlerts(app.log);
const stopPbsPoller = startPbsPoller(app.log);
const stopOffsitePoller = startOffsitePoller(app.log);
const stopMountReconciler = startMountReconciler(app.log);
const stopPvePoller = startPvePoller(app.log);
const stopProbes = startProbes(app.log);
await bridge.apply(await loadHaBridgeSettings());
// the broker role of the bridge changed (edited, moved, its host got other IPs): apply does nothing when the address and
// account are the same
subscribe((event) => {
  if (event === 'probe.config') loadHaBridgeSettings().then((s) => bridge.apply(s), (err) => app.log.error({ err }, 'Home Assistant: broker role'));
});

let agentServer: Awaited<ReturnType<typeof startAgentServer>> | null = null;
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(flushTimer);
  stopScheduler();
  stopAlerts();
  stopPbsPoller();
  stopOffsitePoller();
  stopMountReconciler();
  stopPvePoller();
  stopProbes();
  await bridge.stop(false);
  await flushLogs().catch(() => {});
  await app.close();
  await agentServer?.close();
  await closeDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
agentServer = await startAgentServer();
