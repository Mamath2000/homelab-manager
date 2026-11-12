import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ObjectId } from 'mongodb';
import { apiKeys, sessions, users } from './db.js';
import { authorize } from './profiles.js';
import type { UserDoc } from './types.js';

type Listener = (event: string, data: unknown) => void;
const listeners = new Set<Listener>();

export function publish(event: string, data: unknown) {
  for (const l of listeners) l(event, data);
}

// In-process subscribers (e.g. the Home Assistant bridge); returns the unsubscribe function.
export function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// An open stream is authenticated once, when it opens: it is closed as soon as what it was opened with goes away.
interface Stream {
  end: () => void;
  userId: ObjectId;
  profile: UserDoc['profile'];
  // the credential of the request: a session (its id) or an API key
  sessionId?: string;
  apiKeyId?: ObjectId;
  // the route it was opened on: what the account must still be allowed to read
  route: string;
}
const streams = new Set<Stream>();

// Re-checked while a stream stays open, in case a closing was missed (expired session, key or account removed in the database).
export const REVALIDATE_MS = 60_000;

// Closes the streams opened by an account, with a session or with a key; the browser reconnects and gets a 401.
export function closeStreams(match: { userId?: ObjectId; sessionId?: string; apiKeyId?: ObjectId }) {
  for (const s of [...streams]) {
    if (
      (match.userId && s.userId.equals(match.userId)) ||
      (match.sessionId && s.sessionId === match.sessionId) ||
      (match.apiKeyId && s.apiKeyId?.equals(match.apiKeyId))
    ) {
      s.end();
    }
  }
}

async function stillAllowed(s: Stream) {
  const credential = s.apiKeyId
    ? await apiKeys.findOne({ _id: s.apiKeyId })
    : await sessions.findOne({ _id: s.sessionId!, expiresAt: { $gt: new Date() } });
  if (!credential) return false;
  const user = await users.findOne({ _id: s.userId });
  return !!user && user.profile === s.profile && authorize(user.profile, 'GET', s.route);
}

// A stream opened by a request (the live events, the live tail of the journals): closed with its credential like the
// others, and checked again while it stays open. Returns what to call when the request closes.
export function trackStream(req: FastifyRequest, route: string, end: () => void) {
  const user = req.user!;
  const stream: Stream = { end, userId: user._id, profile: user.profile, sessionId: req.sessionId, apiKeyId: req.apiKey?.id, route };
  const revalidate = setInterval(() => {
    stillAllowed(stream).then(
      (ok) => ok || stream.end(),
      (err) => req.log.warn({ err }, 'events: revalidation failed'),
    );
  }, REVALIDATE_MS);
  streams.add(stream);
  return () => {
    clearInterval(revalidate);
    streams.delete(stream);
  };
}

// Server-Sent Events stream used by the UI for live updates.
export function registerEvents(app: FastifyInstance) {
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const listener: Listener = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const keepalive = setInterval(() => res.write(': ping\n\n'), 25_000);
    const untrack = trackStream(req, '/api/events', () => res.end());
    listeners.add(listener);
    req.raw.on('close', () => {
      clearInterval(keepalive);
      untrack();
      listeners.delete(listener);
    });
  });
}
