import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AGENT_TARGETS, agentBinaryPath, type AgentOs } from '../agentBinaries.js';
import { config } from '../config.js';
import { agentUrlOfRequest } from '../hubUrl.js';
import { loadPki } from '../pkiStore.js';

// Served on the TLS agent port only: the install command pins its certificate.
export function registerInstallRoutes(app: FastifyInstance) {
  const template = readFileSync(join(config.assetsDir, 'install.sh'), 'utf8');

  // Generic installer: the single-use enrollment code is passed as argument when it is run.
  app.get('/install.sh', async (req, reply) => {
    const url = await agentUrlOfRequest(req);
    if (!url) return reply.code(400).send('# invalid hub url, set it in the agent settings\n');
    const pki = await loadPki();
    reply.type('text/x-shellscript; charset=utf-8');
    return template.replaceAll('__HUB_URL__', url).replaceAll('__PIN__', pki.serverPin).replaceAll('__CA_PEM__', pki.caCert.trim());
  });

  // CA of the hub (public), for installers that cannot use install.sh: the HAOS add-on fetches it
  // with the pinned key of the token, before enrolling.
  app.get('/agent/ca.pem', async (_req, reply) => {
    reply.type('application/x-pem-file');
    return `${(await loadPki()).caCert.trim()}\n`;
  });

  // <arch> (Linux) or windows-<arch>: the binary; <file>.sig: its release signature, checked by the agents on self-update
  app.get<{ Params: { file: string } }>('/agent/download/:file', async (req, reply) => {
    const sig = req.params.file.endsWith('.sig');
    const target = parseTarget(sig ? req.params.file.slice(0, -4) : req.params.file);
    if (!target) return reply.code(404).send({ error: 'unsupported architecture' });
    return sendBinary(reply, target, sig);
  });
}

// The Windows binary is downloaded from the UI too: it is installed with the token, by hand.
export function registerAgentDownloadRoute(app: FastifyInstance) {
  app.get('/api/agent/download/windows-amd64', async (_req, reply) => sendBinary(reply, { os: 'windows', arch: 'amd64' }, false));
}

function parseTarget(name: string) {
  const m = /^(?:(linux|windows)-)?(amd64|arm64)$/.exec(name);
  const os = (m?.[1] ?? 'linux') as AgentOs;
  return m && AGENT_TARGETS.some((t) => t.os === os && t.arch === m[2]) ? { os, arch: m[2] } : null;
}

function sendBinary(reply: FastifyReply, { os, arch }: { os: AgentOs; arch: string }, sig: boolean) {
  const file = `${agentBinaryPath(arch, os)}${sig ? '.sig' : ''}`;
  if (!existsSync(file)) return reply.code(404).send({ error: sig ? 'agent binary not signed' : 'agent binary not built' });
  if (sig) return reply.type('text/plain').send(readFileSync(file, 'utf8'));
  reply.type('application/octet-stream');
  reply.header('Content-Disposition', `attachment; filename="homelab-agent${os === 'windows' ? '.exe' : ''}"`);
  return reply.send(createReadStream(file));
}
