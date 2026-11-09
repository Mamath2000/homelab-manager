import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { audit } from './db.js';
import type { AuditActor, AuditCategory, AuditDoc, JobBy } from './types.js';

// Journal of the key actions on the hub (homelab#290): who did what, from where, with what result.
// Entries are only added: nothing in the hub changes or removes them, Mongo drops them after a year (db.ts).
// It guards against the misuse of an account or an API key, not against a hub or a database taken over.

declare module 'fastify' {
  interface FastifyRequest {
    // the API key the request came with (auth.ts)
    apiKey?: { id: ObjectId; name: string };
    // what the handler adds to the entry of its route
    auditNote?: AuditNote;
    // error message of a refused audited request (onSend)
    auditError?: string;
  }
}

export interface AuditNote {
  target?: AuditDoc['target'];
  details?: Record<string, unknown>;
}

export interface AuditEntry extends AuditNote {
  category: AuditCategory;
  action: string;
  // default: the one of the request or command being served
  actor?: AuditActor;
  ip?: string;
  ok?: boolean;
  error?: string;
  count?: number;
}

// Who is acting, for whatever the request (or MQTT command) does further down (jobs created deep in a call chain).
export interface AuditContext {
  actor: AuditActor;
  ip?: string;
}
const als = new AsyncLocalStorage<AuditContext>();
export const auditContext = () => als.getStore();
export const runAs = <T>(ctx: AuditContext, fn: () => T) => als.run(ctx, fn);

export const ANONYMOUS: AuditActor = { kind: 'anonymous', name: null };
export const HOME_ASSISTANT: AuditActor = { kind: 'homeassistant', name: 'Home Assistant' };

export function actorOf(req: Pick<FastifyRequest, 'user' | 'apiKey'>): AuditActor {
  const u = req.user;
  if (!u) return ANONYMOUS;
  const base = { id: u._id, name: u.username, profile: u.profile };
  return req.apiKey ? { kind: 'apiKey', ...base, keyId: req.apiKey.id, keyName: req.apiKey.name } : { kind: 'user', ...base };
}

export const jobBy = (a: AuditActor): JobBy => ({ kind: a.kind, name: a.name, ...(a.keyName ? { keyName: a.keyName } : {}) });

// Names of fields never written, whatever a caller passes (passwords, token secrets, enrollment codes, CSR, keys).
// (ssh_password, sudoNoPassword are settings, not secrets)
const SECRET_RE = /^(password|currentPassword|newPassword|temporaryPassword)$|secret|^token$|csr|pem|private|^code$|hash$|^key$|apiKey$/i;
// an SSH public key is not secret, but its fingerprint (and comment) is what an admin compares
const SSH_KEY_RE = /^((?:ssh|ecdsa|sk)-[A-Za-z0-9@.-]+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+(.*))?$/;

export function sshFingerprint(line: string) {
  const m = SSH_KEY_RE.exec(line.trim());
  if (!m) return null;
  const fp = createHash('sha256').update(Buffer.from(m[2], 'base64')).digest('base64').replace(/=+$/, '');
  return `${m[1]} SHA256:${fp}${m[3] ? ' ' + m[3].trim() : ''}`;
}
const MAX_TEXT = 300;
const MAX_ITEMS = 50;

export function safeDetails(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') {
    const fp = sshFingerprint(v);
    if (fp) return fp;
    return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) + '…' : v;
  }
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date || v instanceof ObjectId) return v;
  if (depth > 4) return '…';
  if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => safeDetails(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (!SECRET_RE.test(k) && x !== undefined) out[k] = safeDetails(x, depth + 1);
  return out;
}

const plain = (v: unknown) =>
  v === undefined || v === null || ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.length <= 20 && v.every((x) => x === null || typeof x !== 'object'));

// What a settings change did: the names of the fields changed, and their old and new values when they are plain and
// not secret (a secret or a structure only shows its name; deep: structures too, made safe by safeDetails).
export function settingsDiff(before: object | null | undefined, after: object | null | undefined, ignore: string[] = ['_id'], deep = false) {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const changed: string[] = [];
  const values: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (ignore.includes(k) || JSON.stringify(b[k]) === JSON.stringify(a[k])) continue;
    changed.push(k);
    if (!SECRET_RE.test(k) && (deep || (plain(b[k]) && plain(a[k])))) values[k] = { from: b[k] ?? null, to: a[k] ?? null };
  }
  return { changed, values };
}

let log: FastifyBaseLogger | null = null;
let sink: (doc: AuditDoc) => Promise<unknown> = (doc) => audit.insertOne(doc);

export function setAuditLogger(l: FastifyBaseLogger) {
  log = l;
}

// tests: entries go there instead of Mongo
export function setAuditSink(fn: (doc: AuditDoc) => Promise<unknown>) {
  sink = fn;
}

export function auditDoc(e: AuditEntry, ctx = als.getStore(), now = new Date()): AuditDoc {
  const ip = e.ip ?? ctx?.ip;
  return {
    _id: new ObjectId(),
    at: now,
    category: e.category,
    action: e.action,
    actor: e.actor ?? ctx?.actor ?? ANONYMOUS,
    ...(ip ? { ip } : {}),
    ...(e.target ? { target: safeDetails(e.target) as AuditDoc['target'] } : {}),
    ...(e.details && Object.keys(e.details).length ? { details: safeDetails(e.details) as Record<string, unknown> } : {}),
    ok: e.ok ?? true,
    ...(e.error ? { error: e.error.slice(0, MAX_TEXT) } : {}),
    ...(e.count && e.count > 1 ? { count: e.count } : {}),
  };
}

// Never blocks nor fails the action: an entry that cannot be written is logged.
export function recordAudit(e: AuditEntry): Promise<void> {
  const doc = auditDoc(e);
  return Promise.resolve()
    .then(() => sink(doc))
    .then(
      () => {},
      (err) => log?.error({ err, action: doc.action }, 'audit: entry not recorded'),
    );
}

// Failed logins (and unknown API keys) are grouped per address and account tried, one entry a minute at most:
// a script hammering the login cannot fill the journal.
const GROUP_MS = 60_000;
const MAX_GROUPS = 1000;
const groups = new Map<string, { action: string; ip: string; name: string | null; error: string; count: number; timer: NodeJS.Timeout }>();

function flushGroup(key: string) {
  const g = groups.get(key);
  if (!g) return Promise.resolve();
  groups.delete(key);
  clearTimeout(g.timer);
  return recordAudit({ category: 'auth', action: g.action, actor: { kind: 'anonymous', name: g.name }, ip: g.ip, ok: false, error: g.error, count: g.count });
}

export function recordAuthFailure(action: 'auth.login' | 'auth.apiKey', ip: string, name: string | null, error: string) {
  let key = `${action}|${ip}|${name ?? ''}`;
  if (!groups.has(key) && groups.size >= MAX_GROUPS) key = `${action}|*|`;
  const g = groups.get(key);
  if (g) {
    g.count++;
    return;
  }
  const many = key.endsWith('|*|');
  const timer = setTimeout(() => void flushGroup(key), GROUP_MS);
  timer.unref();
  groups.set(key, { action, ip: many ? '*' : ip, name: many ? null : name, error, count: 1, timer });
}

// Before the hub stops: the groups still open are written.
export function flushAudit() {
  return Promise.all([...groups.keys()].map(flushGroup)).then(() => {});
}

// Key actions of the API, by matched route. Jobs are recorded when created (jobs.ts), logins in auth.ts.
export const AUDITED_ROUTES: Record<string, { category: AuditCategory; action: string }> = {};
const route = (category: AuditCategory, action: string, ...keys: string[]) => {
  for (const k of keys) AUDITED_ROUTES[k] = { category, action };
};
route('account', 'account.password', 'POST /api/account/password');
route('account', 'account.create', 'POST /api/users');
route('account', 'account.update', 'PATCH /api/users/:id');
route('account', 'account.delete', 'DELETE /api/users/:id');
route('account', 'account.resetPassword', 'POST /api/users/:id/reset-password');
route('account', 'account.revokeSessions', 'DELETE /api/users/:id/sessions');
route('account', 'account.sessionRevoke', 'DELETE /api/account/sessions/:id', 'DELETE /api/users/:id/sessions/:sessionId');
route('account', 'account.passkeyAdd', 'POST /api/account/passkeys');
route('account', 'account.passkeyRemove', 'DELETE /api/account/passkeys/:id');
route('account', 'account.mfaOff', 'DELETE /api/account/passkeys');
route('account', 'account.passkeysReset', 'DELETE /api/users/:id/passkeys');
route('auth', 'auth.reauth', 'POST /api/account/reauth');
route('apiKey', 'apiKey.create', 'POST /api/users/:id/api-keys');
route('apiKey', 'apiKey.revoke', 'DELETE /api/users/:id/api-keys/:keyId');
route('host', 'host.create', 'POST /api/hosts');
route('host', 'host.delete', 'DELETE /api/hosts/:id');
route('host', 'host.enrollCode', 'POST /api/hosts/:id/enroll');
route('host', 'host.revoke', 'POST /api/hosts/:id/revoke');
route('settings', 'settings.homeassistant', 'PUT /api/settings/homeassistant');
route('settings', 'settings.agents', 'PUT /api/settings/agents');
route('settings', 'settings.pbs', 'PUT /api/settings/pbs');
route('settings', 'settings.pbs.token', 'POST /api/settings/pbs/token');
route('settings', 'settings.pbs.disconnect', 'POST /api/settings/pbs/disconnect');
route('settings', 'settings.pbsRemote', 'PUT /api/settings/pbs-remote');
route('settings', 'settings.pbsRemote.token', 'POST /api/settings/pbs-remote/token', 'POST /api/settings/pbs-remote/reader-token');
route('settings', 'settings.pbsRemote.disconnect', 'POST /api/settings/pbs-remote/disconnect');
route('settings', 'settings.pve.cluster', 'PUT /api/settings/pve/clusters/:id');
route('settings', 'settings.pve.token', 'POST /api/settings/pve/clusters/:id/token');
route('settings', 'settings.pve.delete', 'DELETE /api/settings/pve/clusters/:id');
route('settings', 'role.create', 'POST /api/roles');
route('settings', 'role.update', 'PUT /api/roles/:id');
route('settings', 'role.delete', 'DELETE /api/roles/:id');
route('setup', 'setup.standard', 'PUT /api/settings/setup');
route('setup', 'setup.overrides', 'PUT /api/hosts/:id/setup');
route('setup', 'setup.keyAck', 'PUT /api/hosts/:id/access-keys/ack');
route('setup', 'setup.accessApply', 'POST /api/settings/access/apply');

const routeKey = (req: FastifyRequest) => `${req.method} ${req.routeOptions.url ?? ''}`;

// Before the routes: every handler runs with who is acting (jobs.ts reads it), and the audited routes get their entry
// once answered. Not recorded: requests refused before anyone is known (401), for too many attempts (429), or until
// the passkey is proven again (reauth_required).
export function registerAudit(app: FastifyInstance) {
  setAuditLogger(app.log);
  app.addHook('onRoute', (opts) => {
    const handler = opts.handler;
    opts.handler = function (this: unknown, req: FastifyRequest, reply: unknown) {
      return als.run({ actor: actorOf(req), ip: req.ip }, () => (handler as (...a: unknown[]) => unknown).call(this, req, reply));
    } as typeof opts.handler;
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode >= 400 && AUDITED_ROUTES[routeKey(req)] && typeof payload === 'string') {
      try {
        const err = (JSON.parse(payload) as { error?: unknown }).error;
        if (typeof err === 'string') req.auditError = err;
      } catch {
        // not JSON
      }
    }
    return payload;
  });
  app.addHook('onResponse', async (req, reply) => {
    const def = AUDITED_ROUTES[routeKey(req)];
    if (!def || reply.statusCode === 401 || reply.statusCode === 429) return;
    // asked for the passkey first (auth.ts): recorded once sent again
    if (req.auditError === 'reauth_required') return;
    const params = (req.params ?? {}) as Record<string, string>;
    const ok = reply.statusCode < 400;
    void recordAudit({
      ...def,
      actor: actorOf(req),
      ip: req.ip,
      target: req.auditNote?.target ?? (params.id ? { kind: def.category, id: params.id } : undefined),
      details: req.auditNote?.details,
      ok,
      ...(ok ? {} : { error: req.auditError ?? `HTTP ${reply.statusCode}` }),
    });
  });
}

export interface AuditQuery {
  actor?: string;
  category?: AuditCategory;
  from?: Date;
  to?: Date;
  before?: ObjectId;
  limit: number;
}

// Newest first; `before`: the id of the last entry of the previous page.
export async function listAudit(q: AuditQuery) {
  const filter: Record<string, unknown> = {};
  if (q.actor !== undefined) filter['actor.name'] = q.actor === '' ? null : q.actor;
  if (q.category) filter.category = q.category;
  if (q.from || q.to) filter.at = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lt: q.to } : {}) };
  if (q.before) filter._id = { $lt: q.before };
  const list = await audit.find(filter).sort({ _id: -1 }).limit(q.limit + 1).toArray();
  return { entries: list.slice(0, q.limit), more: list.length > q.limit };
}

// Everyone who appears in the journal, deleted accounts included (filter of the page).
export async function auditActors() {
  const names = (await audit.distinct('actor.name')) as (string | null)[];
  return names.filter((n): n is string => !!n).sort((a, b) => a.localeCompare(b));
}
