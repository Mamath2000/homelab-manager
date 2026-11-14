import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hosts, parseId } from '../db.js';
import { trackStream } from '../events.js';
import { hostKey, LOG_FIELDS, logRole, logRoles, LogServerError, MAX_LIMIT, queryContext, queryFieldValues, queryHits, queryLogs, queryMatrix, querySenders, tailLogs, type LogField, type LogFilters, type LogRange, type LogRow } from '../logs.js';
import type { LogServerRole } from '../types.js';

// Journals of the hosts, read on a log server (logs.ts). Admins and operators (profiles.ts), never an API key: a journal
// may hold a secret. Without a log server role, the routes do not exist (404).

// a date as the browser sends it (toISOString) or as a row carries it (nanoseconds: the cursor of the next page), or a
// time back from now
const TIME_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;
const SPAN_RE = /^(\d{1,4})([mhd])$/;
const UNIT_MS = { m: 60_000, h: 3600_000, d: 86_400_000 } as const;

const list = { type: 'string', maxLength: 4096 } as const;
const filterProps = {
  role: { type: 'string', maxLength: 32 },
  // hosts of the hub (ids), or names as the journals carry them (a sender the hub does not know)
  host: list,
  hostname: list,
  site: { type: 'string', maxLength: 24 },
  tag: { type: 'string', maxLength: 24 },
  // worst severity kept (0 emerg … 7 debug)
  severity: { type: 'integer', minimum: 0, maximum: 7 },
  app: list,
  facility: list,
  source: list,
  q: { type: 'string', maxLength: 512 },
  notApp: list,
  notHostname: list,
} as const;
const rangeProps = { from: { type: 'string', maxLength: 40 }, to: { type: 'string', maxLength: 40 } } as const;

interface FilterQuery {
  role?: string;
  host?: string;
  hostname?: string;
  site?: string;
  tag?: string;
  severity?: number;
  app?: string;
  facility?: string;
  source?: string;
  q?: string;
  notApp?: string;
  notHostname?: string;
}
interface RangeQuery {
  from?: string;
  to?: string;
}

const split = (v: string | undefined) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200) : []);

class BadRequest extends Error {}

// The range of a request: from a date or a time back from now (default: one hour), to a date (default: now).
export function rangeOf(q: RangeQuery, now = Date.now()): LogRange & { startMs: number; endMs: number } {
  const from = q.from ?? '1h';
  const span = SPAN_RE.exec(from);
  if (!span && !TIME_RE.test(from)) throw new BadRequest('from invalide');
  if (q.to !== undefined && !TIME_RE.test(q.to)) throw new BadRequest('to invalide');
  const endMs = q.to ? Date.parse(q.to) : now;
  const startMs = span ? endMs - Number(span[1]) * UNIT_MS[span[2] as keyof typeof UNIT_MS] : Date.parse(from);
  if (!(startMs < endMs)) throw new BadRequest('période vide');
  return { start: span ? new Date(startMs).toISOString() : from, ...(q.to ? { end: q.to } : {}), startMs, endMs };
}

// The step of the histogram: about sixty bars over the range, on a round duration.
const STEPS: [number, string][] = [
  [15_000, '15s'], [60_000, '1m'], [5 * 60_000, '5m'], [15 * 60_000, '15m'], [30 * 60_000, '30m'],
  [3600_000, '1h'], [3 * 3600_000, '3h'], [6 * 3600_000, '6h'], [12 * 3600_000, '12h'], [86_400_000, '1d'],
];
export const stepOf = (spanMs: number) => (STEPS.find(([ms]) => spanMs / ms <= 60) ?? STEPS[STEPS.length - 1])[1];

type KnownHost = { id: string; name: string; hostname: string; siteId?: string; tags?: string[] };

// The hosts of the hub by the name their journals carry.
async function knownHosts(): Promise<KnownHost[]> {
  const docs = await hosts.find({}, { projection: { name: 1, 'info.hostname': 1, siteId: 1, tags: 1 } }).toArray();
  return docs.map((h) => ({ id: h._id.toHexString(), name: h.name, hostname: h.info?.hostname ?? '', siteId: h.siteId?.toString(), tags: h.tags }));
}

// The filters of a request as the server takes them. The hosts of the hub are named by their id, a site or a tag is
// the hosts it holds; null: the selection holds no host that can send (nothing to return).
export function filtersOf(q: FilterQuery, known: KnownHost[]): LogFilters | null {
  const names = new Set(split(q.hostname));
  let narrowed = false;
  const ids = split(q.host);
  if (ids.length || q.site || q.tag) {
    narrowed = true;
    for (const h of known) {
      if (!h.hostname) continue;
      if (ids.length && !ids.includes(h.id)) continue;
      if (q.site && h.siteId !== q.site) continue;
      if (q.tag && !h.tags?.includes(q.tag)) continue;
      names.add(h.hostname);
    }
  }
  if (narrowed && !names.size) return null;
  return {
    ...(names.size ? { hostnames: [...names] } : {}),
    ...(q.severity !== undefined ? { maxSeverity: q.severity } : {}),
    ...(q.app ? { apps: split(q.app) } : {}),
    ...(q.facility ? { facilities: split(q.facility) } : {}),
    ...(q.source ? { sources: split(q.source) } : {}),
    ...(q.q?.trim() ? { text: q.q.trim() } : {}),
    ...(q.notApp || q.notHostname ? { not: { apps: split(q.notApp), hostnames: split(q.notHostname) } } : {}),
  };
}

// Each row with the host of the hub that sent it (null: a sender the hub does not know).
function withHosts(rows: LogRow[], known: KnownHost[]) {
  const byKey = new Map(known.filter((h) => h.hostname).map((h) => [hostKey(h.hostname), h]));
  return rows.map((r) => {
    const h = byKey.get(hostKey(r.hostname));
    return { ...r, hostId: h?.id ?? null, hostName: h?.name ?? r.hostname };
  });
}

// live tails open at once, all accounts together: each one holds a connection to the log server
const MAX_TAILS = 8;
let tails = 0;

export function registerLogRoutes(app: FastifyInstance) {
  // the role of the request (the only one, or the one named), after the checks every route shares
  const serverOf = (req: FastifyRequest, reply: FastifyReply, id?: string): LogServerRole | null => {
    if (req.apiKey) {
      reply.code(403).send({ error: "les journaux ne sont pas lisibles avec une clé d'API" });
      return null;
    }
    const role = logRole(id);
    if (!role) {
      reply.code(404).send({ error: logRoles().length ? 'serveur de logs inconnu' : 'aucun serveur de logs déclaré (Paramètres › Rôles)' });
      return null;
    }
    return role;
  };
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof BadRequest) return reply.code(400).send({ error: err.message });
    if (err instanceof LogServerError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  // The journals of the range that match, newest first. before: the time of the last row of the previous page.
  app.get<{ Querystring: FilterQuery & RangeQuery & { limit?: number; before?: string } }>(
    '/api/logs',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { ...filterProps, ...rangeProps, limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT }, before: { type: 'string', maxLength: 40 } } } } },
    async (req, reply) => {
      const role = serverOf(req, reply, req.query.role);
      if (!role) return reply;
      try {
        if (req.query.before !== undefined && !TIME_RE.test(req.query.before)) throw new BadRequest('before invalide');
        const range = rangeOf(req.query);
        const known = await knownHosts();
        const filters = filtersOf(req.query, known);
        const limit = req.query.limit ?? 200;
        if (!filters) return { role: role._id, rows: [], more: false };
        // one more row tells whether a next page exists
        const rows = await queryLogs(role.config, filters, { start: range.start, end: req.query.before ?? range.end }, limit + 1);
        return { role: role._id, rows: withHosts(rows.slice(0, limit), known), more: rows.length > limit };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Number of journals per step of time and per severity, over the range.
  app.get<{ Querystring: FilterQuery & RangeQuery }>(
    '/api/logs/hits',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { ...filterProps, ...rangeProps } } } },
    async (req, reply) => {
      const role = serverOf(req, reply, req.query.role);
      if (!role) return reply;
      try {
        const range = rangeOf(req.query);
        const step = stepOf(range.endMs - range.startMs);
        const filters = filtersOf(req.query, await knownHosts());
        if (!filters) return { step, timestamps: [], series: [] };
        return { step, ...(await queryHits(role.config, filters, { start: range.start, end: range.end }, step)) };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Number of journals per source and per severity, over the range. The severity filter is left out: the matrix shows
  // every level, so that a cell can be picked.
  app.get<{ Querystring: FilterQuery & RangeQuery }>(
    '/api/logs/matrix',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { ...filterProps, ...rangeProps } } } },
    async (req, reply) => {
      const role = serverOf(req, reply, req.query.role);
      if (!role) return reply;
      try {
        const range = rangeOf(req.query);
        const filters = filtersOf({ ...req.query, severity: undefined }, await knownHosts());
        if (!filters) return { sources: [], cells: [] };
        return await queryMatrix(role.config, filters, { start: range.start, end: range.end });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // The values of a field over the range (applications, facilities), the most frequent first: the choices of a filter.
  // The filter on the field itself is left out, so that its other values stay offered.
  app.get<{ Querystring: FilterQuery & RangeQuery & { field: LogField } }>(
    '/api/logs/fields',
    { schema: { querystring: { type: 'object', required: ['field'], additionalProperties: false, properties: { ...filterProps, ...rangeProps, field: { enum: Object.keys(LOG_FIELDS) } } } } },
    async (req, reply) => {
      const role = serverOf(req, reply, req.query.role);
      if (!role) return reply;
      try {
        const range = rangeOf(req.query);
        const { field } = req.query;
        const q = { ...req.query, ...(field === 'app' ? { app: undefined, notApp: undefined } : field === 'facility' ? { facility: undefined } : {}) };
        const filters = filtersOf(q, await knownHosts());
        if (!filters) return { values: [] };
        return { values: await queryFieldValues(role.config, field, filters, { start: range.start, end: range.end }) };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Who sent journals over the range: the hosts of the hub and the senders it does not know, with their last journal.
  app.get<{ Querystring: { role?: string; from?: string } }>(
    '/api/logs/sources',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { role: filterProps.role, from: rangeProps.from } } } },
    async (req, reply) => {
      const role = serverOf(req, reply, req.query.role);
      if (!role) return reply;
      try {
        const range = rangeOf({ from: req.query.from ?? '1d' });
        const [senders, known] = await Promise.all([querySenders(role.config, range.start), knownHosts()]);
        const byKey = new Map(known.filter((h) => h.hostname).map((h) => [hostKey(h.hostname), h]));
        return {
          role: role._id,
          sources: senders
            .map((s) => ({ ...s, hostId: byKey.get(hostKey(s.hostname))?.id ?? null, hostName: byKey.get(hostKey(s.hostname))?.name ?? s.hostname }))
            .sort((a, b) => a.hostName.localeCompare(b.hostName)),
        };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // What surrounds a journal on its host: the rows before and after it, oldest first.
  app.get<{ Querystring: { role?: string; hostname: string; time: string; before?: number; after?: number } }>(
    '/api/logs/context',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['hostname', 'time'],
          additionalProperties: false,
          properties: { role: filterProps.role, hostname: { type: 'string', minLength: 1, maxLength: 253 }, time: { type: 'string', maxLength: 40 }, before: { type: 'integer', minimum: 0, maximum: 200 }, after: { type: 'integer', minimum: 0, maximum: 200 } },
        },
      },
    },
    async (req, reply) => {
      const role = serverOf(req, reply, req.query.role);
      if (!role) return reply;
      try {
        if (!TIME_RE.test(req.query.time)) throw new BadRequest('time invalide');
        const rows = await queryContext(role.config, req.query.hostname, req.query.time, req.query.before ?? 20, req.query.after ?? 20);
        return { rows: withHosts(rows, await knownHosts()) };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Live tail (Server-Sent Events): every journal that matches the filters, as the server receives it.
  app.get<{ Querystring: FilterQuery }>(
    '/api/logs/tail',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: filterProps } } },
    async (req, reply) => {
      const role = serverOf(req, reply, req.query.role);
      if (!role) return reply;
      const known = await knownHosts();
      const filters = filtersOf(req.query, known);
      if (tails >= MAX_TAILS) return reply.code(429).send({ error: 'trop de suivis en direct ouverts : en fermer un' });
      tails++;
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 5000\n\n');
      const abort = new AbortController();
      const keepalive = setInterval(() => res.write(': ping\n\n'), 25_000);
      const untrack = trackStream(req, '/api/logs/tail', () => res.end());
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        tails--;
        clearInterval(keepalive);
        untrack();
        abort.abort();
      };
      req.raw.on('close', close);
      // a selection without any sender: the stream stays open and empty
      if (!filters) return;
      tailLogs(role.config, filters, (row) => res.write(`data: ${JSON.stringify(withHosts([row], known)[0])}\n\n`), abort.signal)
        .then(
          () => res.write(`event: end\ndata: ${JSON.stringify({ error: 'le serveur de logs a fermé le suivi' })}\n\n`),
          (err) => {
            if (!abort.signal.aborted) res.write(`event: end\ndata: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
          },
        )
        .finally(() => {
          // the browser reconnects by itself (retry)
          if (!closed) res.end();
        });
    },
  );
}
