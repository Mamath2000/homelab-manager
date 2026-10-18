// TLS server for the agents, separate from the UI port: install script, agent binaries,
// enrollment and the WebSocket (mutual TLS). Its certificate is pinned by the install command.
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { registerAgentSocket } from './agents.js';
import { config } from './config.js';
import { loadPki } from './pkiStore.js';
import { registerEnrollRoute } from './routes/enroll.js';
import { registerInstallRoutes } from './routes/install.js';

export async function startAgentServer() {
  const pki = await loadPki();
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    forceCloseConnections: true,
    https: {
      key: pki.serverKey,
      cert: pki.serverCert,
      ca: [pki.caCert],
      minVersion: 'TLSv1.2',
      // the certificate is checked by the WebSocket route only: the install script, the binaries
      // and the enrollment are reached before the agent has one
      requestCert: true,
      rejectUnauthorized: false,
    },
  });
  await app.register(websocket, { options: { maxPayload: 1 << 20 } });
  registerInstallRoutes(app);
  registerEnrollRoute(app);
  registerAgentSocket(app);
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));
  await app.listen({ port: config.agentTlsPort, host: config.host });
  return app;
}
