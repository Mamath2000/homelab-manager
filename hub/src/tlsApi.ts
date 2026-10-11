import { Agent, request } from 'node:https';
import { connect, type TLSSocket } from 'node:tls';

// JSON GET on the API of a Proxmox server (PBS, PVE) whose certificate is pinned by its SHA-256
// fingerprint: self-signed by default, so the chain and host name are not checked, only the
// fingerprint, and before anything (the token) is written. Without a fingerprint, the system CAs.

export const SERVER_URL_RE = /^https:\/\/[A-Za-z0-9.\-[\]:]+(:\d{1,5})?\/?$/;
export const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export function normalizeFingerprint(f: string) {
  const hex = f.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex.length === 64 ? hex.match(/../g)!.join(':') : f.trim().toUpperCase();
}

export class ApiError extends Error {}

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

async function pinnedSocket(url: URL, c: ApiConn, pinned: string, timeoutMs: number) {
  const socket = await tlsSocket(url, c.defaultPort, timeoutMs, c.unreachable);
  const fp = socket.getPeerCertificate()?.fingerprint256?.toUpperCase();
  if (fp !== pinned) {
    socket.destroy();
    throw new ApiError(`empreinte du certificat inattendue : ${fp ?? 'aucun certificat'}`);
  }
  return socket;
}

function oneSocketAgent(socket: TLSSocket) {
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => socket;
  return agent;
}

// GET /api2/json<path>, answers its data member.
export async function apiGet<T>(c: ApiConn, path: string, timeoutMs = 20_000): Promise<T> {
  const url = new URL(`/api2/json${path}`, c.url);
  const pinned = c.fingerprint ? normalizeFingerprint(c.fingerprint) : '';
  const socket = pinned ? await pinnedSocket(url, c, pinned, timeoutMs) : null;
  return new Promise<T>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        headers: { Authorization: c.authorization, Accept: 'application/json', Connection: 'close' },
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
        res.on('end', () => {
          if (res.statusCode === 401) return reject(new ApiError(c.denied[401]));
          if (res.statusCode === 403) return reject(new ApiError(c.denied[403]));
          if (res.statusCode !== 200) return reject(new ApiError(`HTTP ${res.statusCode} sur ${path}`));
          try {
            resolve((JSON.parse(body) as { data: T }).data);
          } catch {
            reject(new ApiError(`réponse illisible sur ${path}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new ApiError(c.unreachable)));
    req.on('error', (err) => reject(err instanceof ApiError ? err : new ApiError(err.message)));
    req.end();
  });
}

// Fingerprint of the certificate a server presents, to pin it (shown to the admin before saving).
export async function fetchFingerprint(rawUrl: string, defaultPort = 8007, timeoutMs = 10_000): Promise<string> {
  const socket = await tlsSocket(new URL(rawUrl), defaultPort, timeoutMs, 'le serveur ne répond pas');
  const fp = socket.getPeerCertificate()?.fingerprint256;
  socket.end();
  if (!fp) throw new ApiError('aucun certificat présenté');
  return fp.toUpperCase();
}
