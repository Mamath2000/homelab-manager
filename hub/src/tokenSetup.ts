import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { refreshManaged, syncHost } from './backupJobs.js';
import { config } from './config.js';
import { randomToken, sha256 } from './crypto.js';
import { hosts, parseId, settings, tokenSetups } from './db.js';
import { publish } from './events.js';
import { agentUrl, curlPinned } from './hubUrl.js';
import { pollPbs } from './pbs.js';
import { loadPki } from './pkiStore.js';
import { CLUSTER_ID_RE, loadPveSettings, pollPve } from './pve.js';
import { FINGERPRINT_RE, SERVER_URL_RE, normalizeFingerprint } from './tlsApi.js';
import type { PveCluster } from './types.js';

// API tokens created by a command pasted on the PBS / a PVE node, like the agent install: a
// single-use code (1 h) lets the script fetch what to create (user, token, ACL path, role, decided
// here) and send the token back. The secret goes from the server to the hub only: never displayed,
// never copied by hand.

export type TokenSetupKind = 'pbs' | 'pve' | 'host';

export interface TokenSetupDoc {
  _id: ObjectId;
  codeHash: string;
  kind: TokenSetupKind;
  tool: 'pbs' | 'pve';
  user: string;
  token: string;
  path: string;
  role: string;
  hostId?: ObjectId;
  cluster?: Pick<PveCluster, 'id' | 'name' | 'url' | 'fingerprint'>;
  createdAt: Date;
  expiresAt: Date;
  purgeAt: Date; // removed by the TTL index
  doneAt?: Date;
  tokenId?: string;
}

const TTL_MS = 3600_000;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'host';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// What the script creates, decided by the hub only.
// Name of a token (part after the "!"): PVE wants a letter first.
export const TOKEN_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;

export function setupPlan(kind: TokenSetupKind, o: { hostName?: string; tokenName?: string }) {
  if (kind === 'pbs') return { tool: 'pbs' as const, user: 'homelab@pbs', token: o.tokenName || 'monitor', path: '/datastore', role: 'DatastoreAudit' };
  if (kind === 'pve') return { tool: 'pve' as const, user: 'homelab@pve', token: o.tokenName || 'monitor', path: '/', role: 'PVEAuditor' };
  // a token per host, DatastoreBackup on the namespace of the hosts of every datastore ({store}: the script
  // applies it to each one): it only sees the groups it owns, and cannot write in the namespaces of PVE
  return { tool: 'pbs' as const, user: `host-${slug(o.hostName ?? '')}@pbs`, token: o.tokenName || 'backup', path: '/datastore/{store}/Hosts', role: 'DatastoreBackup' };
}

// naive brute-force protection, as for the enrollment
const failures = new Map<string, { count: number; until: number }>();
const blocked = (ip: string) => {
  const f = failures.get(ip);
  return !!f && f.count >= 10 && f.until > Date.now();
};
function fail(ip: string) {
  const f = failures.get(ip);
  const fresh = !f || f.until < Date.now();
  failures.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 10 * 60_000 });
}

export class SetupError extends Error {}

// The token received; no secret: the token already existed (its rights were updated), the hub must
// already hold it.
async function apply(s: TokenSetupDoc, tokenId: string, secret: string | undefined) {
  const unknown = () => new SetupError('token already exists and the hub does not hold it: delete it on the server and run a new command');
  if (s.kind === 'host' && s.hostId) {
    const host = await hosts.findOne({ _id: s.hostId });
    if (!host) throw new SetupError('host not found');
    const keep = host.pbsCredential?.tokenId === tokenId ? host.pbsCredential.tokenSecret : undefined;
    if (!secret && !keep) throw unknown();
    // store '*': rights on the namespace Hosts of every datastore
    await hosts.updateOne({ _id: s.hostId }, { $set: { pbsCredential: { tokenId, tokenSecret: (secret ?? keep)!, updatedAt: new Date(), store: '*' } } });
    await refreshManaged();
    await syncHost(s.hostId);
  } else if (s.kind === 'pbs') {
    const cur = (await settings.findOne({ _id: 'pbs' })) as { tokenId?: string; tokenSecret?: string } | null;
    if (!secret && !(cur?.tokenId === tokenId && cur.tokenSecret)) throw unknown();
    if (secret) await settings.updateOne({ _id: 'pbs' }, { $set: { tokenId, tokenSecret: secret } }, { upsert: true });
    pollPbs().catch(() => {});
  } else if (s.kind === 'pve' && s.cluster) {
    const cur = await loadPveSettings();
    const existing = cur.clusters.find((c) => c.id === s.cluster!.id);
    const keep = existing?.tokenId === tokenId ? existing.tokenSecret : undefined;
    if (!secret && !keep) throw unknown();
    const next: PveCluster = existing ? { ...existing, tokenId, tokenSecret: (secret ?? keep)! } : { ...s.cluster, tokenId, tokenSecret: secret!, enabled: true };
    const clusters = existing ? cur.clusters.map((c) => (c.id === next.id ? next : c)) : [...cur.clusters, next];
    await settings.replaceOne({ _id: 'pve' }, { _id: 'pve', clusters }, { upsert: true });
    pollPve().catch(() => {});
  }
  publish('backups', {});
}

// Admin side (UI port): create a command, follow it.
export function registerTokenSetupRoutes(app: FastifyInstance) {
  app.post<{ Body: { kind: TokenSetupKind; hostId?: string; tokenName?: string; cluster?: { id: string; name: string; url: string; fingerprint: string } } }>(
    '/api/settings/token-setups',
    {
      schema: {
        body: {
          type: 'object',
          required: ['kind'],
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['pbs', 'pve', 'host'] },
            hostId: { type: 'string', maxLength: 24 },
            // name of the token, when the default one already exists on the server
            tokenName: { type: 'string', maxLength: 32 },
            cluster: {
              type: 'object',
              required: ['id', 'name', 'url', 'fingerprint'],
              additionalProperties: false,
              properties: { id: { type: 'string', maxLength: 32 }, name: { type: 'string', maxLength: 64 }, url: { type: 'string', maxLength: 256 }, fingerprint: { type: 'string', maxLength: 128 } },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { kind } = req.body;
      const tokenName = req.body.tokenName?.trim() || undefined;
      if (tokenName && !TOKEN_NAME_RE.test(tokenName)) return reply.code(400).send({ error: 'nom du jeton invalide (lettre puis lettres, chiffres, . - _)' });
      let hostId: ObjectId | undefined;
      let hostName: string | undefined;
      let cluster: TokenSetupDoc['cluster'];
      if (kind === 'host') {
        const _id = parseId(req.body.hostId ?? '');
        const host = _id && (await hosts.findOne({ _id }));
        if (!host) return reply.code(404).send({ error: 'host not found' });
        hostId = host._id;
        hostName = host.name;
      }
      if (kind === 'pve') {
        const c = req.body.cluster;
        if (!c || !CLUSTER_ID_RE.test(c.id)) return reply.code(400).send({ error: 'identifiant du cluster invalide (minuscules, chiffres, - et _)' });
        const url = c.url.trim().replace(/\/+$/, '');
        const fingerprint = c.fingerprint ? normalizeFingerprint(c.fingerprint) : '';
        if (!SERVER_URL_RE.test(url)) return reply.code(400).send({ error: 'URL invalide (https://pve:8006)' });
        if (fingerprint && !FINGERPRINT_RE.test(fingerprint)) return reply.code(400).send({ error: 'empreinte invalide' });
        cluster = { id: c.id, name: c.name.trim() || c.id, url, fingerprint };
      }
      const base = await agentUrl(req);
      if (!base) return reply.code(400).send({ error: "adresse du hub invalide : la régler dans Paramètres › Hub et agents" });
      const code = randomToken(24);
      const now = Date.now();
      const doc: TokenSetupDoc = {
        _id: new ObjectId(),
        codeHash: sha256(code),
        kind,
        ...setupPlan(kind, { hostName, tokenName }),
        ...(hostId ? { hostId } : {}),
        ...(cluster ? { cluster } : {}),
        createdAt: new Date(now),
        expiresAt: new Date(now + TTL_MS),
        purgeAt: new Date(now + 24 * TTL_MS),
      };
      await tokenSetups.insertOne(doc);
      return {
        id: doc._id.toHexString(),
        command: `${curlPinned((await loadPki()).serverPin)} ${base}/token-setup.sh | sh -s -- ${code}`,
        tokenId: `${doc.user}!${doc.token}`,
        expiresAt: doc.expiresAt,
      };
    },
  );

  app.get<{ Params: { id: string } }>('/api/settings/token-setups/:id', async (req, reply) => {
    const _id = parseId(req.params.id);
    const s = _id && (await tokenSetups.findOne({ _id }));
    if (!s) return reply.code(404).send({ error: 'commande introuvable' });
    const status = s.doneAt ? 'done' : s.expiresAt < new Date() ? 'expired' : 'pending';
    return { status, tokenId: s.tokenId ?? null, doneAt: s.doneAt ?? null };
  });
}

// Script side (TLS agent port, pinned by the command).
export function registerTokenSetupScriptRoutes(app: FastifyInstance) {
  const template = readFileSync(join(config.assetsDir, 'token-setup.sh'), 'utf8');
  const codeBody = { type: 'object', required: ['code'], additionalProperties: false, properties: { code: { type: 'string', minLength: 16, maxLength: 128 } } } as const;

  app.get('/token-setup.sh', async (req, reply) => {
    const url = await agentUrl(req);
    if (!url) return reply.code(400).send('# invalid hub url, set it in the agent settings\n');
    reply.type('text/x-shellscript; charset=utf-8');
    return template.replaceAll('__HUB_URL__', url).replaceAll('__PIN__', (await loadPki()).serverPin);
  });

  // what to create; does not use the code up (a script stopped on an existing token can be run again)
  app.post<{ Body: { code: string } }>('/token-setup/params', { schema: { body: codeBody } }, async (req, reply) => {
    if (blocked(req.ip)) return reply.code(429).send({ error: 'too many attempts, retry later' });
    const s = await tokenSetups.findOne({ codeHash: sha256(req.body.code), expiresAt: { $gt: new Date() }, doneAt: { $exists: false } });
    if (!s) {
      fail(req.ip);
      return reply.code(403).send({ error: 'invalid or expired code' });
    }
    return { tool: s.tool, user: s.user, token: s.token, path: s.path, role: s.role };
  });

  // the token: used up atomically, only for the token id the hub asked for
  app.post<{ Body: { code: string; tokenId: string; secret?: string } }>(
    '/token-setup/complete',
    {
      schema: {
        body: {
          type: 'object',
          // no secret: the token existed already, only its rights were updated
          required: ['code', 'tokenId'],
          additionalProperties: false,
          properties: { code: { type: 'string', minLength: 16, maxLength: 128 }, tokenId: { type: 'string', maxLength: 128 }, secret: { type: 'string', maxLength: 64 } },
        },
      },
    },
    async (req, reply) => {
      if (blocked(req.ip)) return reply.code(429).send({ error: 'too many attempts, retry later' });
      if (req.body.secret !== undefined && !UUID_RE.test(req.body.secret)) return reply.code(400).send({ error: 'invalid secret' });
      const s = await tokenSetups.findOneAndUpdate(
        { codeHash: sha256(req.body.code), expiresAt: { $gt: new Date() }, doneAt: { $exists: false } },
        { $set: { doneAt: new Date(), tokenId: req.body.tokenId } },
        { returnDocument: 'after' },
      );
      if (!s) {
        fail(req.ip);
        return reply.code(403).send({ error: 'invalid or expired code' });
      }
      if (req.body.tokenId !== `${s.user}!${s.token}`) {
        await tokenSetups.updateOne({ _id: s._id }, { $unset: { doneAt: '', tokenId: '' } });
        return reply.code(400).send({ error: 'unexpected token id' });
      }
      try {
        await apply(s, req.body.tokenId, req.body.secret);
      } catch (err) {
        await tokenSetups.updateOne({ _id: s._id }, { $unset: { doneAt: '', tokenId: '' } });
        if (err instanceof SetupError) return reply.code(409).send({ error: err.message });
        throw err;
      }
      req.log.info({ kind: s.kind, tokenId: s.tokenId, existing: !req.body.secret }, 'API token received');
      return { ok: true };
    },
  );
}
