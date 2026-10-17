import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { config } from './config.js';
import { randomToken, sha256 } from './crypto.js';
import { parseId, settings, tokenSetups } from './db.js';
import { publish } from './events.js';
import { agentUrl, agentUrlOfRequest, curlPinned } from './hubUrl.js';
import { loadPki } from './pkiStore.js';
import { CLUSTER_ID_RE, loadPveSettings, pollPve } from './pve.js';
import { FINGERPRINT_RE, SERVER_URL_RE, normalizeFingerprint } from './tlsApi.js';
import type { PveCluster } from './types.js';

// API token created by a command pasted on a Proxmox VE node, like the agent install: a single-use
// code (1 h) lets the script fetch what to create (user, token, ACL path, role, decided here) and send
// the token back. The secret goes from the server to the hub only: never displayed, never copied by
// hand. The tokens of a PBS are created by its agent instead (pbsAgent.ts); PVE follows in #178.

export type TokenSetupKind = 'pve';

export interface TokenSetupDoc {
  _id: ObjectId;
  codeHash: string;
  kind: TokenSetupKind;
  user: string;
  token: string;
  path: string;
  role: string;
  cluster?: Pick<PveCluster, 'id' | 'name' | 'url' | 'fingerprint'>;
  createdAt: Date;
  expiresAt: Date;
  purgeAt: Date; // removed by the TTL index
  doneAt?: Date;
  tokenId?: string;
}

const TTL_MS = 3600_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Token id chosen in the UI: user@realm!name, realm of the server's own users (pbs, pve: the user is
// created there), name with a letter first (PVE).
export const TOKEN_FULL_RE = /^([A-Za-z0-9._-]{1,64})@(pbs|pve)!([A-Za-z][A-Za-z0-9._-]{0,31})$/;

export function parseTokenId(id: string, realm: 'pbs' | 'pve') {
  const m = TOKEN_FULL_RE.exec(id);
  return m && m[2] === realm ? { user: `${m[1]}@${m[2]}`, token: m[3] } : null;
}

// What the script creates, decided by the hub only.
export function setupPlan(o: { user?: string; tokenName?: string }) {
  return { user: o.user || 'homelab@pve', token: o.tokenName || 'monitor', path: '/', role: 'PVEAuditor' };
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
  if (s.kind === 'pve' && s.cluster) {
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
  app.post<{ Body: { kind: TokenSetupKind; tokenId?: string; cluster?: { id: string; name: string; url: string; fingerprint: string } } }>(
    '/api/settings/token-setups',
    {
      schema: {
        body: {
          type: 'object',
          required: ['kind'],
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['pve'] },
            // user@realm!name of the token (default: the one of setupPlan)
            tokenId: { type: 'string', maxLength: 128 },
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
      const wanted = req.body.tokenId?.trim();
      const chosen = wanted ? parseTokenId(wanted, 'pve') : null;
      if (wanted && !chosen) return reply.code(400).send({ error: 'identifiant du jeton invalide : utilisateur@pve!nom (le nom commence par une lettre)' });
      const c = req.body.cluster;
      if (!c || !CLUSTER_ID_RE.test(c.id)) return reply.code(400).send({ error: 'identifiant du cluster invalide (minuscules, chiffres, - et _)' });
      const url = c.url.trim().replace(/\/+$/, '');
      const fingerprint = c.fingerprint ? normalizeFingerprint(c.fingerprint) : '';
      if (!SERVER_URL_RE.test(url)) return reply.code(400).send({ error: 'URL invalide (https://pve:8006)' });
      if (fingerprint && !FINGERPRINT_RE.test(fingerprint)) return reply.code(400).send({ error: 'empreinte invalide' });
      const cluster: TokenSetupDoc['cluster'] = { id: c.id, name: c.name.trim() || c.id, url, fingerprint };
      const base = await agentUrl(req);
      if (!base) return reply.code(400).send({ error: "adresse du hub invalide : la régler dans Paramètres › Hub et agents" });
      const code = randomToken(24);
      const now = Date.now();
      const doc: TokenSetupDoc = {
        _id: new ObjectId(),
        codeHash: sha256(code),
        kind,
        ...setupPlan({ user: chosen?.user, tokenName: chosen?.token }),
        cluster,
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
    const url = await agentUrlOfRequest(req);
    if (!url) return reply.code(400).send('# invalid hub url, set it in the agent settings\n');
    reply.type('text/x-shellscript; charset=utf-8');
    return template.replaceAll('__HUB_URL__', url).replaceAll('__PIN__', (await loadPki()).serverPin);
  });

  // what to create; does not use the code up (a script stopped on an existing token can be run again)
  app.post<{ Body: { code: string } }>('/token-setup/params', { schema: { body: codeBody } }, async (req, reply) => {
    if (blocked(req.ip)) return reply.code(429).send({ error: 'too many attempts, retry later' });
    const s = await tokenSetups.findOne({ codeHash: sha256(req.body.code), kind: 'pve', expiresAt: { $gt: new Date() }, doneAt: { $exists: false } });
    if (!s) {
      fail(req.ip);
      return reply.code(403).send({ error: 'invalid or expired code' });
    }
    return { tool: 'pve', user: s.user, token: s.token, path: s.path, role: s.role };
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
        { codeHash: sha256(req.body.code), kind: 'pve', expiresAt: { $gt: new Date() }, doneAt: { $exists: false } },
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
