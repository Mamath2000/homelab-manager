import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOnline } from '../agents.js';
import { config } from '../config.js';
import { loadSites } from '../catalog.js';
import { equipments, hosts, jobs, parseId } from '../db.js';
import { dockerLogsCard } from '../docker.js';
import { reconcileDockerLogs } from '../dockerLogs.js';
import { publish } from '../events.js';
import { hostDto } from '../hostDto.js';
import { hasRunningJob } from '../jobs.js';
import { applySetup, canSetup, effectiveValues, loadSetupProfile, overridesError } from '../setup.js';
import { trackStream } from '../events.js';
import { loadCutoffs, removeCutoffs, setCutoffs } from '../logCutoffs.js';
import { createRule, deleteRule, InvalidRule, listRules, loadIgnores, MAX_COMMENT, MAX_PATTERN, normalizeMatch, normalizeRule, ruleById, ruleDto, toIgnore, updateRule, type LogIgnoreInput } from '../logIgnores.js';
import { countByHost, countIgnored, hostKey, LOG_FIELDS, logRole, logRoles, LogServerError, MAX_LIMIT, queryContext, queryFieldValues, queryHits, queryLogs, queryMatrix, querySenders, querySources, tailLogs, type LogField, type LogFilters, type LogIgnore, type LogRange, type LogRow } from '../logs.js';
import type { HostDoc, LogServerRole, SetupOverrides, SetupProfile } from '../types.js';

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
  // one or several sites (ids, comma separated)
  site: list,
  tag: { type: 'string', maxLength: 24 },
  // worst severity kept (0 emerg … 7 debug)
  severity: { type: 'integer', minimum: 0, maximum: 7 },
  // worse severities left out (with severity: one level, 4 and 4 keep the warnings only)
  minSeverity: { type: 'integer', minimum: 0, maximum: 7 },
  app: list,
  facility: list,
  source: list,
  q: { type: 'string', maxLength: 512 },
  notApp: list,
  notHostname: list,
  // sub-devices of an ESPHome device (field device), with the lines of the ESP from warning up (deviceSystem)
  device: list,
  deviceSystem: { type: 'boolean' },
  // read the history hidden by host too (homelab#355)
  showMasked: { type: 'boolean' },
  // read the benign messages too (homelab#379); ignoreRule: the lines of that rule only
  showIgnored: { type: 'boolean' },
  ignoreRule: { type: 'string', maxLength: 24 },
} as const;
const rangeProps = { from: { type: 'string', maxLength: 40 }, to: { type: 'string', maxLength: 40 } } as const;

interface FilterQuery {
  role?: string;
  host?: string;
  hostname?: string;
  site?: string;
  tag?: string;
  severity?: number;
  minSeverity?: number;
  app?: string;
  facility?: string;
  source?: string;
  q?: string;
  notApp?: string;
  notHostname?: string;
  device?: string;
  deviceSystem?: boolean;
  showMasked?: boolean;
  showIgnored?: boolean;
  ignoreRule?: string;
}
interface RangeQuery {
  from?: string;
  to?: string;
}

const split = (v: string | undefined) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200) : []);

class BadRequest extends Error {}
class NotFound extends Error {}

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

type KnownHost = { id: string; name: string; hostname: string; siteId?: string; tags?: string[]; ips?: string[] };

// The hosts of the hub by the name their journals carry.
async function knownHosts(): Promise<KnownHost[]> {
  const docs = await hosts.find({}, { projection: { name: 1, 'info.hostname': 1, 'info.ips': 1, siteId: 1, tags: 1 } }).toArray();
  return docs.map((h) => ({ id: h._id.toHexString(), name: h.name, hostname: h.info?.hostname ?? '', siteId: h.siteId?.toString(), tags: h.tags, ips: h.info?.ips ?? [] }));
}

type KnownEquipment = { name: string; ip?: string; siteId?: string };
type Located = { hostname: string; siteId: string };

// The site of each sender of the journals: the host of the hub of that name; else the host or the equipment (an Omada
// one carries its site) at the address it sends from or that it names itself by; else the main site. An ESPHome cannot
// say its site in its syslog: it gets the main one unless it is an equipment.
export function locateSenders(senders: { hostname: string; ip?: string }[], known: KnownHost[], equip: KnownEquipment[], mainSite: string | undefined): Located[] {
  const byName = new Map(known.filter((h) => h.hostname && h.siteId).map((h) => [hostKey(h.hostname), h.siteId!]));
  const byIp = new Map<string, string>();
  for (const h of known) if (h.siteId) for (const ip of h.ips ?? []) byIp.set(ip.split('/')[0], h.siteId);
  const equipByName = new Map<string, string>();
  for (const e of equip) {
    if (!e.siteId) continue;
    if (e.ip) byIp.set(e.ip, e.siteId);
    equipByName.set(hostKey(e.name), e.siteId);
  }
  return senders.flatMap((s) => {
    const siteId = byName.get(hostKey(s.hostname)) ?? byIp.get(s.hostname) ?? equipByName.get(hostKey(s.hostname)) ?? (s.ip ? byIp.get(s.ip) : undefined) ?? mainSite;
    return siteId ? [{ hostname: s.hostname, siteId }] : [];
  });
}

// The senders of a range with their site, kept a little: every panel of the page asks for them at once.
const LOCATE_MS = 30_000;
const located = new Map<string, { at: number; list: Promise<Located[]> }>();
function locatedSenders(role: LogServerRole, range: LogRange, key: string, known: KnownHost[]): Promise<Located[]> {
  const k = `${role._id}|${key}`;
  const now = Date.now();
  for (const [x, v] of located) if (now - v.at > LOCATE_MS) located.delete(x);
  const hit = located.get(k);
  if (hit) return hit.list;
  const list = (async () => {
    const [senders, equip, sites] = await Promise.all([
      querySenders(role.config, range.start, {}, range.end),
      equipments.find({}, { projection: { name: 1, ip: 1, siteId: 1 } }).toArray(),
      loadSites(),
    ]);
    const main = sites.find((s) => s.kind === 'main')?.id ?? sites[0]?.id;
    return locateSenders(senders, known, equip.map((e) => ({ name: e.name, ip: e.ip, siteId: e.siteId })), main);
  })();
  list.catch(() => located.delete(k));
  located.set(k, { at: now, list });
  return list;
}

// The filters of a request as the server takes them. The hosts of the hub are named by their id, a site or a tag is
// the hosts it holds (a site also the senders located there, locateSenders); null: the selection holds no host that can
// send (nothing to return).
export function filtersOf(q: FilterQuery, known: KnownHost[], senders: Located[] = []): LogFilters | null {
  const names = new Set(split(q.hostname));
  let narrowed = false;
  const ids = split(q.host);
  const sites = split(q.site);
  if (ids.length || sites.length || q.tag) {
    narrowed = true;
    for (const h of known) {
      if (!h.hostname) continue;
      if (ids.length && !ids.includes(h.id)) continue;
      if (sites.length && !(h.siteId && sites.includes(h.siteId))) continue;
      if (q.tag && !h.tags?.includes(q.tag)) continue;
      names.add(h.hostname);
    }
    // a sender the hub does not know has no tag and is no host of it
    if (sites.length && !ids.length && !q.tag) {
      const own = new Set(known.filter((h) => h.hostname).map((h) => hostKey(h.hostname)));
      for (const s of senders) if (sites.includes(s.siteId) && !own.has(hostKey(s.hostname))) names.add(s.hostname);
    }
  }
  if (narrowed && !names.size) return null;
  return {
    ...(names.size ? { hostnames: [...names] } : {}),
    ...(q.severity !== undefined ? { maxSeverity: q.severity } : {}),
    ...(q.minSeverity !== undefined ? { minSeverity: q.minSeverity } : {}),
    ...(q.app ? { apps: split(q.app) } : {}),
    ...(q.facility ? { facilities: split(q.facility) } : {}),
    ...(q.source ? { sources: split(q.source) } : {}),
    ...(q.q?.trim() ? { text: q.q.trim() } : {}),
    ...(q.device ? { devices: split(q.device), ...(q.deviceSystem ? { deviceSystem: true } : {}) } : {}),
    ...(q.notApp || q.notHostname ? { not: { apps: split(q.notApp), hostnames: split(q.notHostname) } } : {}),
  };
}

// The filters of a request, the senders of its range located when it names a site.
async function resolveFilters(role: LogServerRole, q: FilterQuery & RangeQuery, known: KnownHost[], range: LogRange) {
  const senders = split(q.site).length ? await locatedSenders(role, range, `${q.from ?? '1h'}|${q.to ?? ''}`, known) : [];
  const filters = filtersOf(q, known, senders);
  if (!filters) return filters;
  // the history hidden by host and the benign messages are left out, unless the page asks for them; the lines of one
  // rule are the ones it hides (whether it is active or not), the other rules left aside
  const [cutoffs, ignores] = await Promise.all([q.showMasked ? undefined : loadCutoffs(), q.showIgnored || q.ignoreRule ? undefined : loadIgnores()]);
  const rule = q.ignoreRule ? await ruleById(q.ignoreRule) : null;
  if (q.ignoreRule && !rule) throw new NotFound('règle inconnue');
  return { ...filters, ...(cutoffs ? { cutoffs } : {}), ...(ignores?.length ? { ignores } : {}), ...(rule ? { ignored: toIgnore(rule) } : {}) };
}

// Each row with the host of the hub that sent it (null: a sender the hub does not know).
function withHosts(rows: LogRow[], known: KnownHost[]) {
  const byKey = new Map(known.filter((h) => h.hostname).map((h) => [hostKey(h.hostname), h]));
  return rows.map((r) => {
    const h = byKey.get(hostKey(r.hostname));
    return { ...r, hostId: h?.id ?? null, hostName: h?.name ?? r.hostname };
  });
}

// --- hosts that send to a log server (Rôles › Logs) ---------------------------------------------------------------

// How a host sends to the server: through the standard value, its own value, or set by hand on the host (the server
// receives from it, the standardisation does not send it there). null: it does not send there.
export function sendMode(p: SetupProfile, h: Pick<HostDoc, 'setupOverrides' | 'capabilities'>, roleId: string): 'standard' | 'custom' | null {
  if (!canSetup(h)) return null;
  const o = h.setupOverrides?.log_forward;
  if (o?.mode === 'custom') return o.value.role === roleId ? 'custom' : null;
  return effectiveValues(p, h.setupOverrides).log_forward?.role === roleId ? 'standard' : null;
}

// The overrides that make a host send to the role (the standard value when it is the role), or send nothing.
export function overridesSending(p: SetupProfile, overrides: SetupOverrides = {}, roleId: string): SetupOverrides {
  const next = { ...overrides };
  const std = p.options.log_forward;
  if (roleId && std.enabled && std.value.role === roleId) delete next.log_forward;
  else next.log_forward = { mode: 'custom', value: { role: roleId } };
  return next;
}

// Why the journals of this host cannot be sent by the standardisation (null: they can).
export function cannotSend(h: Pick<HostDoc, '_id' | 'capabilities'>) {
  if (!config.featureStandardisation) return 'standardisation désactivée sur le hub (FEATURE_STANDARDISATION)';
  if (!h.capabilities?.includes('setup')) return 'pas de standardisation sur cet hôte (Debian / Ubuntu seulement)';
  if (!h.capabilities.includes('log_forward')) return "agent à mettre à jour";
  if (!isOnline(h._id.toHexString())) return 'hôte hors ligne';
  return null;
}

// the journals received from a host over this long are the green of its card: the silent time of the server, a day when
// it watches no silence
const receivingMs = (r: LogServerRole) => (r.config.silentHours || 24) * 3600_000;

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
      reply.code(404).send({ error: logRoles().length ? 'serveur de logs inconnu' : 'aucun serveur de logs déclaré (Rôles)' });
      return null;
    }
    return role;
  };
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof BadRequest || err instanceof InvalidRule) return reply.code(400).send({ error: err.message });
    if (err instanceof NotFound) return reply.code(404).send({ error: err.message });
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
        const filters = await resolveFilters(role, req.query, known, range);
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
        const filters = await resolveFilters(role, req.query, await knownHosts(), range);
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
        const at = { start: range.start, end: range.end };
        const [filters, sources] = await Promise.all([resolveFilters(role, { ...req.query, severity: undefined, minSeverity: undefined }, await knownHosts(), range), querySources(role.config, at)]);
        // the columns are the sources of the whole server: a site that has none of them shows an empty matrix
        const cells = filters ? (await queryMatrix(role.config, filters, at)).cells : [];
        return { sources, cells };
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
        const filters = await resolveFilters(role, q, await knownHosts(), range);
        if (!filters) return { values: [] };
        return { values: await queryFieldValues(role.config, field, filters, { start: range.start, end: range.end }) };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Who sent journals over the range and matches the filters (the page sends the ones of its head: sites, source,
  // severity): the hosts of the hub and the senders it does not know, with their last journal and their errors.
  app.get<{ Querystring: FilterQuery & RangeQuery }>(
    '/api/logs/sources',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { ...filterProps, ...rangeProps } } } },
    async (req, reply) => {
      const role = serverOf(req, reply, req.query.role);
      if (!role) return reply;
      try {
        const range = rangeOf(req.query);
        const known = await knownHosts();
        const filters = await resolveFilters(role, req.query, known, range);
        if (!filters) return { role: role._id, sources: [] };
        const senders = await querySenders(role.config, range.start, filters, range.end);
        const byKey = new Map(known.filter((h) => h.hostname).map((h) => [hostKey(h.hostname), h]));
        return {
          role: role._id,
          sources: senders
            .map(({ ip: _ip, ...s }) => ({ ...s, hostId: byKey.get(hostKey(s.hostname))?.id ?? null, hostName: byKey.get(hostKey(s.hostname))?.name ?? s.hostname }))
            .sort((a, b) => a.hostName.localeCompare(b.hostName)),
        };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // History hidden by host (homelab#355). The hosts are named like a filter of the page (host, hostname, site, tag): the
  // selection must hold at least one, never the whole server by accident.
  const cutoffHosts = async (role: LogServerRole, q: FilterQuery) => {
    const range = rangeOf({ from: '1d' });
    const f = await resolveFilters(role, { ...q, showMasked: true, from: '1d' }, await knownHosts(), range);
    if (!f?.hostnames?.length) throw new BadRequest('aucun hôte sélectionné');
    return f.hostnames;
  };
  const cutoffProps = { type: 'object', additionalProperties: false, properties: { role: filterProps.role, host: list, hostname: list, site: list, tag: filterProps.tag } } as const;
  // « Tout masquer »: every sender the log server holds (retention is 30 d at most by default), not a selection.
  const maskProps = { ...cutoffProps, properties: { ...cutoffProps.properties, all: { type: 'boolean' } } } as const;

  // The cutoffs set, and for a selection how many journals hiding its history would hide (count per host).
  app.get<{ Querystring: Pick<FilterQuery, 'role' | 'host' | 'hostname' | 'site' | 'tag'> & { preview?: boolean } }>(
    '/api/logs/cutoffs',
    { schema: { querystring: { ...cutoffProps, properties: { ...cutoffProps.properties, preview: { type: 'boolean' } } } } },
    async (req, reply) => {
      const role = serverOf(req, reply, req.query.role);
      if (!role) return reply;
      try {
        const cutoffs = await loadCutoffs();
        if (!req.query.preview) return { cutoffs };
        const names = await cutoffHosts(role, req.query);
        const counts = await countByHost(role.config, { hostnames: names, cutoffs });
        return { cutoffs, hosts: names.map((hostname) => ({ hostname, count: counts.get(hostname) ?? 0 })) };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Hide the history of the hosts before now (or move the cutoff). Admins, audit (no passkey: nothing is deleted).
  app.put<{ Body: Pick<FilterQuery, 'role' | 'host' | 'hostname' | 'site' | 'tag'> & { all?: boolean } }>(
    '/api/logs/cutoffs',
    { schema: { body: maskProps } },
    async (req, reply) => {
      const role = serverOf(req, reply, req.body.role);
      if (!role) return reply;
      try {
        const names = req.body.all ? (await querySenders(role.config, '30d')).map((x) => x.hostname) : await cutoffHosts(role, req.body);
        if (!names.length) throw new BadRequest('aucun hôte à masquer');
        await setCutoffs(names, req.user?.username ?? null);
        req.auditNote = { details: { hostnames: names } };
        return { cutoffs: await loadCutoffs() };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Show the history again: the hosts of the selection, or every host without selection.
  app.delete<{ Querystring: Pick<FilterQuery, 'role' | 'host' | 'hostname' | 'site' | 'tag'> }>(
    '/api/logs/cutoffs',
    { schema: { querystring: cutoffProps } },
    async (req, reply) => {
      const role = serverOf(req, reply, req.query.role);
      if (!role) return reply;
      try {
        const selected = req.query.host || req.query.hostname || req.query.site || req.query.tag;
        const names = selected ? await cutoffHosts(role, req.query) : [];
        await removeCutoffs(names);
        req.auditNote = { details: { hostnames: names.length ? names : 'all' } };
        return { cutoffs: await loadCutoffs() };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Benign messages left out of the journals (homelab#379). The rules are the same for every log server; their counts are
  // read on the server of the request, over its range. Written by admins (profiles.ts), audited; nothing is deleted.
  const ruleProps = {
    pattern: { type: 'string', maxLength: MAX_PATTERN },
    regex: { type: 'boolean' },
    hostnames: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 253 } },
    apps: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 253 } },
  } as const;
  const ruleBody = { type: 'object', required: ['pattern', 'comment'], additionalProperties: false, properties: { role: filterProps.role, ...ruleProps, comment: { type: 'string', maxLength: MAX_COMMENT }, enabled: { type: 'boolean' } } } as const;
  type RuleBody = Partial<LogIgnoreInput> & { role?: string };

  // A pattern the server cannot read is refused here rather than breaking every query of the page: a query of the
  // rule over a short range. A server that does not answer lets it through (checked again by the first query).
  const checkOnServer = async (role: LogServerRole, rule: LogIgnore) => {
    try {
      await countIgnored(role.config, [rule], { start: '5m' });
    } catch (err) {
      if (err instanceof LogServerError && err.upstream === 400) throw new InvalidRule(`motif refusé par le serveur de logs (syntaxe RE2) : ${err.message.replace(/^.*?répond 400 : /, '')}`);
    }
  };

  // The rules, with the lines each one matches over the range (countError: the counts could not be read).
  app.get<{ Querystring: { role?: string } & RangeQuery }>(
    '/api/logs/ignore-rules',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { role: filterProps.role, ...rangeProps } } } },
    async (req, reply) => {
      const role = serverOf(req, reply, req.query.role);
      if (!role) return reply;
      try {
        const range = rangeOf(req.query);
        const rules = await listRules();
        let counts: number[] = [];
        let countError: string | null = null;
        try {
          counts = await countIgnored(role.config, rules.map(toIgnore), { start: range.start, end: range.end });
        } catch (err) {
          countError = (err as Error).message;
        }
        return { rules: rules.map((r, i) => ({ ...ruleDto(r), count: counts[i] ?? null })), countError };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // What a rule being typed would hide over the range: its count and its newest lines (and whether the server reads it).
  app.post<{ Body: Omit<RuleBody, 'comment' | 'enabled'> & RangeQuery }>(
    '/api/logs/ignore-rules/preview',
    { schema: { body: { type: 'object', required: ['pattern'], additionalProperties: false, properties: { role: filterProps.role, ...ruleProps, ...rangeProps } } } },
    async (req, reply) => {
      const role = serverOf(req, reply, req.body.role);
      if (!role) return reply;
      try {
        const range = rangeOf(req.body);
        const rule = toIgnore(normalizeMatch(req.body));
        const at = { start: range.start, end: range.end };
        const [[count], rows] = await Promise.all([countIgnored(role.config, [rule], at), queryLogs(role.config, { ignored: rule }, at, 5)]);
        return { count, rows: withHosts(rows, await knownHosts()) };
      } catch (err) {
        if (err instanceof LogServerError && err.upstream === 400) return reply.code(400).send({ error: `motif refusé par le serveur de logs (syntaxe RE2) : ${err.message.replace(/^.*?répond 400 : /, '')}` });
        return fail(reply, err);
      }
    },
  );

  app.post<{ Body: RuleBody }>('/api/logs/ignore-rules', { schema: { body: ruleBody } }, async (req, reply) => {
    const role = serverOf(req, reply, req.body.role);
    if (!role) return reply;
    try {
      const input = normalizeRule(req.body);
      await checkOnServer(role, toIgnore(input));
      const doc = await createRule(input, req.user?.username ?? null);
      req.auditNote = { details: { id: doc._id.toHexString(), pattern: input.pattern, regex: input.regex, hostnames: input.hostnames, apps: input.apps } };
      reply.code(201);
      return ruleDto(doc);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put<{ Params: { id: string }; Body: RuleBody }>('/api/logs/ignore-rules/:id', { schema: { body: ruleBody } }, async (req, reply) => {
    const role = serverOf(req, reply, req.body.role);
    if (!role) return reply;
    try {
      const old = await ruleById(req.params.id);
      if (!old) throw new NotFound('règle inconnue');
      const input = normalizeRule(req.body);
      await checkOnServer(role, toIgnore(input));
      const doc = await updateRule(old._id, input, req.user?.username ?? null);
      if (!doc) throw new NotFound('règle inconnue');
      req.auditNote = { details: { id: req.params.id, pattern: input.pattern, regex: input.regex, hostnames: input.hostnames, apps: input.apps, enabled: input.enabled } };
      return ruleDto(doc);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/logs/ignore-rules/:id', async (req, reply) => {
    if (req.apiKey) return reply.code(403).send({ error: "les journaux ne sont pas lisibles avec une clé d'API" });
    const old = await ruleById(req.params.id);
    if (!old || !(await deleteRule(old._id))) return reply.code(404).send({ error: 'règle inconnue' });
    req.auditNote = { details: { id: req.params.id, pattern: old.pattern, comment: old.comment } };
    return { ok: true };
  });

  // What surrounds a journal on its host: the rows before and after it, oldest first.
  app.get<{ Querystring: { role?: string; hostname: string; time: string; before?: number; after?: number; showMasked?: boolean; showIgnored?: boolean } }>(
    '/api/logs/context',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['hostname', 'time'],
          additionalProperties: false,
          properties: { role: filterProps.role, hostname: { type: 'string', minLength: 1, maxLength: 253 }, time: { type: 'string', maxLength: 40 }, before: { type: 'integer', minimum: 0, maximum: 200 }, after: { type: 'integer', minimum: 0, maximum: 200 }, showMasked: filterProps.showMasked, showIgnored: filterProps.showIgnored },
        },
      },
    },
    async (req, reply) => {
      const role = serverOf(req, reply, req.query.role);
      if (!role) return reply;
      try {
        if (!TIME_RE.test(req.query.time)) throw new BadRequest('time invalide');
        const [cutoffs, ignores] = await Promise.all([req.query.showMasked ? undefined : loadCutoffs(), req.query.showIgnored ? undefined : loadIgnores()]);
        const rows = await queryContext(role.config, req.query.hostname, req.query.time, req.query.before ?? 20, req.query.after ?? 20, cutoffs, ignores);
        return { rows: withHosts(rows, await knownHosts()) };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // The hosts whose journals the hub sends to a server (the standardisation sends them there): only those, whatever else
  // the server receives. state: ok, journals received lately; pending, being installed; drift, to apply; error, the agent
  // cannot apply it; silent, nothing received.
  app.get<{ Params: { role: string } }>('/api/settings/logs/:role/hosts', async (req, reply) => {
    const role = serverOf(req, reply, req.params.role);
    if (!role) return reply;
    const [p, docs] = await Promise.all([loadSetupProfile(), hosts.find({}).toArray()]);
    let senders: Awaited<ReturnType<typeof querySenders>> = [];
    let dockerSenders: typeof senders = [];
    let error: string | null = null;
    try {
      // the journals of the host (rsyslog) apart from the ones of its containers, each with its own state
      [senders, dockerSenders] = await Promise.all([querySenders(role.config, '7d', { not: { sources: ['docker'] } }), querySenders(role.config, '7d', { sources: ['docker'] })]);
    } catch (err) {
      error = (err as Error).message;
    }
    const byKey = new Map(senders.map((s) => [hostKey(s.hostname), s]));
    const dockerByKey = new Map(dockerSenders.map((s) => [hostKey(s.hostname), s]));
    // last job of the collector of each host: its error while nothing is in place
    const lastJobs = new Map<string, { status: string; error?: string }>();
    for (const j of await jobs.find({ action: 'docker_log_collect', createdAt: { $gte: new Date(Date.now() - 30 * 24 * 3600_000) } }, { projection: { hostId: 1, status: 1, error: 1 } }).sort({ createdAt: 1 }).toArray()) {
      lastJobs.set(j.hostId.toHexString(), { status: j.status, error: j.error });
    }
    const now = Date.now();
    const list = docs.flatMap((h) => {
      const mode = sendMode(p, h, role._id);
      const sender = h.info?.hostname ? byKey.get(hostKey(h.info.hostname)) : undefined;
      if (!mode) return [];
      const id = h._id.toHexString();
      const check = h.setup?.modules.find((m) => m.module === 'log_forward');
      const running = hasRunningJob(id);
      const receiving = !!sender && now - sender.lastAt < receivingMs(role);
      // a drift that is not a silence: the option is to apply (or was not applied as it should)
      const unapplied = !!mode && !!check && check.state !== 'ok' && !check.silent;
      const state = receiving ? 'ok' : running ? 'pending' : unapplied ? (check!.state === 'drift' ? 'drift' : 'error') : 'silent';
      return [{
        hostId: id,
        name: h.name,
        siteId: h.siteId?.toString() ?? null,
        online: isOnline(id),
        mode,
        lastAt: sender?.lastAt ?? null,
        count: sender?.count ?? 0,
        state,
        detail: check && check.state !== 'ok' ? (check.detail ?? null) : null,
        running,
        // the journals of its containers go with the ones of the host
        docker: dockerLogsCard(h, {
          lastAt: (h.info?.hostname && dockerByKey.get(hostKey(h.info.hostname))?.lastAt) || null,
          receivingMs: receivingMs(role),
          running: lastJobs.get(id)?.status === 'running',
          lastJob: lastJobs.get(id),
          now,
        }),
      }];
    });
    return { role: role._id, silentHours: role.config.silentHours, error, hosts: list.sort((a, b) => a.name.localeCompare(b.name)) };
  });

  // Makes a host send its journals to the server: its value of the option becomes this server (the standard one when it
  // is), then the option alone is applied (rsyslog installed and configured by its agent).
  app.post<{ Params: { role: string }; Body: { hostId: string } }>(
    '/api/settings/logs/:role/hosts',
    { schema: { body: { type: 'object', required: ['hostId'], additionalProperties: false, properties: { hostId: { type: 'string', maxLength: 24 } } } } },
    async (req, reply) => {
      const role = serverOf(req, reply, req.params.role);
      if (!role) return reply;
      const _id = parseId(req.body.hostId);
      const host = _id && (await hosts.findOne({ _id }));
      if (!host) return reply.code(404).send({ error: 'hôte inconnu' });
      const why = cannotSend(host);
      if (why) return reply.code(409).send({ error: `${host.name} : ${why}` });
      if (hasRunningJob(req.body.hostId)) return reply.code(409).send({ error: `${host.name} : une tâche est déjà en cours` });
      const p = await loadSetupProfile();
      const overrides = overridesSending(p, host.setupOverrides, role._id);
      const bad = overridesError(p, overrides);
      if (bad) return reply.code(400).send({ error: bad });
      const updated = (await hosts.findOneAndUpdate({ _id: host._id }, { $set: { setupOverrides: overrides } }, { returnDocument: 'after' }))!;
      publish('host', hostDto(updated));
      const job = await applySetup(updated, 'manual', ['log_forward']);
      // the journals of its containers follow (run by the agent after this job)
      await reconcileDockerLogs(updated, 'manual', p);
      req.auditNote = { target: { kind: 'host', id: req.body.hostId, name: host.name }, details: { role: role._id, mode: overrides.log_forward ? 'custom' : 'standard' } };
      reply.code(202);
      return { jobId: job._id.toHexString() };
    },
  );

  // Stops the journals of a host: its value becomes « no forwarding », and the agent removes its rsyslog file (now, or at the
  // next application when it is offline). A host set by hand is not touched: its file is not the agent's.
  app.delete<{ Params: { role: string; hostId: string } }>('/api/settings/logs/:role/hosts/:hostId', async (req, reply) => {
    const role = serverOf(req, reply, req.params.role);
    if (!role) return reply;
    const _id = parseId(req.params.hostId);
    const host = _id && (await hosts.findOne({ _id }));
    if (!host) return reply.code(404).send({ error: 'hôte inconnu' });
    const p = await loadSetupProfile();
    if (!sendMode(p, host, role._id)) return reply.code(409).send({ error: `${host.name} n'envoie pas ses journaux par la standardisation : son rsyslog a été réglé à la main` });
    if (hasRunningJob(req.params.hostId)) return reply.code(409).send({ error: `${host.name} : une tâche est déjà en cours` });
    const overrides = overridesSending(p, host.setupOverrides, '');
    const updated = (await hosts.findOneAndUpdate({ _id: host._id }, { $set: { setupOverrides: overrides } }, { returnDocument: 'after' }))!;
    publish('host', hostDto(updated));
    const online = isOnline(req.params.hostId);
    const job = online ? await applySetup(updated, 'manual', ['log_forward']) : null;
    // the journals of its containers stop too (offline: at its next report)
    if (online) await reconcileDockerLogs(updated, 'manual', p);
    req.auditNote = { target: { kind: 'host', id: req.params.hostId, name: host.name }, details: { role: role._id, removed: true, applied: online } };
    return { jobId: job?._id.toHexString() ?? null, applied: online };
  });

  // Live tail (Server-Sent Events): every journal that matches the filters, as the server receives it.
  app.get<{ Querystring: FilterQuery }>(
    '/api/logs/tail',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: filterProps } } },
    async (req, reply) => {
      const role = serverOf(req, reply, req.query.role);
      if (!role) return reply;
      const known = await knownHosts();
      let filters: LogFilters | null;
      try {
        // the senders of the last day give the site of the ones the hub does not know
        filters = await resolveFilters(role, { ...req.query, from: '1d' }, known, rangeOf({ from: '1d' }));
      } catch (err) {
        return fail(reply, err);
      }
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
