import { ApiError, fetchFingerprint, FingerprintError, tlsRequest, type TlsServer } from './tlsApi.js';
import type { EquipmentType, OmadaControllerConfig, OmadaDevice } from './types.js';

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

// A token for the application of the role, and the id of its controller.
async function login(c: OmadaControllerConfig) {
  const info = await call<{ omadacId?: string }>(c, 'GET', '/api/info');
  if (!info?.omadacId) throw new ApiError('omadacId absent de /api/info : est-ce bien un contrôleur Omada ?');
  const auth = await call<{ accessToken?: string }>(c, 'POST', '/openapi/authorize/token?grant_type=client_credentials', {
    body: { omadacId: info.omadacId, client_id: c.clientId, client_secret: c.clientSecret },
  });
  if (!auth?.accessToken) throw new ApiError('aucun jeton rendu par le contrôleur');
  return { omadacId: info.omadacId, token: auth.accessToken };
}

interface Page<T> {
  totalRows?: number;
  data?: T[];
}

// All the rows of a paged route (pageSize 1000, the maximum of the Open API).
async function all<T>(c: Conn, token: string, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const r = await call<Page<T>>(c, 'GET', `${path}?page=${page}&pageSize=1000`, { token });
    out.push(...(r?.data ?? []));
    if (!r?.data?.length || out.length >= (r.totalRows ?? 0)) return out;
  }
}

const DEVICE_TYPES: Record<string, EquipmentType> = { gateway: 'gateway', switch: 'switch', ap: 'ap' };

export const normalizeMac = (mac: string) => mac.trim().toUpperCase().replace(/-/g, ':');

interface RawDevice {
  mac?: string;
  name?: string;
  type?: string;
  model?: string;
  modelName?: string;
  ip?: string;
  status?: number;
  firmwareVersion?: string;
  lastSeen?: number;
  cpuUtil?: number;
  memUtil?: number;
}

export interface OmadaSnapshot {
  omadacId: string;
  sites: { id: string; name: string }[];
  devices: OmadaDevice[];
}

// What a poll reads: the sites of the controller and the devices of each (status 1: connected).
export async function omadaSnapshot(c: OmadaControllerConfig): Promise<OmadaSnapshot> {
  const { omadacId, token } = await login(c);
  const base = `/openapi/v1/${encodeURIComponent(omadacId)}`;
  const sites = (await all<{ siteId: string; name: string }>(c, token, `${base}/sites`)).map((s) => ({ id: s.siteId, name: s.name }));
  const devices: OmadaDevice[] = [];
  for (const s of sites) {
    for (const d of await all<RawDevice>(c, token, `${base}/sites/${encodeURIComponent(s.id)}/devices`)) {
      if (!d.mac) continue;
      devices.push({
        mac: normalizeMac(d.mac),
        name: d.name?.trim() || d.mac,
        type: DEVICE_TYPES[d.type ?? ''] ?? 'other',
        model: d.modelName ?? d.model ?? '',
        ...(d.ip ? { ip: d.ip } : {}),
        firmware: d.firmwareVersion ?? '',
        connected: d.status === 1,
        ...(typeof d.cpuUtil === 'number' ? { cpu: d.cpuUtil } : {}),
        ...(typeof d.memUtil === 'number' ? { mem: d.memUtil } : {}),
        siteId: s.id,
        ...(d.lastSeen ? { lastSeen: d.lastSeen } : {}),
      });
    }
  }
  return { omadacId, sites, devices };
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
