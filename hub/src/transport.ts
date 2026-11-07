import type { TLSSocket } from 'node:tls';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from './config.js';

// How a request reached the hub: what the session cookie, the banners of the UI and the redirection of the http port
// decide on (homelab#315).

export function isLoopback(ip: string | undefined) {
  if (!ip) return false;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return v4.startsWith('127.') || ip === '::1';
}

export interface Transport {
  // the browser talks https to the hub or to its proxy
  https: boolean;
  // the request came in on the TLS port of the UI
  direct: boolean;
  // https up to a trusted proxy, then in clear to the hub from another machine (or container): the hop can be listened to
  hopClear: boolean;
}

export function transport(req: FastifyRequest): Transport {
  const direct = !!(req.raw.socket as TLSSocket | undefined)?.encrypted;
  // req.protocol reads X-Forwarded-Proto from trusted proxies only (TRUST_PROXY)
  const https = direct || req.protocol === 'https';
  return { https, direct, hopClear: https && !direct && !isLoopback(req.raw.socket?.remoteAddress) };
}

// Secure attribute of the session cookie for this request.
export function cookieSecure(req: FastifyRequest) {
  return config.cookieSecure === 'auto' ? transport(req).https : config.cookieSecure;
}

// Public URL of the TLS port of the UI for a request on the http port, null when there is none.
export function httpsUrl(req: FastifyRequest) {
  if (!config.httpsPort) return null;
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!/^[A-Za-z0-9.\-]+$|^\[[0-9A-Fa-f:]+\]$/.test(host)) return null;
  return `https://${host}:${config.httpsPublicPort || config.httpsPort}`;
}

// While the TLS port of the UI is on, the http port (mode "redirect") sends the browsers there: pages are redirected,
// logins and API keys refused (they would go in clear). Left alone: the loopback (Docker health check, local tools),
// /api/health, and requests a trusted proxy says it received over https (redirecting them would loop).
export function registerHttpPolicy(app: FastifyInstance) {
  if (!config.httpsPort || config.httpMode !== 'redirect') return;
  app.addHook('onRequest', async (req, reply) => {
    if (transport(req).https || isLoopback(req.raw.socket?.remoteAddress)) return;
    // the matched route, never the raw URL (the router decodes percent-escapes, see auth.ts); unmatched: a page
    const route = req.routeOptions.url ?? '';
    if (route === '/api/health') return;
    const url = httpsUrl(req);
    const api = route.startsWith('/api/');
    if (api && (req.headers.authorization || route === '/api/auth/login')) {
      return reply.code(403).send({ error: 'https_required', url });
    }
    if (!api && (req.method === 'GET' || req.method === 'HEAD') && url) return reply.redirect(url + req.url, 308);
  });
}
