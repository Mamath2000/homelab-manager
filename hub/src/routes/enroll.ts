import type { FastifyInstance } from 'fastify';
import { sha256 } from '../crypto.js';
import { hosts } from '../db.js';
import { publish } from '../events.js';
import { hostDto } from '../hostDto.js';
import { checkCsr, signClientCsr } from '../pki.js';
import { loadPki } from '../pkiStore.js';

// naive in-memory brute-force protection, as for the UI login
const failures = new Map<string, { count: number; until: number }>();
function blocked(ip: string) {
  const f = failures.get(ip);
  return !!f && f.count >= 10 && f.until > Date.now();
}
function fail(ip: string) {
  const f = failures.get(ip);
  const fresh = !f || f.until < Date.now();
  failures.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 10 * 60_000 });
}

// Enrollment: the install command's single-use code + a CSR whose private key stays on the host
// give the agent its client certificate.
export function registerEnrollRoute(app: FastifyInstance) {
  app.post<{ Body: { code: string; csr: string } }>(
    '/agent/enroll',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code', 'csr'],
          additionalProperties: false,
          properties: {
            code: { type: 'string', minLength: 16, maxLength: 128 },
            csr: { type: 'string', minLength: 100, maxLength: 8192 },
          },
        },
      },
    },
    async (req, reply) => {
      if (blocked(req.ip)) return reply.code(429).send({ error: 'too many attempts, retry later' });
      // a malformed CSR must not burn the code
      if (!(await checkCsr(req.body.csr))) return reply.code(400).send({ error: 'invalid CSR' });
      // consumed atomically: a code can never enroll twice
      const host = await hosts.findOneAndUpdate(
        { enrollCodeHash: sha256(req.body.code), enrollExpiresAt: { $gt: new Date() } },
        { $unset: { enrollCodeHash: '', enrollExpiresAt: '' } },
        { returnDocument: 'after' },
      );
      if (!host) {
        fail(req.ip);
        return reply.code(401).send({ error: 'invalid or expired enrollment code' });
      }
      const hostId = host._id.toHexString();
      const { certPem, fingerprint } = await signClientCsr(await loadPki(), req.body.csr, hostId);
      const updated = await hosts.findOneAndUpdate(
        { _id: host._id },
        { $set: { certFingerprint: fingerprint, certIssuedAt: new Date() }, $unset: { tokenHash: '' } },
        { returnDocument: 'after' },
      );
      if (updated) publish('host', hostDto(updated));
      req.log.info({ host: host.name }, 'agent enrolled');
      return { hostId, cert: certPem };
    },
  );
}
