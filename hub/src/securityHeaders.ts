import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { transport } from './transport.js';

// One week: short enough to back out of a wrong https setup (homelab#294).
export const HSTS_MAX_AGE = 604800;

// Security headers of every response (homelab#294). The CSP has no 'unsafe-inline': the UI has no inline script or style
// (React sets style={} through the CSSOM) and its only network channel is same-origin (fetch, EventSource).
export async function registerSecurityHeaders(app: FastifyInstance) {
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'connect-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    // set by hand below: only when the browser is on https
    strictTransportSecurity: false,
    // helmet's defaults the UI does not need or that break same-origin assets
    crossOriginEmbedderPolicy: false,
  });

  // HSTS stays out of the cases where it would lock the UI: the TLS port with the certificate issued by the hub
  // (self-signed, the browser must be able to bypass the warning). Behind a proxy, or with a provided certificate, it is safe.
  app.addHook('onSend', async (req, reply) => {
    const t = transport(req);
    if (t.https && (!t.direct || config.httpsCertFile)) {
      reply.header('strict-transport-security', `max-age=${HSTS_MAX_AGE}`);
    }
  });
}
