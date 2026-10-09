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

  // <arch>: the binary; <arch>.sig: its release signature, checked by the agents on self-update
  app.get<{ Params: { file: string } }>('/agent/download/:file', async (req, reply) => {
    const sig = req.params.file.endsWith('.sig');
    const arch = sig ? req.params.file.slice(0, -4) : req.params.file;
    if (!ARCHES.has(arch)) return reply.code(404).send({ error: 'unsupported architecture' });
    const file = join(config.agentBinDir, `homelab-agent-linux-${arch}${sig ? '.sig' : ''}`);
    if (!existsSync(file)) return reply.code(404).send({ error: sig ? 'agent binary not signed' : 'agent binary not built' });
    if (sig) return reply.type('text/plain').send(readFileSync(file, 'utf8'));
    reply.type('application/octet-stream');
    reply.header('Content-Disposition', 'attachment; filename="homelab-agent"');
    return reply.send(createReadStream(file));
  });
}
