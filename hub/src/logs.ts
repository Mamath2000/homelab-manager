import type { FastifyBaseLogger } from 'fastify';
import { isOnline } from './agents.js';
import { hosts } from './db.js';
import { publish } from './events.js';
import { lanAddress } from './hostAddress.js';
import { hostDto } from './hostDto.js';
import { allRoles } from './roles.js';
import type { HostDoc, LogServerConfig, LogServerRole, SetupCheck } from './types.js';

// Journals of the hosts (homelab#327). The hosts send them in syslog to a log server, a VictoriaLogs carried by a host
// (role log-server); no agent carries a log. The hub is the only one that talks to the server: it builds the LogsQL
// query from the filters of the UI (never a query typed in the browser) and reads the answer through the HTTP API.

export const LOG_URL_RE = /^https?:\/\/[A-Za-z0-9.\-[\]:]+(:\d{1,5})?\/?$/;

export const logRoles = () => allRoles().filter((r): r is LogServerRole => r.type === 'log-server');
export const logRole = (id?: string) => (id ? logRoles().find((r) => r._id === id) : logRoles()[0]);

// Where the hosts send: the address typed for the role, else the first private IP of its host ('' when unknown).
export const logTarget = (c: Pick<LogServerConfig, 'address' | 'port' | 'protocol'>, ips: string[] | null | undefined) => ({
  address: c.address || lanAddress(ips),
  port: c.port,
  protocol: c.protocol,
});
export type LogTarget = ReturnType<typeof logTarget>;

// The target of every log server, for the specs of the standardisation (setup.ts).
export async function logTargets(): Promise<Map<string, LogTarget>> {
  const list = logRoles();
  if (!list.length) return new Map();
  const carriers = await hosts.find({ _id: { $in: list.map((r) => r.carrier.id) } }, { projection: { 'info.ips': 1 } }).toArray();
  const ips = new Map(carriers.map((h) => [h._id.toHexString(), h.info?.ips]));
  return new Map(list.map((r) => [r._id, logTarget(r.config, ips.get(r.carrier.id.toHexString()))]));
}

// --- severities ------------------------------------------------------------------------------------------------------

// syslog severities, 0 the worst; the names VictoriaLogs gives them in its field `level`
export const SEVERITIES = ['emerg', 'alert', 'crit', 'error', 'warning', 'notice', 'info', 'debug'] as const;
export type Severity = (typeof SEVERITIES)[number];
const severityOf = (n: number): Severity => SEVERITIES[Math.min(Math.max(Math.trunc(n), 0), 7)];

// --- LogsQL ----------------------------------------------------------------------------------------------------------

// A value as a quoted LogsQL string: nothing of it is read as syntax.
export const quote = (v: string) => JSON.stringify(v);

export interface LogFilters {
  // host names as the journals carry them (the hostname of the machine)
  hostnames?: string[];
  // worst severity kept: 4 keeps emerg to warning
  maxSeverity?: number;
  apps?: string[];
  facilities?: string[];
  // the category a journal was received as (field `source`, set by the listener of the log server); NO_SOURCE: none
  sources?: string[];
  // words or a phrase looked for in the message, whatever the case
  text?: string;
  // excluded values, by field
  not?: { hostnames?: string[]; apps?: string[] };
}

const anyOf = (field: string, values: string[]) => (values.length === 1 ? `${field}:=${quote(values[0])}` : `${field}:in(${values.map(quote).join(',')})`);

// What the filter and the matrix call a journal without a `source`: received before the log server tagged its listeners,
// or on a listener without a tag.
export const NO_SOURCE = '_none';

const sourceCondition = (values: string[]) => {
  const named = values.filter((v) => v !== NO_SOURCE);
  if (!values.includes(NO_SOURCE)) return anyOf('source', named);
  return named.length ? `(${anyOf('source', named)} or source:"")` : 'source:""';
};

// The filter part of a query: every condition must hold. '*' when there is none.
export function filterQuery(f: LogFilters) {
  const parts: string[] = [];
  if (f.hostnames?.length) parts.push(anyOf('hostname', f.hostnames));
  if (f.maxSeverity !== undefined && f.maxSeverity < 7) parts.push(`severity:<=${Math.max(0, Math.trunc(f.maxSeverity))}`);
  if (f.apps?.length) parts.push(anyOf('app_name', f.apps));
  if (f.facilities?.length) parts.push(anyOf('facility_keyword', f.facilities));
  if (f.sources?.length) parts.push(sourceCondition(f.sources));
  if (f.not?.hostnames?.length) parts.push(`!${anyOf('hostname', f.not.hostnames)}`);
  if (f.not?.apps?.length) parts.push(`!${anyOf('app_name', f.not.apps)}`);
  const text = f.text?.trim();
  // a part of a word matches too ("err" finds "error"): a regular expression of the text itself, nothing of it a pattern
  if (text) parts.push(`_msg:~${quote(`(?i)${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)}`);
  return parts.length ? parts.join(' ') : '*';
}

// --- HTTP client -----------------------------------------------------------------------------------------------------

export class LogServerError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

type Server = Pick<LogServerConfig, 'url' | 'username' | 'password'>;

const headersOf = (c: Server): Record<string, string> => (c.username || c.password ? { Authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}` } : {});

const failure = (err: unknown) => {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  if (e instanceof LogServerError) return e;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return new LogServerError('le serveur de logs ne répond pas (délai dépassé)', 504);
  return new LogServerError(`serveur de logs injoignable : ${e.cause?.code ?? e.cause?.message ?? e.message}`);
};

async function call(c: Server, path: string, params: Record<string, string | number | undefined>, timeoutMs: number, signal?: AbortSignal) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${c.url.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headersOf(c) },
      body,
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  } catch (err) {
    throw failure(err);
  }
  if (res.status === 401 || res.status === 403) throw new LogServerError('le serveur de logs refuse le compte du rôle');
  if (!res.ok) throw new LogServerError(`le serveur de logs répond ${res.status} : ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res;
}

const QUERY_TIMEOUT_MS = 20_000;

// JSON lines: one object per line
const jsonLines = (text: string) =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, string>);

// --- rows ------------------------------------------------------------------------------------------------------------

export interface LogRow {
  // RFC 3339, nanoseconds as the server gives them: also the cursor of the next page
  time: string;
  hostname: string;
  severity: number;
  level: Severity;
  facility: string;
  app: string;
  pid: string;
  message: string;
  // address the server received it from (only when the server records it), and the other fields it kept
  remoteIp?: string;
  fields?: Record<string, string>;
}

// fields of a journal the rows name themselves, or that say nothing (the stream, the format)
const KNOWN = new Set(['_time', '_msg', '_stream', '_stream_id', 'hostname', 'severity', 'level', 'facility', 'facility_keyword', 'app_name', 'proc_id', 'priority', 'format', 'remote_ip', 'msg_id']);
const dash = (v: string | undefined) => (v && v !== '-' ? v : '');

export function toRow(o: Record<string, string>): LogRow {
  const severity = Number.isFinite(Number(o.severity)) && o.severity !== '' && o.severity !== undefined ? Number(o.severity) : 6;
  const extra = Object.entries(o).filter(([k, v]) => !KNOWN.has(k) && v !== '' && v !== '-');
  return {
    time: o._time ?? '',
    hostname: o.hostname ?? '',
    severity,
    level: severityOf(severity),
    facility: o.facility_keyword ?? o.facility ?? '',
    app: dash(o.app_name),
    pid: dash(o.proc_id),
    // rsyslog leaves the space that follows the header
    message: (o._msg ?? '').replace(/^ /, ''),
    ...(o.remote_ip ? { remoteIp: o.remote_ip } : {}),
    ...(extra.length ? { fields: Object.fromEntries(extra) } : {}),
  };
}

export const MAX_LIMIT = 1000;

export interface LogRange {
  // RFC 3339 or a duration back from now ("1h"), as VictoriaLogs reads them; end is exclusive
  start: string;
  end?: string;
}

// The newest rows of the range, newest first (asc: the oldest, oldest first).
export async function queryLogs(c: Server, f: LogFilters, range: LogRange, limit: number, asc = false, signal?: AbortSignal): Promise<LogRow[]> {
  const res = await call(c, '/select/logsql/query', { query: filterQuery(f), start: range.start, end: range.end, limit: Math.min(Math.max(1, limit), MAX_LIMIT), ...(asc ? { sort_direction: 'asc' } : {}), timeout: `${QUERY_TIMEOUT_MS / 1000}s` }, QUERY_TIMEOUT_MS + 2000, signal);
  const rows = jsonLines(await res.text()).map(toRow);
  // the server sorts what it selects, not what it returns
  return rows.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0) * (asc ? 1 : -1));
}

export interface LogHits {
  timestamps: string[];
  // one series per severity seen in the range
  series: { level: Severity; severity: number; values: number[]; total: number }[];
}

// Number of journals per step of time and per severity (the histogram of the page).
export async function queryHits(c: Server, f: LogFilters, range: LogRange, step: string): Promise<LogHits> {
  const res = await call(c, '/select/logsql/hits', { query: filterQuery(f), start: range.start, end: range.end ?? 'now', step, field: 'severity', timeout: `${QUERY_TIMEOUT_MS / 1000}s` }, QUERY_TIMEOUT_MS + 2000);
  const body = (await res.json()) as { hits?: { fields?: Record<string, string>; timestamps?: string[]; values?: number[]; total?: number }[] };
  const hits = body.hits ?? [];
  const timestamps = [...new Set(hits.flatMap((h) => h.timestamps ?? []))].sort();
  const index = new Map(timestamps.map((t, i) => [t, i]));
  const series = hits
    .map((h) => {
      const severity = Number(h.fields?.severity ?? 6);
      const values = new Array<number>(timestamps.length).fill(0);
      (h.timestamps ?? []).forEach((t, i) => (values[index.get(t)!] = h.values?.[i] ?? 0));
      return { level: severityOf(severity), severity, values, total: h.total ?? values.reduce((a, b) => a + b, 0) };
    })
    .sort((a, b) => a.severity - b.severity);
  return { timestamps, series };
}

export interface LogMatrix {
  // the columns: the known categories first (SOURCE_ORDER), the others by name, NO_SOURCE last
  sources: string[];
  cells: { source: string; severity: number; count: number }[];
}

const SOURCE_ORDER = ['host', 'esphome', 'omada', 'docker'];
const sourceRank = (s: string) => (s === NO_SOURCE ? Infinity : SOURCE_ORDER.includes(s) ? SOURCE_ORDER.indexOf(s) : SOURCE_ORDER.length);

// Number of journals per source and per severity, over the range (the matrix of the page).
export async function queryMatrix(c: Server, f: LogFilters, range: LogRange): Promise<LogMatrix> {
  const res = await call(c, '/select/logsql/query', { query: `${filterQuery(f)} | stats by (source, severity) count() n`, start: range.start, end: range.end, timeout: `${QUERY_TIMEOUT_MS / 1000}s` }, QUERY_TIMEOUT_MS + 2000);
  const cells = jsonLines(await res.text())
    .map((o) => ({ source: o.source || NO_SOURCE, severity: Number(o.severity), count: Number(o.n) || 0 }))
    .filter((c) => Number.isInteger(c.severity) && c.severity >= 0 && c.severity <= 7 && c.count > 0);
  const sources = [...new Set(cells.map((c) => c.source))].sort((a, b) => sourceRank(a) - sourceRank(b) || a.localeCompare(b));
  return { sources, cells };
}

export const LOG_FIELDS = { app: 'app_name', facility: 'facility_keyword', hostname: 'hostname' } as const;
export type LogField = keyof typeof LOG_FIELDS;

// The values of a field in the range, the most frequent first (the choices of a filter).
export async function queryFieldValues(c: Server, field: LogField, f: LogFilters, range: LogRange, limit = 200) {
  const res = await call(c, '/select/logsql/field_values', { query: filterQuery(f), field: LOG_FIELDS[field], start: range.start, end: range.end ?? 'now', limit }, QUERY_TIMEOUT_MS);
  const body = (await res.json()) as { values?: { value: string; hits: number }[] };
  return (body.values ?? []).filter((v) => v.value && v.value !== '-').sort((a, b) => b.hits - a.hits);
}

// What surrounds a journal on its host: the rows just before and just after it, oldest first, the row itself included.
export async function queryContext(c: Server, hostname: string, time: string, before: number, after: number): Promise<LogRow[]> {
  const t = Date.parse(time);
  if (!Number.isFinite(t)) throw new LogServerError('date invalide', 400);
  const hour = 3600_000;
  const [prev, next] = await Promise.all([
    queryLogs(c, { hostnames: [hostname] }, { start: new Date(t - hour).toISOString(), end: time }, before),
    queryLogs(c, { hostnames: [hostname] }, { start: time, end: new Date(t + hour).toISOString() }, after + 1, true),
  ]);
  return [...prev.reverse(), ...next];
}

// Is the server there and does it answer a query: what the test of a role shows.
export async function checkLogServer(c: Server) {
  const health = await fetch(`${c.url.replace(/\/+$/, '')}/health`, { headers: headersOf(c), signal: AbortSignal.timeout(8000) }).catch((err) => {
    throw failure(err);
  });
  if (health.status === 401 || health.status === 403) throw new LogServerError('le serveur de logs refuse ce compte');
  if (!health.ok) throw new LogServerError(`${c.url} répond ${health.status} : pas l'API d'un VictoriaLogs ?`);
  const senders = await querySenders(c, '1d');
  return { senders: senders.length };
}

export interface LogSender {
  hostname: string;
  lastAt: number;
  count: number;
  errors: number;
}

// Who sent journals in the range: the last one of each, how many, and how many errors (severity err and worse).
export async function querySenders(c: Server, start: string): Promise<LogSender[]> {
  const res = await call(c, '/select/logsql/query', { query: '* | stats by (hostname) max(_time) last, count() n, count() if (severity:<=3) errors', start, timeout: '15s' }, 17_000);
  return jsonLines(await res.text())
    .filter((o) => o.hostname)
    .map((o) => ({ hostname: o.hostname, lastAt: Date.parse(o.last) || 0, count: Number(o.n) || 0, errors: Number(o.errors) || 0 }));
}

// Live tail: every journal that matches, as it comes, until the signal aborts. A row the server cannot give is skipped.
export async function tailLogs(c: Server, f: LogFilters, onRow: (row: LogRow) => void, signal: AbortSignal) {
  const body = new URLSearchParams({ query: filterQuery(f), offset: '2s', refresh_interval: '1s' });
  let res: Response;
  try {
    res = await fetch(`${c.url.replace(/\/+$/, '')}/select/logsql/tail`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headersOf(c) }, body, signal });
  } catch (err) {
    throw failure(err);
  }
  if (!res.ok || !res.body) throw new LogServerError(`le serveur de logs répond ${res.status}`);
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        onRow(toRow(JSON.parse(l) as Record<string, string>));
      } catch {
        // not a row
      }
    }
  }
}

// --- state of the servers, and of the hosts that send to them --------------------------------------------------------

// Host names are compared without their domain and whatever the case: a machine may log as its short or full name.
export const hostKey = (name: string) => name.trim().toLowerCase().split('.')[0];

// What the last poll of each server gave, kept in memory (state and summary of its role, roleView.ts).
export interface LogPollState {
  polledAt: Date;
  pollError?: string;
  senders: LogSender[];
}
const lastPolls = new Map<string, LogPollState>();
export const logPollOf = (roleId: string) => lastPolls.get(roleId) ?? null;

// The journals of a host as the last polls saw them, whatever the server: its last one and its errors over a day.
export function hostLogs(hostname: string | undefined) {
  if (!hostname) return null;
  const key = hostKey(hostname);
  let found: { roleId: string; lastAt: number; errors: number } | null = null;
  for (const [roleId, p] of lastPolls) {
    const own = p.senders.filter((s) => hostKey(s.hostname) === key);
    if (!own.length) continue;
    const lastAt = Math.max(...own.map((s) => s.lastAt));
    if (!found || lastAt > found.lastAt) found = { roleId, lastAt, errors: own.reduce((n, s) => n + s.errors, 0) };
  }
  return found;
}

// A host whose journals are sent by the standardisation and that sent nothing for the silent time of its server: why,
// else null. Never while it is offline, while its option is not conform (the agent says why), or before the first poll.
export function silentReason(h: Pick<HostDoc, '_id' | 'info' | 'setup'>, roleId: string | undefined, now = Date.now()) {
  const role = roleId ? logRole(roleId) : undefined;
  const poll = role && lastPolls.get(role._id);
  if (!role || !poll || poll.pollError || !role.config.silentHours || !isOnline(h._id.toHexString())) return null;
  const check = h.setup?.modules.find((m) => m.module === 'log_forward');
  // checked before the option was applied: nothing was expected yet
  if (!check || check.state === 'na' || check.state === 'error') return null;
  if (check.state === 'drift' && !check.silent) return null;
  const key = hostKey(h.info?.hostname ?? '');
  const last = Math.max(0, ...poll.senders.filter((s) => hostKey(s.hostname) === key).map((s) => s.lastAt));
  const limit = role.config.silentHours * 3600_000;
  // conform for less than the silent time: the journals may not have started yet
  if (!last && now - (h.setup?.checkedAt ?? now) < limit && !check.silent) return null;
  if (last && now - last < limit) return null;
  return last ? `aucun journal reçu par ${role.name} depuis ${Math.floor((now - last) / 3600_000)} h` : `aucun journal reçu par ${role.name}`;
}

const POLL_MS = 5 * 60_000;

// The role a host sends to, as its last check of the standardisation recorded it.
const sentTo = (h: Pick<HostDoc, 'setup'>) => h.setup?.modules.find((m) => m.module === 'log_forward')?.role;

// After a poll: the hosts that went silent become a drift of their option, the ones that send again are conform again.
async function markSilentHosts() {
  for (const h of await hosts.find({ 'setup.modules.module': 'log_forward' }).toArray()) {
    const modules = h.setup!.modules;
    const i = modules.findIndex((m) => m.module === 'log_forward');
    const check = modules[i];
    const why = silentReason(h, sentTo(h));
    const next: SetupCheck = why ? { ...check, state: 'drift', detail: why, silent: true } : check.silent ? { module: check.module, state: 'ok', ...(check.role ? { role: check.role } : {}) } : check;
    if (next === check || (next.state === check.state && next.detail === check.detail)) continue;
    const updated = await hosts.findOneAndUpdate({ _id: h._id }, { $set: { [`setup.modules.${i}`]: next } }, { returnDocument: 'after' });
    if (updated) publish('host', hostDto(updated));
  }
}

export async function pollLogServers(log?: FastifyBaseLogger) {
  const roles = logRoles();
  for (const id of [...lastPolls.keys()]) if (!roles.some((r) => r._id === id)) lastPolls.delete(id);
  if (!roles.length) return;
  const before = JSON.stringify([...lastPolls].map(([id, p]) => [id, !!p.pollError, p.senders.length]));
  await Promise.all(
    roles.map(async (r) => {
      try {
        lastPolls.set(r._id, { polledAt: new Date(), senders: await querySenders(r.config, '1d') });
      } catch (err) {
        log?.warn({ role: r._id, err: (err as Error).message }, 'log server poll failed');
        lastPolls.set(r._id, { polledAt: new Date(), pollError: (err as Error).message, senders: lastPolls.get(r._id)?.senders ?? [] });
      }
    }),
  );
  await markSilentHosts();
  if (before !== JSON.stringify([...lastPolls].map(([id, p]) => [id, !!p.pollError, p.senders.length]))) publish('roles', {});
}

export function startLogPoller(log: FastifyBaseLogger) {
  const run = () => pollLogServers(log).catch((err) => log.error({ err }, 'log servers poll failed'));
  const first = setTimeout(run, 15_000);
  const timer = setInterval(run, POLL_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
