import { ApiError, fetchFingerprint, FingerprintError, tlsRequest, type TlsServer } from './tlsApi.js';
import type { OmadaControllerConfig } from './types.js';

// Open API of an Omada controller (omada-controller role, roles.ts), as tools/omada/client.mjs of the homelab uses it:
// the id of the controller from /api/info, a token in client mode (POST /openapi/authorize/token?grant_type=
// client_credentials), then the routes /openapi/v1/{omadacId}/… with the header Authorization: AccessToken=<token>. Its
// answers are an envelope { errorCode, msg, result }, errorCode 0 when done. The certificate of a controller is
// self-signed by default: pinned by its fingerprint, never accepted without one.

// the errors of Node for a certificate the system CAs do not vouch for
const CERT_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

interface Envelope<T> {
  errorCode?: number;
  msg?: string;
  result?: T;
}

type Conn = Pick<OmadaControllerConfig, 'url' | 'fingerprint'>;

const server = (c: Conn): TlsServer => ({ url: c.url, fingerprint: c.fingerprint, defaultPort: 443, unreachable: 'le contrôleur ne répond pas' });

async function call<T>(c: Conn, method: 'GET' | 'POST', path: string, opts: { token?: string; body?: unknown } = {}): Promise<T> {
  const res = await tlsRequest(server(c), method, new URL(path, c.url), opts.token ? { Authorization: `AccessToken=${opts.token}` } : {}, opts.body);
  const route = path.split('?')[0];
  let env: Envelope<T>;
  try {
    env = JSON.parse(res.body) as Envelope<T>;
  } catch {
    throw new ApiError(`HTTP ${res.status} sur ${route}, réponse non JSON : est-ce bien un contrôleur Omada ?`);
  }
  if (env.errorCode !== undefined && env.errorCode !== 0) throw new ApiError(`${env.msg?.trim().slice(0, 300) || 'refusé'} (errorCode ${env.errorCode} sur ${route})`);
  if (res.status !== 200) throw new ApiError(`HTTP ${res.status} sur ${route}`);
  return env.result as T;
}

export interface OmadaCheck {
  omadacId: string;
  version: string;
  sites: number;
}

// What a test of the connection does: the id of the controller, a token for the application, then the list of its
// sites (one route that needs the token).
export async function omadaCheck(c: OmadaControllerConfig): Promise<OmadaCheck> {
  const info = await call<{ omadacId?: string; controllerVer?: string }>(c, 'GET', '/api/info');
  if (!info?.omadacId) throw new ApiError('omadacId absent de /api/info : est-ce bien un contrôleur Omada ?');
  const auth = await call<{ accessToken?: string }>(c, 'POST', '/openapi/authorize/token?grant_type=client_credentials', {
    body: { omadacId: info.omadacId, client_id: c.clientId, client_secret: c.clientSecret },
  });
  if (!auth?.accessToken) throw new ApiError('aucun jeton rendu par le contrôleur');
  const sites = await call<{ totalRows?: number }>(c, 'GET', `/openapi/v1/${encodeURIComponent(info.omadacId)}/sites?page=1&pageSize=1`, { token: auth.accessToken });
  return { omadacId: info.omadacId, version: info.controllerVer ?? '', sites: sites?.totalRows ?? 0 };
}

// What the controller answers without any account: /api/info, the version and the id of the controller. The first thing
// to check once its address is known (before an application is typed).
export async function omadaProbe(c: Conn): Promise<{ omadacId: string; version: string }> {
  const info = await call<{ omadacId?: string; controllerVer?: string }>(c, 'GET', '/api/info');
  if (!info?.omadacId) throw new ApiError('omadacId absent de /api/info : est-ce bien un contrôleur Omada ?');
  return { omadacId: info.omadacId, version: info.controllerVer ?? '' };
}

// The certificate was refused (not the one pinned, or not vouched for by the system CAs without a fingerprint): the
// fingerprint it presents, shown to the admin who pins it or not (null: another failure, or no certificate read).
export async function presentedFingerprint(c: Conn, err: unknown) {
  const code = ((err as Error).cause as NodeJS.ErrnoException | undefined)?.code;
  const refused = c.fingerprint ? err instanceof FingerprintError : !!code && CERT_ERRORS.has(code);
  if (!refused) return null;
  try {
    return await fetchFingerprint(c.url, 443);
  } catch {
    return null;
  }
}
