import type { FastifyInstance } from 'fastify';
import { recordAudit } from '../audit.js';
import { config } from '../config.js';
import { sha256 } from '../crypto.js';
import { hosts } from '../db.js';
import { publish } from '../events.js';
import { hostDto } from '../hostDto.js';
import { enrollLimit, ipKey, tooManyAttempts } from '../loginGuard.js';
import { checkCsr, signClientCsr } from '../pki.js';
import { loadPki } from '../pkiStore.js';

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
      // bounded store, by client (loginGuard.ts): 10 wrong codes, then 10 minutes
      const wait = enrollLimit.check(ipKey(req.ip));
      if (wait) return tooManyAttempts(reply, wait, 'too many attempts, retry later');
      // a malformed CSR must not burn the code
      if (!(await checkCsr(req.body.csr))) return reply.code(400).send({ error: 'invalid CSR' });
      // consumed atomically: a code can never enroll twice
      const host = await hosts.findOneAndUpdate(
        { enrollCodeHash: sha256(req.body.code), enrollExpiresAt: { $gt: new Date() } },
        { $unset: { enrollCodeHash: '', enrollExpiresAt: '' } },
        { returnDocument: 'after' },
      );
      if (!host) {
        enrollLimit.fail(ipKey(req.ip));
        return reply.code(401).send({ error: 'invalid or expired enrollment code' });
      }
      const hostId = host._id.toHexString();
      const { certPem, fingerprint } = await signClientCsr(await loadPki(), req.body.csr, hostId);
      const updated = await hosts.findOneAndUpdate(
        { _id: host._id },
        // a new host (never connected) gets the standard configuration at its first connection
        // (not when FEATURE_STANDARDISATION is off: switching it on later must not standardise it)
        {
          $set: { certFingerprint: fingerprint, certIssuedAt: new Date(), ...(host.enrolledAt || !config.featureStandardisation ? {} : { setupPending: true }) },
          $unset: { tokenHash: '' },
        },
        { returnDocument: 'after' },
      );
      if (updated) publish('host', hostDto(updated));
      req.log.info({ host: host.name }, 'agent enrolled');
      void recordAudit({
        category: 'host',
        action: 'host.enroll',
        actor: { kind: 'agent', name: host.name },
        ip: req.ip,
        target: { kind: 'host', id: hostId, name: host.name },
        details: { certFingerprint: fingerprint, again: !!host.enrolledAt },
      });
      return { hostId, cert: certPem };
    },
  );
}
