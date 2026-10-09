import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { safeEqualHex, sha256 } from './crypto.js';
import { hosts, parseId } from './db.js';
import { publish } from './events.js';
import { hostDto, summarize } from './hostDto.js';
import { appendJobLog, failRunningJobs, finishJob } from './jobs.js';
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

export function disconnectAgent(hostId: string) {
  connections.get(hostId)?.close(4001, 'revoked');
}

// Agent token format: "<hostId>.<secret>"; only sha256(secret) is stored.
async function authenticate(header: string | undefined) {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const [id, secret] = token.split('.');
  const _id = id ? parseId(id) : null;
  if (!_id || !secret) return null;
  const host = await hosts.findOne({ _id });
  return host && safeEqualHex(host.tokenHash, sha256(secret)) ? host : null;
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
  report?: unknown;
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
        const host = await authenticate(req.headers.authorization);
        if (!host) return reply.code(401).send({ error: 'invalid agent token' });
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
                { $set: { info: msg.info, agentVersion: msg.version, lastSeenAt: new Date() } },
              );
              await emitHost(host._id);
              break;
            case 'apt_report':
              if (!isReport(msg.report)) return;
              await hosts.updateOne(
                { _id: host._id },
                { $set: { apt: msg.report, aptSummary: summarize(msg.report), lastSeenAt: new Date() } },
              );
              await emitHost(host._id);
              break;
            case 'job_log':
              if (msg.jobId && typeof msg.data === 'string') appendJobLog(msg.jobId, id, msg.data);
              break;
            case 'job_done':
              if (msg.jobId) await finishJob(msg.jobId, id, msg.exitCode ?? 0, msg.error);
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
