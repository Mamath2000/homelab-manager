import type { FastifyBaseLogger } from 'fastify';
import type { ObjectId } from 'mongodb';
import { backups, guests, hosts, settings } from './db.js';
import { publish } from './events.js';
import { hostDto } from './hostDto.js';
import { groupKey, loadPbsSettings } from './pbs.js';
import { apiGet, normalizeFingerprint } from './tlsApi.js';
import type { GuestDoc, HostPveLink, PbsSettings, PveCluster, PveJobRef, PveSettings, PveTaskResult } from './types.js';

// Proxmox VE clusters, read through their API with a read-only token (PVEAuditor): the guests, their
// MAC addresses, the vzdump backup jobs and the result of their last tasks. A host of the hub is the
// guest that has one of its MAC addresses (deterministic, nothing is written on Proxmox); the groups
// the jobs of that guest write on the followed PBS are attached to it automatically.

export const CLUSTER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const PVE_TOKEN_ID_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/;

export async function loadPveSettings(): Promise<PveSettings> {
  const s = (await settings.findOne({ _id: 'pve' })) as PveSettings | null;
  return { _id: 'pve', clusters: s?.clusters ?? [] };
}

type Conn = Pick<PveCluster, 'url' | 'fingerprint' | 'tokenId' | 'tokenSecret'>;

export function pveGet<T>(c: Conn, path: string, timeoutMs = 20_000): Promise<T> {
  return apiGet<T>(
    {
      url: c.url,
      fingerprint: c.fingerprint,
      authorization: `PVEAPIToken=${c.tokenId}=${c.tokenSecret}`,
      defaultPort: 8006,
      denied: { 401: 'jeton refusé (401) : vérifie l’identifiant et le secret', 403: 'accès refusé (403) : le jeton doit avoir le rôle PVEAuditor sur /' },
      unreachable: 'le cluster ne répond pas',
    },
    path,
    timeoutMs,
  );
}

// --- API answers (subset) ---------------------------------------------------------------------

export interface ApiResource {
  vmid: number;
  name?: string;
  node: string;
  type: 'lxc' | 'qemu';
  template?: number;
}
export interface ApiStorage {
  storage: string;
  type: string;
  datastore?: string;
  namespace?: string;
  server?: string;
  fingerprint?: string;
}
export interface ApiJob {
  id: string;
  type?: string;
  enabled?: number | boolean;
  schedule?: string;
  storage?: string;
  vmid?: string;
  all?: number | boolean;
  exclude?: string;
  pool?: string;
  node?: string;
  'next-run'?: number;
}
export interface ApiTask {
  upid: string;
  id?: string;
  node: string;
  status?: string;
  starttime: number;
  endtime?: number;
}

// --- pure helpers (tested) ----------------------------------------------------------------------

const MAC_RE = /(?:hwaddr|virtio|e1000e?|rtl8139|vmxnet3|ne2k_pci|pcnet|i82551|i82557b|i82559er)=([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/;

// MAC addresses of a guest config (net0..netN: "name=eth0,hwaddr=BC:24:…" or "virtio=BC:24:…,bridge=…")
export function configMacs(config: Record<string, unknown>) {
  const out: string[] = [];
  for (const [k, v] of Object.entries(config)) {
    if (!/^net\d+$/.test(k) || typeof v !== 'string') continue;
    const m = MAC_RE.exec(v);
    if (m) out.push(normalizeMac(m[1]));
  }
  return out;
}

export function normalizeMac(mac: string) {
  return mac.trim().toLowerCase().replaceAll('-', ':');
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1';
const vmidList = (s?: string) => new Set((s ?? '').split(/[\s,;]+/).filter(Boolean).map(Number));

// Does a job back up this guest: listed, or all but excluded, or in its pool; restricted to its node if set.
export function jobCovers(job: ApiJob, guest: Pick<ApiResource, 'vmid' | 'node'>, pools: Map<string, Set<number>>) {
  if (job.node && job.node !== guest.node) return false;
  if (truthy(job.all)) return !vmidList(job.exclude).has(guest.vmid);
  if (job.pool) return !!pools.get(job.pool)?.has(guest.vmid);
  return vmidList(job.vmid).has(guest.vmid);
}

// PBS storages of the cluster that point to the followed PBS: same certificate fingerprint, or the
// same server when no fingerprint is pinned.
export function followedStorages(storages: ApiStorage[], pbs: Pick<PbsSettings, 'url' | 'fingerprint'>) {
  const out = new Map<string, { store: string; ns: string }>();
  if (!pbs.url) return out;
  const fp = pbs.fingerprint ? normalizeFingerprint(pbs.fingerprint) : '';
  const host = new URL(pbs.url).hostname.replace(/^\[|\]$/g, '');
  for (const s of storages) {
    if (s.type !== 'pbs' || !s.datastore) continue;
    const same = fp && s.fingerprint ? normalizeFingerprint(s.fingerprint) === fp : s.server === host;
    if (same) out.set(s.storage, { store: s.datastore, ns: s.namespace ?? '' });
  }
  return out;
}

// Guests of a vzdump task log: started, finished, failed (with the reason).
export function parseVzdumpLog(lines: string[]) {
  const started = new Set<number>();
  const finished = new Set<number>();
  const failed = new Map<number, string>();
  for (const l of lines) {
    let m = /Starting Backup of VM (\d+)/.exec(l);
    if (m) started.add(Number(m[1]));
    m = /Finished Backup of VM (\d+)/.exec(l);
    if (m) finished.add(Number(m[1]));
    m = /ERROR: Backup of VM (\d+) failed(?: - (.*))?/.exec(l);
    if (m) failed.set(Number(m[1]), (m[2] ?? 'échec').trim());
  }
  return { started, finished, failed };
}

const taskOk = (status?: string) => status === 'OK' || !!status?.startsWith('WARNINGS');

// Result of one guest in a finished task: from the task itself when it backs up only this guest,
// from its log otherwise; undefined when the guest is not part of it.
export function guestResult(task: ApiTask, vmid: number, log?: ReturnType<typeof parseVzdumpLog>): PveTaskResult | undefined {
  if (!task.endtime || !task.status) return undefined;
  const base = { upid: task.upid, at: task.endtime * 1000 };
  if (task.id) {
    if (Number(task.id) !== vmid) return undefined;
    return taskOk(task.status) ? { ...base, ok: true } : { ...base, ok: false, error: task.status };
  }
  if (!log || !log.started.has(vmid)) return undefined;
  if (log.failed.has(vmid)) return { ...base, ok: false, error: log.failed.get(vmid) };
  if (log.finished.has(vmid)) return { ...base, ok: true };
  return { ...base, ok: false, error: task.status };
}

// Hosts whose MAC addresses designate exactly one guest. Ambiguous (MAC in several guests, or a
// host matching several guests) and unknown: no link.
export function matchGuests<H extends { _id: ObjectId; macs: string[] }>(list: H[], all: Pick<GuestDoc, '_id' | 'macs'>[]) {
  const byMac = new Map<string, string[]>();
  for (const g of all) for (const m of g.macs) byMac.set(m, [...(byMac.get(m) ?? []), g._id]);
  const out = new Map<string, string | null>();
  for (const h of list) {
    const found = new Set<string>();
    let ambiguous = false;
    for (const m of h.macs.map(normalizeMac)) {
      const ids = byMac.get(m) ?? [];
      if (ids.length > 1) ambiguous = true;
      ids.forEach((id) => found.add(id));
    }
    out.set(h._id.toHexString(), !ambiguous && found.size === 1 ? [...found][0] : null);
  }
  return out;
}

// --- poll ------------------------------------------------------------------------------------------

// Results of multi-guest task logs, kept between polls (a finished task does not change).
const logCache = new Map<string, ReturnType<typeof parseVzdumpLog>>();
const TASKS_PER_NODE = 50;

async function pollCluster(c: PveCluster, pbs: PbsSettings, log?: FastifyBaseLogger) {
  const [resources, storages, jobs, nodes] = await Promise.all([
    pveGet<ApiResource[]>(c, '/cluster/resources?type=vm'),
    pveGet<ApiStorage[]>(c, '/storage'),
    pveGet<ApiJob[]>(c, '/cluster/backup'),
    pveGet<{ node: string; status: string }[]>(c, '/nodes'),
  ]);
  const online = nodes.filter((n) => n.status === 'online').map((n) => n.node);
  const tz = online.length
    ? await pveGet<{ timezone?: string }>(c, `/nodes/${encodeURIComponent(online[0])}/time`).then((t) => t.timezone || 'UTC').catch(() => 'UTC')
    : (c.timezone ?? 'UTC');
  const targets = followedStorages(storages, pbs);

  const pools = new Map<string, Set<number>>();
  for (const pool of new Set(jobs.map((j) => j.pool).filter((p): p is string => !!p))) {
    const p = await pveGet<{ members: { vmid?: number }[] }>(c, `/pools/${encodeURIComponent(pool)}`).catch(() => ({ members: [] }));
    pools.set(pool, new Set(p.members.map((m) => m.vmid).filter((v): v is number => typeof v === 'number')));
  }

  // last vzdump tasks of each online node, and the logs of the multi-guest ones not read yet
  const tasks: ApiTask[] = [];
  for (const node of online) {
    const list = await pveGet<ApiTask[]>(c, `/nodes/${encodeURIComponent(node)}/tasks?typefilter=vzdump&limit=${TASKS_PER_NODE}`).catch(() => []);
    for (const t of list) {
      tasks.push({ ...t, node });
      if (!t.id && t.endtime && !logCache.has(`${c.id}|${t.upid}`)) {
        const lines = await pveGet<{ t: string }[]>(c, `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(t.upid)}/log?limit=10000`).catch(() => null);
        if (lines) logCache.set(`${c.id}|${t.upid}`, parseVzdumpLog(lines.map((l) => l.t)));
      }
    }
  }
  tasks.sort((a, b) => (b.endtime ?? 0) - (a.endtime ?? 0));

  const vzdump = jobs.filter((j) => !j.type || j.type === 'vzdump');
  const now = new Date();
  const docs: GuestDoc[] = [];
  for (const r of resources) {
    if (truthy(r.template) || (r.type !== 'lxc' && r.type !== 'qemu')) continue;
    const config = await pveGet<Record<string, unknown>>(c, `/nodes/${encodeURIComponent(r.node)}/${r.type}/${r.vmid}/config`).catch(() => null);
    const refs: PveJobRef[] = vzdump
      .filter((j) => jobCovers(j, r, pools))
      .map((j) => {
        const t = j.storage ? targets.get(j.storage) : undefined;
        return {
          id: j.id,
          schedule: j.schedule ?? '',
          enabled: j.enabled === undefined ? true : truthy(j.enabled),
          nextRun: j['next-run'] ? j['next-run'] * 1000 : null,
          storage: j.storage ?? '',
          store: t?.store ?? null,
          ns: t ? t.ns : null,
        };
      });
    let lastTask: PveTaskResult | null = null;
    for (const t of tasks) {
      const res = guestResult(t, r.vmid, logCache.get(`${c.id}|${t.upid}`));
      if (res) {
        lastTask = res;
        break;
      }
    }
    docs.push({
      _id: `${c.id}/${r.vmid}`,
      cluster: c.id,
      vmid: r.vmid,
      type: r.type,
      node: r.node,
      name: r.name ?? '',
      macs: config ? configMacs(config) : [],
      jobs: refs,
      lastTask,
      tz,
      seenAt: now,
    });
  }
  for (const d of docs) await guests.replaceOne({ _id: d._id }, d, { upsert: true });
  await guests.deleteMany({ cluster: c.id, seenAt: { $lt: now } });
  // the cache only needs the tasks still listed
  const listed = new Set(tasks.map((t) => `${c.id}|${t.upid}`));
  for (const k of logCache.keys()) if (k.startsWith(`${c.id}|`) && !listed.has(k)) logCache.delete(k);
  log?.info({ cluster: c.id, guests: docs.length }, 'PVE polled');
  return { tz, guests: docs.length };
}

let polling: Promise<void> | null = null;

export function pollPve(log?: FastifyBaseLogger) {
  polling ??= doPoll(log).finally(() => (polling = null));
  return polling;
}

async function doPoll(log?: FastifyBaseLogger) {
  const s = await loadPveSettings();
  const pbs = await loadPbsSettings();
  for (const c of s.clusters) {
    if (!c.enabled) continue;
    let set: Partial<PveCluster>;
    try {
      const r = await pollCluster(c, pbs, log);
      set = { polledAt: new Date(), pollError: null, timezone: r.tz, guests: r.guests };
    } catch (err) {
      set = { polledAt: new Date(), pollError: (err as Error).message };
      log?.warn({ err, cluster: c.id }, 'PVE poll failed');
    }
    const fields = Object.fromEntries(Object.entries(set).map(([k, v]) => [`clusters.$.${k}`, v]));
    await settings.updateOne({ _id: 'pve', 'clusters.id': c.id } as never, { $set: fields });
  }
  // guests of clusters removed from the settings
  await guests.deleteMany({ cluster: { $nin: s.clusters.map((c) => c.id) } });
  await refreshLinks();
  publish('backups', {});
}

// Links hosts and guests (MAC addresses), then attaches to each linked host the groups its jobs write.
// Only reads the database: also run when an agent reports new MAC addresses.
export async function refreshLinks() {
  const all = await guests.find().toArray();
  const byId = new Map(all.map((g) => [g._id, g]));
  const list = await hosts.find({}, { projection: { _id: 1, 'info.macs': 1, pve: 1 } }).toArray();
  const matched = matchGuests(
    list.map((h) => ({ _id: h._id, macs: h.info?.macs ?? [] })),
    all,
  );

  const keys = new Set<string>();
  for (const h of list) {
    const g = byId.get(matched.get(h._id.toHexString()) ?? '');
    const link: HostPveLink | null = g
      ? { cluster: g.cluster, vmid: g.vmid, type: g.type, node: g.node, name: g.name, covered: g.jobs.some((j) => j.enabled) }
      : null;
    if (JSON.stringify(link) !== JSON.stringify(h.pve ?? null)) {
      await hosts.updateOne({ _id: h._id }, link ? { $set: { pve: link } } : { $unset: { pve: '' } });
      const doc = await hosts.findOne({ _id: h._id });
      if (doc) publish('host', hostDto(doc));
    }
    if (!g) continue;
    // one group per datastore/namespace written by its jobs
    const byKey = new Map<string, { store: string; ns: string; jobs: PveJobRef[] }>();
    for (const j of g.jobs) {
      if (j.store === null || j.ns === null) continue;
      const k = groupKey(j.store, j.ns, g.type === 'lxc' ? 'ct' : 'vm', String(g.vmid));
      const cur = byKey.get(k) ?? { store: j.store, ns: j.ns, jobs: [] };
      cur.jobs.push(j);
      byKey.set(k, cur);
    }
    for (const [k, v] of byKey) {
      keys.add(k);
      await backups.updateOne(
        { _id: k },
        {
          $set: { hostId: h._id, source: 'vzdump', pve: { cluster: g.cluster, vmid: g.vmid, tz: g.tz, jobs: v.jobs, lastTask: g.lastTask ?? null } },
          $setOnInsert: {
            store: v.store,
            ns: v.ns,
            type: g.type === 'lxc' ? 'ct' : 'vm',
            backupId: String(g.vmid),
            count: 0,
            lastBackup: 0,
            size: null,
            verify: null,
            times: [],
            seenAt: new Date(0),
            placeholder: true,
          },
        },
        { upsert: true },
      );
    }
  }
  // groups no longer written for a linked host: placeholders go, the others become orphans
  await backups.deleteMany({ source: 'vzdump', placeholder: true, _id: { $nin: [...keys] } });
  await backups.updateMany({ source: 'vzdump', _id: { $nin: [...keys] } }, { $set: { hostId: null }, $unset: { source: '', pve: '' } });
}

export function startPvePoller(log: FastifyBaseLogger) {
  const run = () => pollPve(log).catch((err) => log.error({ err }, 'PVE poll failed'));
  const first = setTimeout(run, 45_000);
  const timer = setInterval(run, 15 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
