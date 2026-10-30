import type { FastifyBaseLogger } from 'fastify';
import { ObjectId } from 'mongodb';
import { backups, guests, hosts, roles, settings } from './db.js';
import { publish } from './events.js';
import { hostDto } from './hostDto.js';
import { HISTORY, groupKey, loadPbsSettings } from './pbs.js';
import { rolesSaved } from './roleEvents.js';
import { allRoles, loadRoles, newRoleId } from './roles.js';
import { apiGet, normalizeFingerprint } from './tlsApi.js';
import type { BackupSnapshot, GuestDoc, HostPveLink, HostPveLost, PbsSettings, PveCluster, PveClusterRole, PveJobRef, PveNode, PveSettings, PveTaskResult } from './types.js';

// Proxmox VE clusters, read through their API with a read-only token (PVEAuditor): the inventory (nodes, guests, their
// MAC addresses), the vzdump backup jobs and the result of their last tasks. A host of the hub is the guest that has
// one of its MAC addresses (deterministic, nothing is written on Proxmox); the groups the jobs of that guest write on
// the followed PBS, and its archives on the other storages of its jobs, are attached to it automatically. A link that
// breaks is set aside on the host (pveLost), offered again when the inventory matches, never restored on its own.

export const CLUSTER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const PVE_TOKEN_ID_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/;

// The clusters followed: the pve-cluster roles of the hub, read from the database (the poll writes their state).
export async function loadPveSettings(): Promise<PveSettings> {
  const list = (await roles.find({ type: 'pve-cluster' }).sort({ name: 1 }).toArray()) as PveClusterRole[];
  return { _id: 'pve', clusters: list.map(clusterOf) };
}

// A pve-cluster role as pve.ts reads it, and back.
export function clusterOf(r: PveClusterRole): PveCluster {
  const { cluster, ...rest } = r.config;
  return { ...rest, id: cluster, name: r.name, agent: { hostId: r.carrier.id.toHexString() } };
}

export function roleOf(c: PveCluster & { agent: { hostId: string } }, _id: string, createdAt: Date): PveClusterRole {
  const { id, name, agent, ...rest } = c;
  return { _id, type: 'pve-cluster', name, carrier: { kind: 'host', id: new ObjectId(agent.hostId) }, config: { ...rest, cluster: id }, createdAt };
}

// Saves a cluster as its role (created if new, its node as carrier).
export async function savePveCluster(c: PveCluster & { agent: { hostId: string } }) {
  const current = allRoles().find((r): r is PveClusterRole => r.type === 'pve-cluster' && r.config.cluster === c.id);
  const _id = current?._id ?? newRoleId(`pve-${c.id}`, (x) => allRoles().some((r) => r._id === x));
  const next = roleOf(c, _id, current?.createdAt ?? new Date());
  await roles.replaceOne({ _id }, next, { upsert: true });
  await rolesSaved(current && !current.carrier.id.equals(next.carrier.id) ? [current.carrier.id, next.carrier.id] : [next.carrier.id]);
}

export async function removePveCluster(id: string) {
  const current = allRoles().find((r): r is PveClusterRole => r.type === 'pve-cluster' && r.config.cluster === id);
  if (!current) return;
  await roles.deleteOne({ _id: current._id });
  await rolesSaved([current.carrier.id]);
}

// The clusters were stored in the settings (pve) before they were roles of the hub. A cluster without its node (not
// expected: the token is made by the agent of a node) keeps the settings, to be looked at.
export async function migratePveClusters(log?: FastifyBaseLogger) {
  const s = (await settings.findOne({ _id: 'pve' })) as PveSettings | null;
  if (!s) return;
  const done = await roles.find({ type: 'pve-cluster' }, { projection: { 'config.cluster': 1 } }).toArray();
  const taken = new Set((await roles.find({}, { projection: { _id: 1 } }).toArray()).map((r) => r._id));
  let orphans = 0;
  for (const c of s.clusters) {
    if (done.some((r) => (r as PveClusterRole).config.cluster === c.id)) continue;
    if (!c.agent?.hostId || !ObjectId.isValid(c.agent.hostId)) {
      orphans++;
      log?.warn({ cluster: c.id }, 'PVE cluster without its node: not migrated to a role, kept in the settings');
      continue;
    }
    const _id = newRoleId(`pve-${c.id}`, (x) => taken.has(x));
    taken.add(_id);
    await roles.insertOne(roleOf({ ...c, agent: c.agent }, _id, new Date()));
  }
  if (!orphans) await settings.deleteOne({ _id: 'pve' });
}

// The role was pve-reporting before it was the inventory of the cluster: same id, same config.
export async function migratePveRoleType() {
  await roles.updateMany({ type: 'pve-reporting' } as never, { $set: { type: 'pve-cluster' } });
}

// Corosync cluster of a node, announced by its agent in its capabilities (agent/main.go): `pve_cluster:<name>`.
export const pveClusterOf = (caps?: string[]) => caps?.find((c) => c.startsWith('pve_cluster:'))?.slice('pve_cluster:'.length) || null;

// Cluster already followed (other than `exceptId`) through a node of the same corosync cluster as `caps`.
// `caps` of the agents of the followed clusters, by host id.
export function followedCluster(clusters: PveCluster[], capsOf: (hostId: string) => string[] | undefined, caps: string[] | undefined, exceptId?: string) {
  const name = pveClusterOf(caps);
  if (!name) return null;
  return clusters.find((c) => c.id !== exceptId && c.agent && pveClusterOf(capsOf(c.agent.hostId)) === name) ?? null;
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
  status?: string;
  template?: number;
}
export interface ApiStorage {
  storage: string;
  type: string;
  datastore?: string;
  namespace?: string;
  server?: string;
  fingerprint?: string;
  shared?: number | boolean;
  nodes?: string; // nodes it is enabled on, comma separated; absent: all
}
export interface ApiContent {
  volid: string;
  vmid?: number | string;
  ctime?: number;
  size?: number;
  notes?: string;
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

// Storage and guests of a vzdump task log: started, finished, failed (with the reason).
export function parseVzdumpLog(lines: string[]) {
  let storage: string | undefined;
  const started = new Set<number>();
  const finished = new Set<number>();
  const failed = new Map<number, string>();
  for (const l of lines) {
    let m = /starting new backup job: vzdump .*--storage (\S+)/.exec(l);
    if (m) storage = m[1];
    m = /Starting Backup of VM (\d+)/.exec(l);
    if (m) started.add(Number(m[1]));
    m = /Finished Backup of VM (\d+)/.exec(l);
    if (m) finished.add(Number(m[1]));
    m = /ERROR: Backup of VM (\d+) failed(?: - (.*))?/.exec(l);
    if (m) failed.set(Number(m[1]), (m[2] ?? 'échec').trim());
  }
  return { storage, started, finished, failed };
}

const taskOk = (status?: string) => status === 'OK' || !!status?.startsWith('WARNINGS');

// Result of one guest in a finished task: from the task itself when it backs up only this guest,
// from its log otherwise; undefined when the guest is not part of it.
export function guestResult(task: ApiTask, vmid: number, log?: ReturnType<typeof parseVzdumpLog>): PveTaskResult | undefined {
  if (!task.endtime || !task.status) return undefined;
  const base = { upid: task.upid, at: task.endtime * 1000, ...(log?.storage ? { storage: log.storage } : {}) };
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

// Guests with a MAC address another guest has too (clones): they designate no host.
export function sharedMacGuests(all: Pick<GuestDoc, '_id' | 'macs'>[]) {
  const byMac = new Map<string, Set<string>>();
  for (const g of all) for (const m of g.macs) byMac.set(m, (byMac.get(m) ?? new Set()).add(g._id));
  const out = new Set<string>();
  for (const ids of byMac.values()) if (ids.size > 1) ids.forEach((id) => out.add(id));
  return out;
}

const sameGuest = (a: Pick<HostPveLink, 'cluster' | 'vmid'>, b: Pick<HostPveLink, 'cluster' | 'vmid'>) => a.cluster === b.cluster && a.vmid === b.vmid;

// The link of a host after a poll: its current one, the one set aside, and the guest it matches now (null: none). A
// link that breaks (guest gone or another one matched) is set aside; one set aside is only ever offered again
// (candidate), restored by hand (restorePveLink) or forgotten.
export function nextLink(cur: HostPveLink | null, lost: HostPveLost | null, found: HostPveLink | null, now: Date): { pve: HostPveLink | null; lost: HostPveLost | null } {
  if (cur) return found && sameGuest(found, cur) ? { pve: found, lost: null } : { pve: null, lost: { link: cur, at: now, candidate: found } };
  if (lost) return { pve: null, lost: { ...lost, candidate: found } };
  return { pve: found, lost: null };
}

// vzdump archives of the storages of the jobs other than the followed PBS, by storage then vmid (oldest first). A
// shared storage is listed on one node, a local one on each node it is enabled on. One that cannot be listed is absent,
// and so is one listed without any archive: Proxmox hides the archives from a token without VM.Backup (PVEAuditor).
async function listArchives(c: PveCluster, storages: ApiStorage[], jobs: ApiJob[], followed: Map<string, unknown>, online: string[]) {
  const out = new Map<string, Map<number, BackupSnapshot[]>>();
  const wanted = new Set(jobs.map((j) => j.storage).filter((x): x is string => !!x && !followed.has(x)));
  for (const id of wanted) {
    const st = storages.find((x) => x.storage === id);
    if (!st) continue;
    const enabled = st.nodes ? st.nodes.split(',').map((n) => n.trim()) : null;
    const on = online.filter((n) => !enabled || enabled.includes(n));
    const byVmid = new Map<number, BackupSnapshot[]>();
    let listed = false;
    for (const node of truthy(st.shared) ? on.slice(0, 1) : on) {
      const list = await pveGet<ApiContent[]>(c, `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(id)}/content?content=backup`).catch(() => null);
      if (!list) continue;
      listed = true;
      for (const v of list) {
        const vmid = Number(v.vmid);
        if (!Number.isInteger(vmid) || !v.ctime) continue;
        byVmid.set(vmid, [...(byVmid.get(vmid) ?? []), { t: v.ctime * 1000, verify: null, size: v.size ?? null, note: v.notes ?? null }]);
      }
    }
    if (!listed || !byVmid.size) continue;
    for (const list of byVmid.values()) list.sort((a, b) => a.t - b.t);
    out.set(id, byVmid);
  }
  return out;
}

// The host of each node of a cluster: an agent of the same corosync cluster as the carrier (the carrier alone for a
// node without cluster) whose hostname is the node name; null: no agent on it.
export function nodeHosts<H extends { _id: ObjectId; name: string; capabilities?: string[]; info?: { hostname?: string } }>(c: Pick<PveCluster, 'agent'>, nodes: string[], list: H[]) {
  const carrier = list.find((h) => h._id.toHexString() === c.agent?.hostId);
  const corosync = pveClusterOf(carrier?.capabilities);
  const members = list.filter((h) => h.capabilities?.includes('pve') && (h === carrier || (!!corosync && pveClusterOf(h.capabilities) === corosync)));
  const short = (x: string) => x.toLowerCase().split('.')[0];
  return new Map(nodes.map((n) => [n, members.find((h) => short(h.info?.hostname || h.name) === short(n)) ?? (nodes.length === 1 && carrier ? carrier : null)]));
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
  // a guest whose config cannot be read (its node offline) keeps the MAC addresses of the last poll, and its link
  const previous = new Map((await guests.find({ cluster: c.id }, { projection: { macs: 1, hostId: 1, ambiguous: 1 } }).toArray()).map((g) => [g._id, g]));
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
      // the log of a finished task gives its storage; a multi-guest one also tells which guests it backed up
      if (t.endtime && !logCache.has(`${c.id}|${t.upid}`)) {
        const lines = await pveGet<{ t: string }[]>(c, `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(t.upid)}/log?limit=${t.id ? 5 : 10000}`).catch(() => null);
        if (lines) logCache.set(`${c.id}|${t.upid}`, parseVzdumpLog(lines.map((l) => l.t)));
      }
    }
  }
  tasks.sort((a, b) => (b.endtime ?? 0) - (a.endtime ?? 0));

  const vzdump = jobs.filter((j) => !j.type || j.type === 'vzdump');
  const archives = await listArchives(c, storages, vzdump, targets, online);
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
    // last task and last successful one, of a storage (a task whose storage is unknown counts for any)
    const resultOf = (storage?: string) => {
      let lastTask: PveTaskResult | null = null;
      let lastOk: PveTaskResult | null = null;
      for (const t of tasks) {
        const res = guestResult(t, r.vmid, logCache.get(`${c.id}|${t.upid}`));
        if (!res || (storage && res.storage && res.storage !== storage)) continue;
        lastTask ??= res;
        if (res.ok) {
          lastOk = res;
          break;
        }
      }
      return { lastTask, lastOk };
    };
    const { lastTask, lastOk } = resultOf();
    const _id = `${c.id}/${r.vmid}`;
    const before = previous.get(_id);
    const stored = [...new Set(refs.map((j) => j.storage))].filter((x) => archives.has(x));
    docs.push({
      _id,
      cluster: c.id,
      vmid: r.vmid,
      type: r.type,
      node: r.node,
      name: r.name ?? '',
      status: r.status ?? 'unknown',
      macs: config ? configMacs(config) : (before?.macs ?? []),
      ...(typeof config?.ostype === 'string' ? { ostype: config.ostype } : {}),
      ...(typeof config?.arch === 'string' ? { arch: config.arch } : {}),
      jobs: refs,
      lastTask,
      lastOk,
      results: [...new Set(refs.map((j) => j.storage))].map((x) => ({ storage: x, ...resultOf(x) })),
      ...(stored.length ? { archives: stored.map((x) => ({ storage: x, times: (archives.get(x)!.get(r.vmid) ?? []).slice(-HISTORY) })) } : {}),
      tz,
      seenAt: now,
      hostId: before?.hostId ?? null,
      ambiguous: !!before?.ambiguous,
    });
  }
  for (const d of docs) await guests.replaceOne({ _id: d._id }, d, { upsert: true });
  await guests.deleteMany({ cluster: c.id, seenAt: { $lt: now } });
  // the cache only needs the tasks still listed
  const listed = new Set(tasks.map((t) => `${c.id}|${t.upid}`));
  for (const k of logCache.keys()) if (k.startsWith(`${c.id}|`) && !listed.has(k)) logCache.delete(k);
  log?.info({ cluster: c.id, guests: docs.length }, 'PVE polled');
  const pveNodes: PveNode[] = nodes.map((n) => ({ node: n.node, online: n.status === 'online' })).sort((a, b) => a.node.localeCompare(b.node));
  return { tz, guests: docs.length, nodes: pveNodes };
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
    let set: Partial<PveCluster>;
    try {
      const r = await pollCluster(c, pbs, log);
      set = { polledAt: new Date(), pollError: null, timezone: r.tz, guests: r.guests, nodes: r.nodes };
    } catch (err) {
      set = { polledAt: new Date(), pollError: (err as Error).message };
      log?.warn({ err, cluster: c.id }, 'PVE poll failed');
    }
    const fields = Object.fromEntries(Object.entries(set).map(([k, v]) => [`config.${k}`, v]));
    await roles.updateOne({ type: 'pve-cluster', 'config.cluster': c.id }, { $set: fields });
  }
  // the state of the poll, shown with the roles
  await loadRoles();
  // guests of clusters no longer followed
  await guests.deleteMany({ cluster: { $nin: s.clusters.map((c) => c.id) } });
  await refreshLinks();
  publish('backups', {});
}

const linkOf = (g: GuestDoc): HostPveLink => ({ cluster: g.cluster, vmid: g.vmid, type: g.type, node: g.node, name: g.name, covered: g.jobs.some((j) => j.enabled) });

// Links hosts and guests (MAC addresses), then attaches to each linked host the groups its jobs write on the followed
// PBS and its archives on the other storages of its jobs. Only reads the database: also run when an agent reports new
// MAC addresses. A host without MAC addresses (not reported yet) keeps its link as it is.
export async function refreshLinks() {
  const all = await guests.find().toArray();
  const byId = new Map(all.map((g) => [g._id, g]));
  const list = await hosts.find({}, { projection: { _id: 1, 'info.macs': 1, pve: 1, pveLost: 1 } }).toArray();
  const matched = matchGuests(
    list.map((h) => ({ _id: h._id, macs: h.info?.macs ?? [] })),
    all,
  );
  const now = new Date();
  const owners = new Map<string, string>();

  const keys = new Set<string>();
  for (const h of list) {
    const found = byId.get(matched.get(h._id.toHexString()) ?? '');
    const cur = { pve: h.pve ?? null, lost: h.pveLost ?? null };
    const next = h.info?.macs?.length ? nextLink(cur.pve, cur.lost, found ? linkOf(found) : null, now) : cur;
    if (JSON.stringify(next) !== JSON.stringify(cur)) await saveLink(h._id, next);
    const g = next.pve ? byId.get(`${next.pve.cluster}/${next.pve.vmid}`) : undefined;
    if (!g) continue;
    owners.set(g._id, h._id.toHexString());
    const type = g.type === 'lxc' ? 'ct' : 'vm';
    // one group per datastore/namespace of the followed PBS written by its jobs
    const byKey = new Map<string, { store: string; ns: string; jobs: PveJobRef[] }>();
    for (const j of g.jobs) {
      if (j.store === null || j.ns === null) continue;
      const k = groupKey(j.store, j.ns, type, String(g.vmid));
      const entry = byKey.get(k) ?? { store: j.store, ns: j.ns, jobs: [] };
      entry.jobs.push(j);
      byKey.set(k, entry);
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
            type,
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
    // one group per other storage of its jobs (local, NFS, another PBS), read on Proxmox: not on the followed PBS. A
    // storage whose archives cannot be seen dates its last backup from the last successful task.
    for (const storage of new Set(g.jobs.filter((j) => j.store === null && j.storage).map((j) => j.storage))) {
      const k = `pve/${g.cluster}/${storage}/${type}/${g.vmid}`;
      keys.add(k);
      const times = g.archives?.find((a) => a.storage === storage)?.times;
      const last = times?.at(-1);
      const res = g.results?.find((x) => x.storage === storage) ?? { lastTask: g.lastTask, lastOk: g.lastOk };
      await backups.updateOne(
        { _id: k },
        {
          $set: {
            store: storage,
            ns: '',
            type,
            backupId: String(g.vmid),
            comment: g.name,
            count: times?.length ?? 0,
            lastBackup: times ? (last?.t ?? 0) : (res.lastOk?.at ?? 0),
            size: last?.size ?? null,
            verify: null,
            times: times ?? [],
            unlisted: !times,
            hostId: h._id,
            source: 'pve-storage',
            pve: { cluster: g.cluster, vmid: g.vmid, tz: g.tz, jobs: g.jobs.filter((j) => j.storage === storage), lastTask: res.lastTask ?? null },
            seenAt: now,
          },
        },
        { upsert: true },
      );
    }
  }
  // the inventory shows the host of each guest, or why it has none
  const shared = sharedMacGuests(all);
  for (const g of all) {
    const hostId = owners.get(g._id) ?? null;
    const ambiguous = shared.has(g._id);
    if (g.hostId !== hostId || !!g.ambiguous !== ambiguous) await guests.updateOne({ _id: g._id }, { $set: { hostId, ambiguous } });
  }
  // groups no longer written for a linked host: the archives of the other storages go (read on Proxmox again once
  // linked), placeholders go, the others become orphans
  await backups.deleteMany({ source: 'pve-storage', _id: { $nin: [...keys] } });
  await backups.deleteMany({ source: 'vzdump', placeholder: true, _id: { $nin: [...keys] } });
  await backups.updateMany({ source: 'vzdump', _id: { $nin: [...keys] } }, { $set: { hostId: null }, $unset: { source: '', pve: '' } });
}

async function saveLink(hostId: ObjectId, next: { pve: HostPveLink | null; lost: HostPveLost | null }) {
  const set: Record<string, unknown> = {};
  const unset: Record<string, ''> = {};
  if (next.pve) set.pve = next.pve;
  else unset.pve = '';
  if (next.lost) set.pveLost = next.lost;
  else unset.pveLost = '';
  await hosts.updateOne({ _id: hostId }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  const doc = await hosts.findOne({ _id: hostId });
  if (doc) publish('host', hostDto(doc));
}

export class PveLinkError extends Error {}

// The link set aside of a host, restored on the guest it matches now (the same one, or another one: a restore under a
// new vmid), then its groups attached again.
export async function restorePveLink(hostId: ObjectId) {
  const h = await hosts.findOne({ _id: hostId }, { projection: { pveLost: 1 } });
  if (!h?.pveLost) throw new PveLinkError("cet hôte n'a pas de lien Proxmox VE mis de côté");
  if (!h.pveLost.candidate) throw new PveLinkError("aucune VM ni aucun CT de l'inventaire ne correspond à cet hôte");
  await saveLink(hostId, { pve: h.pveLost.candidate, lost: null });
  await refreshLinks();
  publish('backups', {});
}

// The link set aside is dropped: a guest the host matches is then linked as a first link.
export async function forgetPveLink(hostId: ObjectId) {
  const h = await hosts.findOne({ _id: hostId }, { projection: { pveLost: 1 } });
  if (!h?.pveLost) throw new PveLinkError("cet hôte n'a pas de lien Proxmox VE mis de côté");
  await saveLink(hostId, { pve: null, lost: null });
  await refreshLinks();
  publish('backups', {});
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
