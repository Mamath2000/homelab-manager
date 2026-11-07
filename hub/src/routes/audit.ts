import type { FastifyInstance } from 'fastify';
import { auditActors, listAudit } from '../audit.js';
import { parseId } from '../db.js';
import { AUDIT_CATEGORIES, type AuditCategory, type AuditDoc } from '../types.js';

function dto(e: AuditDoc) {
  return {
    id: e._id.toHexString(),
    at: e.at,
    category: e.category,
    action: e.action,
    actor: { kind: e.actor.kind, name: e.actor.name, profile: e.actor.profile ?? null, keyName: e.actor.keyName ?? null },
    ip: e.ip ?? null,
    target: e.target ?? null,
    details: e.details ?? null,
    ok: e.ok,
    error: e.error ?? null,
    count: e.count ?? 1,
  };
}

const date = (v: string | undefined) => {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Journal of the key actions, admins only (profiles.ts). Read only: no route changes or removes an entry.
export function registerAuditRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { actor?: string; category?: AuditCategory; from?: string; to?: string; before?: string; limit?: number } }>(
    '/api/audit',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // "": entries without a known actor (failed logins with an unknown account)
            actor: { type: 'string', maxLength: 64 },
            category: { type: 'string', enum: [...AUDIT_CATEGORIES] },
            from: { type: 'string', maxLength: 40 },
            to: { type: 'string', maxLength: 40 },
            before: { type: 'string', maxLength: 24 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (req, reply) => {
      const from = date(req.query.from);
      const to = date(req.query.to);
      const before = req.query.before ? parseId(req.query.before) : undefined;
      if (from === null || to === null || before === null) return reply.code(400).send({ error: 'paramètre invalide' });
      const { entries, more } = await listAudit({ actor: req.query.actor, category: req.query.category, from, to, before, limit: req.query.limit ?? 50 });
      return { entries: entries.map(dto), next: more ? entries[entries.length - 1]._id.toHexString() : null };
    },
  );

  app.get('/api/audit/actors', async () => ({ actors: await auditActors() }));
}
