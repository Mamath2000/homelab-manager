import { Agent, request } from 'node:https';
import { connect, type TLSSocket } from 'node:tls';
import type { FastifyBaseLogger } from 'fastify';
import { backups, hosts, settings } from './db.js';
import { publish } from './events.js';
import type { BackupDoc, HostDoc, PbsDatastoreUsage, PbsSettings } from './types.js';

// Backups kept on a Proxmox Backup Server, read through its API with a read-only token
// (DatastoreAudit). Nothing runs on the hosts: the PBS is the source of truth.

export const DEFAULT_PBS: PbsSettings = {
  _id: 'pbs',
  enabled: false,
  url: '',
  fingerprint: '',
  tokenId: '',
  tokenSecret: '',
  staleHours: 26,
};

export const PBS_URL_RE = /^https:\/\/[A-Za-z0-9.\-[\]:]+(:\d{1,5})?\/?$/;
export const TOKEN_ID_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/;
export const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export async function loadPbsSettings(): Promise<PbsSettings> {
  return { ...DEFAULT_PBS, ...((await settings.findOne({ _id: 'pbs' })) as PbsSettings | null), _id: 'pbs' };
}

export function normalizeFingerprint(f: string) {
  const hex = f.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex.length === 64 ? hex.match(/../g)!.join(':') : f.trim().toUpperCase();
}

export class PbsError extends Error {}

type Conn = Pick<PbsSettings, 'url' | 'fingerprint' | 'tokenId' | 'tokenSecret'>;

function tlsSocket(url: URL, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || 8007), servername: url.hostname, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.on('timeout', () => socket.destroy(new PbsError('le PBS ne répond pas')));
    socket.on('error', (err) => reject(err instanceof PbsError ? err : new PbsError(err.message)));
  });
}

// TLS connection whose certificate has the pinned fingerprint, checked once the handshake is done
// and before anything (the token) is written. Works whatever issued the certificate: self-signed
// (PBS default), ACME, internal CA.
async function pinnedSocket(url: URL, pinned: string, timeoutMs: number) {
  const socket = await tlsSocket(url, timeoutMs);
  const fp = socket.getPeerCertificate()?.fingerprint256?.toUpperCase();
  if (fp !== pinned) {
    socket.destroy();
    throw new PbsError(`empreinte du certificat inattendue : ${fp ?? 'aucun certificat'}`);
  }
  return socket;
}

function oneSocketAgent(socket: TLSSocket) {
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => socket;
  return agent;
}

// GET on the PBS API. Pinned fingerprint: the certificate must be that one (the chain and host name
// are not checked); otherwise the system CAs and the host name.
export async function pbsGet<T>(c: Conn, path: string, timeoutMs = 20_000): Promise<T> {
  const url = new URL(`/api2/json${path}`, c.url);
  const pinned = c.fingerprint ? normalizeFingerprint(c.fingerprint) : '';
  const socket = pinned ? await pinnedSocket(url, pinned, timeoutMs) : null;
  return new Promise<T>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        headers: { Authorization: `PBSAPIToken=${c.tokenId}:${c.tokenSecret}`, Accept: 'application/json', Connection: 'close' },
        timeout: timeoutMs,
        // pinned: an agent handing over the connection already checked (agent: false would open another)
        agent: socket ? oneSocketAgent(socket) : false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          body += d;
          if (body.length > 32 << 20) req.destroy(new PbsError('réponse trop volumineuse'));
        });
        res.on('end', () => {
          if (res.statusCode === 401) return reject(new PbsError('jeton refusé (401) : vérifie l’identifiant et le secret'));
          if (res.statusCode === 403) return reject(new PbsError('accès refusé (403) : le jeton doit avoir le rôle DatastoreAudit'));
          if (res.statusCode !== 200) return reject(new PbsError(`HTTP ${res.statusCode} sur ${path}`));
          try {
            resolve((JSON.parse(body) as { data: T }).data);
          } catch {
            reject(new PbsError(`réponse illisible sur ${path}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new PbsError('le PBS ne répond pas')));
    req.on('error', (err) => reject(err instanceof PbsError ? err : new PbsError(err.message)));
    req.end();
  });
}

// Fingerprint of the certificate the PBS presents, to pin it (shown to the admin before saving).
export async function fetchFingerprint(rawUrl: string, timeoutMs = 10_000): Promise<string> {
  const socket = await tlsSocket(new URL(rawUrl), timeoutMs);
  const fp = socket.getPeerCertificate()?.fingerprint256;
  socket.end();
  if (!fp) throw new PbsError('aucun certificat présenté');
  return fp.toUpperCase();
}

// --- API answers (subset) ---------------------------------------------------------------

interface ApiDatastore {
  store: string;
}
interface ApiNamespace {
  ns: string;
}
interface ApiGroup {
  'backup-type': string;
  'backup-id': string;
  'last-backup': number; // unix s
  'backup-count': number;
  owner?: string;
  comment?: string;
}
interface ApiSnapshot {
  'backup-type': string;
  'backup-id': string;
  'backup-time': number;
  size?: number;
  verification?: { state: string };
}
interface ApiUsage {
  store: string;
  total?: number;
  used?: number;
  avail?: number;
}

export const groupKey = (store: string, ns: string, type: string, id: string) => `${store}/${ns}/${type}/${id}`;

// Groups of one namespace, with the size and verification of their last snapshot.
export function mergeGroups(store: string, ns: string, groups: ApiGroup[], snapshots: ApiSnapshot[]) {
  const last = new Map<string, ApiSnapshot>();
  for (const s of snapshots) {
    const k = `${s['backup-type']}/${s['backup-id']}`;
    const cur = last.get(k);
    if (!cur || s['backup-time'] > cur['backup-time']) last.set(k, s);
  }
  return groups.map((g) => {
    const s = last.get(`${g['backup-type']}/${g['backup-id']}`);
    const verify = s?.verification?.state === 'ok' ? 'ok' : s?.verification?.state === 'failed' ? 'failed' : null;
    return {
      _id: groupKey(store, ns, g['backup-type'], g['backup-id']),
      store,
      ns,
      type: g['backup-type'],
      backupId: g['backup-id'],
      ...(g.comment ? { comment: g.comment } : {}),
      ...(g.owner ? { owner: g.owner } : {}),
      count: g['backup-count'],
      lastBackup: g['last-backup'] * 1000,
      size: s?.size ?? null,
      verify,
    } as const;
  });
}

// Host a group belongs to: its id (or, for a vm / ct, its notes) is the name or hostname of a host,
// possibly followed by _xxx or -xxx (host_db for the PostgreSQL backups). Longest match wins.
export function matchHost(g: Pick<BackupDoc, 'backupId' | 'comment' | 'type'>, list: Pick<HostDoc, '_id' | 'name' | 'info'>[]) {
  const subjects = [g.backupId.toLowerCase()];
  if (g.type !== 'host' && g.comment) subjects.push(g.comment.trim().toLowerCase());
  let best: { id: HostDoc['_id']; len: number } | null = null;
  for (const h of list) {
    for (const cand of new Set([h.name, h.info?.hostname].filter(Boolean).map((x) => x!.toLowerCase()))) {
      for (const s of subjects) {
        if ((s === cand || s.startsWith(`${cand}_`) || s.startsWith(`${cand}-`)) && (!best || cand.length > best.len)) best = { id: h._id, len: cand.length };
      }
    }
  }
  return best?.id ?? null;
}

export type BackupState = 'ok' | 'stale' | 'failed' | 'ignored' | 'gone';

export function backupState(b: Pick<BackupDoc, 'lastBackup' | 'verify' | 'staleHours' | 'ignored' | 'gone'>, staleHours: number, now = Date.now()): BackupState {
  if (b.ignored) return 'ignored';
  if (b.gone) return 'gone';
  if (b.verify === 'failed') return 'failed';
  return now - b.lastBackup > (b.staleHours ?? staleHours) * 3600_000 ? 'stale' : 'ok';
}

export function backupDto(b: BackupDoc, staleHours: number, now = Date.now()) {
  const { _id, hostId, seenAt, ...rest } = b;
  return {
    id: _id,
    ...rest,
    hostId: hostId ? hostId.toHexString() : null,
    seenAt,
    state: backupState(b, staleHours, now),
    threshold: b.staleHours ?? staleHours,
  };
}

// --- poll ---------------------------------------------------------------------------------

let polling: Promise<void> | null = null;

export function pollPbs(log?: FastifyBaseLogger) {
  // one poll at a time: a refresh during a poll waits for it
  polling ??= doPoll(log).finally(() => (polling = null));
  return polling;
}

async function doPoll(log?: FastifyBaseLogger) {
  const s = await loadPbsSettings();
  if (!s.enabled || !s.url || !s.tokenId) return;
  try {
    const stores = await pbsGet<ApiDatastore[]>(s, '/admin/datastore');
    const found: ReturnType<typeof mergeGroups>[number][] = [];
    for (const { store } of stores) {
      const e = encodeURIComponent(store);
      // namespaces need PBS 2.2+; without them, only the root namespace
      const nss = await pbsGet<ApiNamespace[]>(s, `/admin/datastore/${e}/namespace`).catch(() => [{ ns: '' }]);
      for (const { ns } of nss) {
        const q = ns ? `?ns=${encodeURIComponent(ns)}` : '';
        const [groups, snapshots] = await Promise.all([
          pbsGet<ApiGroup[]>(s, `/admin/datastore/${e}/groups${q}`),
          pbsGet<ApiSnapshot[]>(s, `/admin/datastore/${e}/snapshots${q}`),
        ]);
        found.push(...mergeGroups(store, ns, groups, snapshots));
      }
    }
    const usage = await pbsGet<ApiUsage[]>(s, '/status/datastore-usage').catch(() => []);
    const datastores: PbsDatastoreUsage[] = usage
      .filter((u) => typeof u.total === 'number')
      .map((u) => ({ store: u.store, total: u.total!, used: u.used ?? 0, avail: u.avail ?? 0 }));

    const now = new Date();
    const list = await hosts.find({}, { projection: { _id: 1, name: 1, info: 1 } }).toArray();
    const known = new Map((await backups.find().toArray()).map((b) => [b._id, b]));
    for (const g of found) {
      const prev = known.get(g._id);
      const hostId = prev?.hostPinned ? prev.hostId : matchHost(g, list);
      await backups.updateOne({ _id: g._id }, { $set: { ...g, hostId, seenAt: now }, $unset: { gone: '' } }, { upsert: true });
    }
    // groups pruned from the PBS stay listed as gone, without alert, until forgotten
    await backups.updateMany({ seenAt: { $lt: now } }, { $set: { gone: true } });
    await settings.updateOne({ _id: 'pbs' }, { $set: { polledAt: now, pollError: null, datastores } }, { upsert: true });
    log?.info({ groups: found.length }, 'PBS polled');
  } catch (err) {
    await settings.updateOne({ _id: 'pbs' }, { $set: { polledAt: new Date(), pollError: (err as Error).message } }, { upsert: true });
    log?.warn({ err }, 'PBS poll failed');
  }
  publish('backups', {});
}

// Group of a deleted host: back to "no host" (and to automatic matching).
export async function forgetHost(hostId: HostDoc['_id']) {
  await backups.updateMany({ hostId }, { $set: { hostId: null }, $unset: { hostPinned: '' } });
}

export function startPbsPoller(log: FastifyBaseLogger) {
  const run = () => pollPbs(log).catch((err) => log.error({ err }, 'PBS poll failed'));
  const first = setTimeout(run, 30_000);
  const timer = setInterval(run, 15 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
