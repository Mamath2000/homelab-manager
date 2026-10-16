import type { FastifyInstance } from 'fastify';
import { hosts } from '../db.js';
import { summarize } from '../summary.js';

export function registerSummaryRoutes(app: FastifyInstance) {
  // flat counters, meant for dashboards (Homepage customapi); every role reads
  app.get('/api/summary', async () => summarize(await hosts.find().toArray()));
}
