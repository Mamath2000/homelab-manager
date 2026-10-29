import type { FastifyInstance } from 'fastify';
import { backups, hosts } from '../db.js';
import { hostProbes } from '../probes.js';
import { summarize } from '../summary.js';

export function registerSummaryRoutes(app: FastifyInstance) {
  // flat counters, meant for dashboards (Homepage customapi); every profile reads
  app.get('/api/summary', async () => summarize(await hosts.find().toArray(), await backups.find({ hostId: { $ne: null } }).toArray(), Date.now(), await hostProbes()));
}
