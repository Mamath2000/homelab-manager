import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { TLSSocket } from 'node:tls';
import type { FastifyRequest } from 'fastify';
import { hosts } from './db.js';
import { publish } from './events.js';
import { hostDto, summarize } from './hostDto.js';
import { maybeAutoUpdate } from './agentUpdate.js';
import { recentlyInstalled } from './installed.js';
import { appendJobLog, failRunningJobs, finishJob } from './jobs.js';
import { checkHostSetup, onAgentHello } from './setup.js';
import { isDockerReport, isDockerUpdates } from './docker.js';
import { randomUUID } from 'node:crypto';
import type { AptReport, HostDoc, HostInfo } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    agentHost?: HostDoc;
  }
}

const connections = new Map<string, WebSocket>();

export function isOnline(hostId: string) {
  return connections.has(hostId);
}

export function sendToAgent(hostId: string, msg: unknown) {
  const ws = connections.get(hostId);
  if (!ws || ws.readyState !== ws.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

// Requests answered by the agent outside the job queue (logs, compose files...).
interface Pending {
  hostId: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}
const pending = new Map<string, Pending>();

export class AgentRequestError extends Error {}

export function agentRequest<T>(hostId: string, op: string, params: Record<string, unknown>, timeoutMs = 25_000): Promise<T> {
  const reqId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new AgentRequestError("l'agent n'a pas répondu à temps"));
    }, timeoutMs);
    pending.set(reqId, { hostId, resolve: resolve as (v: unknown) => void, reject, timer });
    if (!sendToAgent(hostId, { type: 'rpc', reqId, op, ...params })) {
      clearTimeout(timer);
      pending.delete(reqId);
      reject(new AgentRequestError('hôte hors ligne'));
    }
  });
}

function settle(hostId: string, reqId: string | undefined, result: unknown, error?: string) {
  const p = reqId ? pending.get(reqId) : undefined;
  if (!p || p.hostId !== hostId) return;
  pending.delete(reqId!);
  clearTimeout(p.timer);
  if (error) p.reject(new AgentRequestError(error));
  else p.resolve(result);
}

function failPending(hostId: string) {
  for (const [reqId, p] of pending) if (p.hostId === hostId) settle(hostId, reqId, null, 'agent déconnecté');
}

export function disconnectAgent(hostId: string) {
  connections.get(hostId)?.close(4001, 'revoked');
}

// Mutual TLS: the client certificate must be issued by the hub CA (checked by the TLS layer) and
// be the one currently recorded for a host (revocation = the fingerprint is removed).
async function authenticate(req: FastifyRequest) {
  const socket = req.raw.socket as TLSSocket;
  if (!socket.encrypted || !socket.authorized) return null;
  const cert = socket.getPeerCertificate();
  if (!cert?.fingerprint256) return null;
  const fingerprint = cert.fingerprint256.replaceAll(':', '').toLowerCase();
  return hosts.findOne({ certFingerprint: fingerprint });
}

async function emitHost(hostId: HostDoc['_id']) {
  const h = await hosts.findOne({ _id: hostId });
  if (h) publish('host', hostDto(h));
}

function isReport(r: unknown): r is AptReport {
  const x = r as AptReport;
  return !!x && Array.isArray(x.upgradable) && Array.isArray(x.held) && typeof x.checkedAt === 'number';
}

interface AgentMessage {
  type: string;
  version?: string;
  info?: HostInfo;
  capabilities?: unknown;
  binaryHash?: unknown;
  report?: unknown;
  docker?: unknown;
  updates?: unknown;
  reqId?: string;
  result?: unknown;
  jobId?: string;
  data?: string;
  exitCode?: number;
  error?: string;
}

export function registerAgentSocket(app: FastifyInstance) {
  app.get(
    '/agent/ws',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const host = await authenticate(req);
        if (!host) return reply.code(401).send({ error: 'unknown or revoked agent certificate' });
        req.agentHost = host;
      },
    },
    async (socket, req) => {
      const host = req.agentHost!;
      const id = host._id.toHexString();
      const log = req.log.child({ host: host.name });

      const previous = connections.get(id);
      if (previous) {
        previous.close(4000, 'replaced by a new connection');
        // output of jobs started on the old connection can no longer reach us
        failRunningJobs(id, 'agent reconnected').catch((err) => log.error({ err }, 'failed to close jobs'));
      }
      connections.set(id, socket);
      log.info('agent connected');

      let alive = true;
      socket.on('pong', () => (alive = true));
      const heartbeat = setInterval(() => {
        if (!alive) return socket.terminate();
        alive = false;
        socket.ping();
      }, 30_000);

      socket.on('message', async (raw) => {
        let msg: AgentMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        try {
          switch (msg.type) {
            case 'hello':
              await hosts.updateOne(
                { _id: host._id },
                {
                  $set: {
                    info: msg.info,
                    agentVersion: msg.version,
                    capabilities: Array.isArray(msg.capabilities) ? msg.capabilities.filter((c) => typeof c === 'string') : [],
                    agentHash: typeof msg.binaryHash === 'string' ? msg.binaryHash : '',
                    lastSeenAt: new Date(),
                  },
                },
              );
              await emitHost(host._id);
              await maybeAutoUpdate(host._id);
              // answered through this socket: not awaited
              onAgentHello(host._id).catch((err) => log.warn({ err }, 'standardisation check failed'));
              break;
            case 'apt_report':
              if (!isReport(msg.report)) return;
              {
                const current = await hosts.findOne({ _id: host._id }, { projection: { apt: 1, recentlyInstalled: 1 } });
                await hosts.updateOne(
                  { _id: host._id },
                  {
                    $set: {
                      apt: msg.report,
                      aptSummary: summarize(msg.report),
                      recentlyInstalled: recentlyInstalled(current?.apt, msg.report, current?.recentlyInstalled),
                      lastSeenAt: new Date(),
                    },
                  },
                );
              }
              await emitHost(host._id);
              break;
            case 'docker_report':
              if (!isDockerReport(msg.docker)) return;
              await hosts.updateOne({ _id: host._id }, { $set: { docker: msg.docker, lastSeenAt: new Date() } });
              await emitHost(host._id);
              break;
            case 'docker_updates':
              if (!isDockerUpdates(msg.updates)) return;
              await hosts.updateOne({ _id: host._id }, { $set: { dockerUpdates: msg.updates } });
              await emitHost(host._id);
              break;
            case 'rpc_result':
              settle(id, msg.reqId, msg.result, msg.error);
              break;
            case 'job_log':
              if (msg.jobId && typeof msg.data === 'string') appendJobLog(msg.jobId, id, msg.data);
              break;
            case 'job_done':
              if (msg.jobId) {
                const job = await finishJob(msg.jobId, id, msg.exitCode ?? 0, msg.error);
                if (job?.action === 'setup_apply') checkHostSetup(host._id).catch((err) => log.warn({ err }, 'standardisation check failed'));
              }
              break;
          }
        } catch (err) {
          log.error({ err }, 'failed to handle agent message');
        }
      });

      socket.on('close', async () => {
        clearInterval(heartbeat);
        // a reconnect may already have replaced this socket
        if (connections.get(id) !== socket) return;
        connections.delete(id);
        log.info('agent disconnected');
        failPending(id);
        await failRunningJobs(id, 'agent disconnected');
        await hosts.updateOne({ _id: host._id }, { $set: { lastSeenAt: new Date() } });
        await emitHost(host._id);
      });

      // Listeners must be attached before the first await, so this comes last.
      const now = new Date();
      await hosts.updateOne({ _id: host._id }, { $set: { lastSeenAt: now } });
      await hosts.updateOne({ _id: host._id, enrolledAt: { $exists: false } }, { $set: { enrolledAt: now } });
      await emitHost(host._id);
    },
  );
}
