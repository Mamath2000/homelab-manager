import type { FastifyInstance } from 'fastify';

type Listener = (event: string, data: unknown) => void;
const listeners = new Set<Listener>();

export function publish(event: string, data: unknown) {
  for (const l of listeners) l(event, data);
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
    listeners.add(listener);
    req.raw.on('close', () => {
      clearInterval(keepalive);
      listeners.delete(listener);
    });
  });
}
