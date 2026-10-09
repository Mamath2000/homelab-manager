import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { agentUrl } from '../hubUrl.js';
import { loadPki } from '../pkiStore.js';

const ARCHES = new Set(['amd64', 'arm64']);

// Served on the TLS agent port only: the install command pins its certificate.
export function registerInstallRoutes(app: FastifyInstance) {
  const template = readFileSync(join(config.assetsDir, 'install.sh'), 'utf8');

  // Generic installer: the single-use enrollment code is passed as argument when it is run.
  app.get('/install.sh', async (req, reply) => {
    const url = await agentUrl(req);
    if (!url) return reply.code(400).send('# invalid hub url, set it in the agent settings\n');
    const pki = await loadPki();
    reply.type('text/x-shellscript; charset=utf-8');
    return template.replaceAll('__HUB_URL__', url).replaceAll('__PIN__', pki.serverPin).replaceAll('__CA_PEM__', pki.caCert.trim());
  });

  app.get<{ Params: { arch: string } }>('/agent/download/:arch', async (req, reply) => {
    if (!ARCHES.has(req.params.arch)) return reply.code(404).send({ error: 'unsupported architecture' });
    const file = join(config.agentBinDir, `homelab-agent-linux-${req.params.arch}`);
    if (!existsSync(file)) return reply.code(404).send({ error: 'agent binary not built' });
    reply.type('application/octet-stream');
    reply.header('Content-Disposition', 'attachment; filename="homelab-agent"');
    return reply.send(createReadStream(file));
  });
}
