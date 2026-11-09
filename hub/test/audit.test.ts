import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { AUDITED_ROUTES, auditContext, flushAudit, recordAudit, recordAuthFailure, registerAudit, runAs, safeDetails, setAuditSink, settingsDiff, sshFingerprint } from '../src/audit.js';
import { authorize } from '../src/profiles.js';
import type { AuditDoc, UserDoc } from '../src/types.js';

// Entries go to an array instead of Mongo.
function capture() {
  const docs: AuditDoc[] = [];
  setAuditSink(async (d) => void docs.push(d));
  return docs;
}
const settle = () => new Promise((r) => setTimeout(r, 10));

// GitHub's published host key and its fingerprint
const GITHUB_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const GITHUB_FP = 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU';

test('SSH keys are written as their fingerprint, comment kept', () => {
  assert.equal(sshFingerprint(GITHUB_KEY), `ssh-ed25519 ${GITHUB_FP}`);
  assert.equal(sshFingerprint(`${GITHUB_KEY} math@pc`), `ssh-ed25519 ${GITHUB_FP} math@pc`);
  assert.equal(sshFingerprint('not a key'), null);
  assert.deepEqual(safeDetails({ root_keys: [GITHUB_KEY] }), { root_keys: [`ssh-ed25519 ${GITHUB_FP}`] });
});

test('no secret reaches an entry, the settings named like one do', () => {
  const out = safeDetails({
    password: 'p',
    newPassword: 'p',
    tokenSecret: 's',
    readerTokenSecret: 's',
    clientSecret: 's',
    code: 'c',
    csr: '-----BEGIN',
    certPem: 'x',
    passwordHash: 'h',
    nested: { password: 'p', ok: 1 },
    tokenId: 'hub@pbs!mon',
    ssh_password: true,
    user: { name: 'math', sudoNoPassword: true },
  });
  assert.deepEqual(out, { nested: { ok: 1 }, tokenId: 'hub@pbs!mon', ssh_password: true, user: { name: 'math', sudoNoPassword: true } });
});

test('settings diff: changed names, values of the plain and non secret fields only', () => {
  const d = settingsDiff(
    { _id: 'pbs', clientImage: 'a:1', tokenSecret: 'old', password: 'x', detail: { level: 'a' }, same: 1 },
    { _id: 'pbs', clientImage: 'b:2', tokenSecret: 'new', password: 'y', detail: { level: 'b' }, same: 1, added: true },
  );
  assert.deepEqual(d.changed.sort(), ['added', 'clientImage', 'detail', 'password', 'tokenSecret']);
  assert.deepEqual(d.values, { clientImage: { from: 'a:1', to: 'b:2' }, added: { from: null, to: true } });
  // deep: structures too
  assert.deepEqual(settingsDiff({ o: { a: 1 } }, { o: { a: 2 } }, [], true).values, { o: { from: { a: 1 }, to: { a: 2 } } });
});

test('failed logins are grouped per address and account', async () => {
  const docs = capture();
  for (let i = 0; i < 50; i++) recordAuthFailure('auth.login', '10.0.0.9', null, 'compte inconnu');
  recordAuthFailure('auth.login', '10.0.0.9', 'math', 'mot de passe incorrect');
  recordAuthFailure('auth.login', '10.0.0.8', null, 'compte inconnu');
  await flushAudit();
  await settle();
  assert.equal(docs.length, 3);
  const many = docs.find((d) => d.ip === '10.0.0.9' && d.actor.name === null)!;
  assert.equal(many.count, 50);
  assert.equal(many.ok, false);
  assert.equal(many.category, 'auth');
  assert.equal(docs.find((d) => d.actor.name === 'math')!.count, undefined);
});

test('a write that fails does not throw', async () => {
  setAuditSink(async () => {
    throw new Error('mongo down');
  });
  await recordAudit({ category: 'auth', action: 'auth.login' });
});

const admin = { _id: new ObjectId(), username: 'math', profile: 'admin' } as UserDoc;

// the audit hooks with a stand-in for auth.ts: x-user logs in, x-key adds an API key, x-deny refuses
async function app() {
  const a = Fastify();
  registerAudit(a);
  a.addHook('onRequest', async (req, reply) => {
    if (!req.headers['x-user']) return reply.code(401).send({ error: 'unauthorized' });
    req.user = admin;
    if (req.headers['x-key']) req.apiKey = { id: new ObjectId(), name: 'ha' };
    if (req.headers['x-deny']) return reply.code(403).send({ error: 'forbidden' });
  });
  a.post('/api/users', async (req: FastifyRequest) => {
    req.auditNote = { target: { kind: 'account', name: 'bob' }, details: { profile: 'viewer', password: 'never' } };
    return { who: auditContext()?.actor.name };
  });
  a.delete<{ Params: { id: string } }>('/api/users/:id', async (_req, reply) => reply.code(409).send({ error: 'cannot delete the last admin' }));
  a.post('/api/other', async () => ({ ok: true }));
  return a;
}

test('an audited route gets its entry, with who, where and the note of the handler', async () => {
  const docs = capture();
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/users', headers: { 'x-user': '1' }, remoteAddress: '192.168.1.7' });
  // the handler runs with who is acting (jobs created further down read it)
  assert.equal(res.json().who, 'math');
  await settle();
  assert.equal(docs.length, 1);
  const d = docs[0];
  assert.equal(d.action, 'account.create');
  assert.equal(d.actor.kind, 'user');
  assert.equal(d.actor.name, 'math');
  assert.equal(d.ip, '192.168.1.7');
  assert.deepEqual(d.target, { kind: 'account', name: 'bob' });
  assert.deepEqual(d.details, { profile: 'viewer' });
  assert.equal(d.ok, true);
});

test('an API key is named, refusals are recorded with their reason, anonymous and other routes are not', async () => {
  const docs = capture();
  const a = await app();
  await a.inject({ method: 'POST', url: '/api/users', headers: { 'x-user': '1', 'x-key': '1' } });
  await a.inject({ method: 'DELETE', url: `/api/users/${new ObjectId().toHexString()}`, headers: { 'x-user': '1' } });
  await a.inject({ method: 'POST', url: '/api/users', headers: { 'x-user': '1', 'x-deny': '1' } });
  await a.inject({ method: 'POST', url: '/api/users' });
  await a.inject({ method: 'POST', url: '/api/other', headers: { 'x-user': '1' } });
  await settle();
  assert.equal(docs.length, 3);
  assert.equal(docs[0].actor.kind, 'apiKey');
  assert.equal(docs[0].actor.keyName, 'ha');
  assert.equal(docs[1].ok, false);
  assert.equal(docs[1].error, 'cannot delete the last admin');
  assert.equal(docs[1].target?.kind, 'account');
  assert.equal(docs[2].ok, false);
  assert.equal(docs[2].error, 'forbidden');
});

test('an MQTT command runs as Home Assistant, whatever context started the client', async () => {
  const docs = capture();
  await runAs({ actor: { kind: 'user', name: 'math' } }, () =>
    runAs({ actor: { kind: 'homeassistant', name: 'Home Assistant' } }, () => recordAudit({ category: 'job', action: 'job.start' })),
  );
  assert.equal(docs[0].actor.kind, 'homeassistant');
});

test('the journal is read by the admins only', () => {
  for (const route of ['/api/audit', '/api/audit/actors']) {
    assert.equal(authorize('admin', 'GET', route), true);
    for (const p of ['operator', 'viewer', 'superadmin'] as const) assert.equal(authorize(p, 'GET', route), false, `${p} ${route}`);
  }
});

test('every audited route exists', async () => {
  // the setup routes exist only with the standardisation on
  const { config } = await import('../src/config.js');
  config.featureStandardisation = true;
  const a = Fastify();
  const seen = new Set<string>();
  a.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) seen.add(`${m} ${r.url}`);
  });
  const { registerAuth } = await import('../src/auth.js');
  const { registerUserRoutes } = await import('../src/routes/users.js');
  const { registerPasskeyRoutes } = await import('../src/routes/passkeys.js');
  const { registerHostRoutes } = await import('../src/routes/hosts.js');
  const { registerSettingsRoutes, registerAgentSettingsRoutes } = await import('../src/routes/settings.js');
  const { registerBackupRoutes } = await import('../src/routes/backups.js');
  const { registerOffsiteRoutes } = await import('../src/routes/offsite.js');
  const { registerRoleRoutes } = await import('../src/routes/roles.js');
  const { registerSetupRoutes } = await import('../src/routes/setup.js');
  registerAuth(a);
  registerUserRoutes(a);
  registerPasskeyRoutes(a);
  registerHostRoutes(a);
  registerSettingsRoutes(a, {} as never);
  registerAgentSettingsRoutes(a, {} as never);
  registerBackupRoutes(a);
  registerOffsiteRoutes(a);
  registerRoleRoutes(a);
  registerSetupRoutes(a);
  await a.ready();
  for (const key of Object.keys(AUDITED_ROUTES)) assert.ok(seen.has(key), `${key} is not a route`);
});

test('entries are only added: nothing but audit.ts touches the collection, and it never changes one', () => {
  const dir = join(import.meta.dirname, '../src');
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    if (f === 'audit.ts') {
      assert.doesNotMatch(src, /audit\.(update|delete|replace|findOneAnd|bulkWrite|drop)/);
      continue;
    }
    if (f === 'db.ts') continue;
    assert.doesNotMatch(src, /import \{[^}]*\baudit\b[^}]*\} from '\.\.?\/db\.js'/, `${f} imports the audit collection`);
  }
});
