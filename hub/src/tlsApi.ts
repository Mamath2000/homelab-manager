import { Agent, request } from 'node:https';
import { connect, type TLSSocket } from 'node:tls';

// JSON GET on the API of a Proxmox server (PBS, PVE), or of an Omada controller (omada.ts), whose certificate is pinned
// by its SHA-256 fingerprint: self-signed by default, so the chain and host name are not checked, only the
// fingerprint, and before anything (the token) is written. Without a fingerprint, the system CAs.

export const SERVER_URL_RE = /^https:\/\/[A-Za-z0-9.\-[\]:]+(:\d{1,5})?\/?$/;
export const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export function normalizeFingerprint(f: string) {
  const hex = f.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex.length === 64 ? hex.match(/../g)!.join(':') : f.trim().toUpperCase();
}

export class ApiError extends Error {}
// the server does not present the certificate pinned
export class FingerprintError extends ApiError {}

export interface ApiConn {
  url: string;
  fingerprint: string;
  authorization: string; // Authorization header
  defaultPort: number;
  // messages of the 401 / 403 answers
  denied: { 401: string; 403: string };
  unreachable: string;
}

function tlsSocket(url: URL, defaultPort: number, timeoutMs: number, unreachable: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || defaultPort), servername: url.hostname, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.on('timeout', () => socket.destroy(new ApiError(unreachable)));
    socket.on('error', (err) => reject(err instanceof ApiError ? err : new ApiError(err.message)));
  });
}

async function pinnedSocket(url: URL, c: TlsServer, pinned: string, timeoutMs: number) {
  const socket = await tlsSocket(url, c.defaultPort, timeoutMs, c.unreachable);
  const fp = socket.getPeerCertificate()?.fingerprint256?.toUpperCase();
  if (fp !== pinned) {
    socket.destroy();
    throw new FingerprintError(`empreinte du certificat inattendue : ${fp ?? 'aucun certificat'}`);
  }
  return socket;
}

function oneSocketAgent(socket: TLSSocket) {
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => socket;
  return agent;
}

// GET /api2/json<path>, answers its data member.
export function apiGet<T>(c: ApiConn, path: string, timeoutMs = 20_000): Promise<T> {
  return apiRequest<T>(c, 'GET', path, undefined, timeoutMs);
}

// <method> /api2/json<path> with a JSON body (none for GET / DELETE), answers its data member.
export async function apiRequest<T>(c: ApiConn, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
  const res = await tlsRequest(c, method, new URL(`/api2/json${path}`, c.url), { Authorization: c.authorization }, body, timeoutMs);
  if (res.status === 401) throw new ApiError(c.denied[401]);
  if (res.status === 403) throw new ApiError(c.denied[403]);
  // the PBS / PVE explain a refused write in the message of the answer
  if (res.status !== 200) throw new ApiError(`HTTP ${res.status} sur ${method} ${path}${errorMessage(res.body)}`);
  try {
    return (JSON.parse(res.body) as { data: T }).data;
  } catch {
    throw new ApiError(`réponse illisible sur ${path}`);
  }
}

// A server reached with its certificate pinned (or the system CAs without a fingerprint).
export type TlsServer = Pick<ApiConn, 'url' | 'fingerprint' | 'defaultPort' | 'unreachable'>;

// <method> on url (a JSON body, none for GET / DELETE), answers the status and the body whatever the status. The
// errors of the connection keep the one of Node as cause (its code tells a refused certificate).
export async function tlsRequest(c: TlsServer, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: URL, headers: Record<string, string>, body?: unknown, timeoutMs = 20_000) {
  const pinned = c.fingerprint ? normalizeFingerprint(c.fingerprint) : '';
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const socket = pinned ? await pinnedSocket(url, c, pinned, timeoutMs) : null;
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      url,
      {
        method,
        headers: {
          ...headers,
          Accept: 'application/json',
          Connection: 'close',
          ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: timeoutMs,
        // pinned: an agent handing over the connection already checked (agent: false would open another)
        agent: socket ? oneSocketAgent(socket) : false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          body += d;
          if (body.length > 32 << 20) req.destroy(new ApiError('réponse trop volumineuse'));
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('timeout', () => req.destroy(new ApiError(c.unreachable)));
    req.on('error', (err) => reject(err instanceof ApiError ? err : new ApiError(err.message, { cause: err })));
    req.end(payload);
  });
}

// " : <message>" of an error answer ({"message": …} for the PBS, {"errors": {…}} for PVE), shortened.
function errorMessage(body: string) {
  try {
    const j = JSON.parse(body) as { message?: string; errors?: Record<string, string> };
    const m = j.message ?? (j.errors ? Object.entries(j.errors).map(([k, v]) => `${k}: ${v}`).join(', ') : '');
    return m ? ` : ${String(m).trim().slice(0, 300)}` : '';
  } catch {
    return '';
  }
}

// Fingerprint of the certificate a server presents, to pin it (shown to the admin before saving).
export async function fetchFingerprint(rawUrl: string, defaultPort = 8007, timeoutMs = 10_000): Promise<string> {
  const socket = await tlsSocket(new URL(rawUrl), defaultPort, timeoutMs, 'le serveur ne répond pas');
  const fp = socket.getPeerCertificate()?.fingerprint256;
  socket.end();
  if (!fp) throw new ApiError('aucun certificat présenté');
  return fp.toUpperCase();
}
