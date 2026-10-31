import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ProbeState, ProbeTarget } from './types.js';

// What one measure of a probe gives. Except for mqtt (mqttPool.ts), each type is measured here, from the hub.
// unknown: the measure itself is impossible (no ping in the container...), the service is not judged.
export interface Measure {
  state: ProbeState;
  latencyMs?: number;
  message?: string;
  // down at once, without the retries (a probe that is not set up, not a service that fails)
  immediate?: boolean;
}

const since = (t0: number) => Math.max(1, Math.round(performance.now() - t0));
const down = (message: string): Measure => ({ state: 'down', message });

// --- tcp ----------------------------------------------------------------------------------------

export function checkTcp(host: string, port: number, timeoutMs: number): Promise<Measure> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const socket = connect({ host, port, timeout: timeoutMs });
    const end = (m: Measure) => {
      socket.destroy();
      resolve(m);
    };
    socket.once('connect', () => end({ state: 'up', latencyMs: since(t0) }));
    socket.once('timeout', () => end(down(`pas de réponse en ${Math.round(timeoutMs / 1000)} s`)));
    socket.once('error', (err: NodeJS.ErrnoException) => end(down(err.code === 'ECONNREFUSED' ? 'connexion refusée' : err.message)));
  });
}

// --- http(s) ------------------------------------------------------------------------------------

const MAX_REDIRECTS = 5;
const MAX_BODY = 1024 * 1024;

interface HttpOptions {
  status?: number; // expected code; absent: any 2xx
  keyword?: string; // must be in the body
  insecure?: boolean; // certificate not checked (self-signed)
}

interface HttpAnswer {
  status: number;
  location?: string;
  body: string;
}

function httpGet(url: URL, o: HttpOptions, timeoutMs: number, lenient = false): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(url, { method: 'GET', timeout: timeoutMs, rejectUnauthorized: !o.insecure, insecureHTTPParser: lenient, headers: { 'user-agent': 'homelab-manager-probe', accept: '*/*' } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const answer = () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body: Buffer.concat(chunks).toString('utf8') });
      // the body is only read to look for a keyword
      if (!o.keyword) {
        res.destroy();
        return answer();
      }
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= MAX_BODY) chunks.push(c);
        else res.destroy();
      });
      res.on('end', answer);
      res.on('close', answer);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`pas de réponse en ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', reject);
    req.end();
  });
}

// Some web interfaces (routers) answer with both Content-Length and Transfer-Encoding, which the strict parser of Node
// refuses: a service that answers is up, so the same request is sent again with the tolerant parser.
async function httpGetLenient(url: URL, o: HttpOptions, timeoutMs: number): Promise<HttpAnswer> {
  try {
    return await httpGet(url, o, timeoutMs);
  } catch (err) {
    // the code depends on the order of the headers, the message does not
    if (!/Content-Length can't be present with Transfer-Encoding|Transfer-Encoding can't be present with Content-Length/.test((err as Error).message)) throw err;
    return httpGet(url, o, timeoutMs, true);
  }
}

export async function checkHttp(rawUrl: string, o: HttpOptions, timeoutMs: number): Promise<Measure> {
  const t0 = performance.now();
  try {
    let url = new URL(rawUrl);
    for (let hops = 0; ; hops++) {
      const res = await httpGetLenient(url, o, timeoutMs);
      if (res.status >= 300 && res.status < 400 && res.location && hops < MAX_REDIRECTS && o.status !== res.status) {
        url = new URL(res.location, url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return down('redirection vers un protocole non pris en charge');
        continue;
      }
      const latencyMs = since(t0);
      const ok = o.status ? res.status === o.status : res.status >= 200 && res.status < 300;
      if (!ok) return down(`code ${res.status}${o.status ? ` au lieu de ${o.status}` : ''}`);
      if (o.keyword && !res.body.includes(o.keyword)) return down(`mot-clé « ${o.keyword} » absent de la réponse`);
      return { state: 'up', latencyMs };
    }
  } catch (err) {
    return down((err as Error).message);
  }
}

// --- ping ---------------------------------------------------------------------------------------

// Not an option for the ping command, nor a way into it
export const PING_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/;

export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<{ code: number | string | null; stdout: string; stderr: string }>;

export const execPing: Exec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as NodeJS.ErrnoException).code ?? 1) : 0, stdout, stderr });
    });
  });

export async function checkPing(host: string, timeoutMs: number, exec: Exec = execPing): Promise<Measure> {
  if (!PING_HOST_RE.test(host)) return down('adresse invalide');
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const t0 = performance.now();
  const r = await exec('ping', ['-c', '1', '-W', String(seconds), host], timeoutMs + 2000);
  if (r.code === 'ENOENT') return { state: 'unknown', message: 'commande ping absente du hub' };
  if (/operation not permitted|permission denied/i.test(r.stderr)) return { state: 'unknown', message: 'ping non autorisé dans le conteneur du hub' };
  if (r.code === 0) {
    const t = /time[=<]([\d.]+)\s*ms/i.exec(r.stdout);
    return { state: 'up', latencyMs: t ? Math.max(1, Math.round(Number(t[1]))) : since(t0) };
  }
  const bad = /bad address|unknown host|name or service not known|temporary failure/i.test(`${r.stderr}${r.stdout}`);
  return down(bad ? 'nom introuvable' : `pas de réponse en ${seconds} s`);
}

// --- dispatch -----------------------------------------------------------------------------------

export function measureLocal(t: Exclude<ProbeTarget, { type: 'mqtt' }>, timeoutMs: number): Promise<Measure> {
  switch (t.type) {
    case 'tcp': return checkTcp(t.host, t.port, timeoutMs);
    case 'http': return checkHttp(t.url, t, timeoutMs);
    case 'ping': return checkPing(t.host, timeoutMs);
  }
}
