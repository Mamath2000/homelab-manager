import type { FastifyBaseLogger } from 'fastify';
import type { ObjectId } from 'mongodb';
import { refreshManaged, groupConflict, syncAll, syncHost } from './backupJobs.js';
import { backupJobs, backups, backupStats, guests, hosts, settings } from './db.js';
import { publish } from './events.js';
import { isPluginJob } from './nextcloud.js';
import { loadRemoteSettings, pollOffsite, syncJobId } from './offsite.js';
import { loadPbsSettings, pbsConnected, pollPbs } from './pbs.js';
import { deletePbsToken, ensurePbsToken, PBS_TOKEN_ACLS, PbsAgentError, sameLink } from './pbsAgent.js';
import { openCredential, resealSoon } from './storedSecrets.js';
import { OFF_PBS_SOURCES, type BackupDoc, type BackupJobDoc, type GuestDoc, type HostDoc, type NextcloudPlugin, type PbsServerChange, type PbsSettings } from './types.js';

// Changes of the main PBS (#378): datastores removed or added, groups moved from a datastore to another, server
// replaced. What can only fail and is reversible is done at once (the copy of a gone group stops, offsite.ts; the
// tokens of the hosts get their rights on a new datastore); what needs a choice is offered to the admin, who
// applies it at once for every item (the dialog of the changes):
// - a group gone from a datastore and found once elsewhere (same namespace, type, id): its settings carried over to
//   the group it moved to (host attached by hand, threshold, offsite copy, statistics), the old one forgotten;
// - a group gone with nowhere to go: kept (its host is warned) or forgotten;
// - a backup job of the hub on a datastore no longer there: another datastore chosen;
// - the plugin Nextcloud of a host, a backup job of Proxmox VE on such a datastore: pointed at (changed there);
// - another server (agent or fingerprint changed): the same one at a new address, or a new one, whose tokens (hosts,
//   reader of the secondary) are created on it and the old ones revoked.

// --- what changed (pure) ----------------------------------------------------------------------

export type ChangeGroup = Pick<BackupDoc, '_id' | 'store' | 'ns' | 'type' | 'backupId' | 'comment' | 'hostId' | 'source' | 'placeholder' | 'gone' | 'staleHours' | 'offsite' | 'lastBackup' | 'count'>;
export type ChangeJob = Pick<BackupJobDoc, '_id' | 'hostId' | 'name' | 'store' | 'ns' | 'backupId' | 'plugin'>;
export type ChangeGuest = Pick<GuestDoc, 'cluster' | 'jobs'>;
export type ChangeNextcloud = { hostId: ObjectId; plugin: Pick<NextcloudPlugin, 'database' | 'config' | 'users'> };

// Groups of the PBS (not the placeholders of the jobs, nor the backups kept elsewhere).
const onPbs = (g: Pick<BackupDoc, 'placeholder' | 'source'>) => !g.placeholder && !(OFF_PBS_SOURCES as readonly string[]).includes(g.source ?? '');
const twinKey = (g: Pick<BackupDoc, 'ns' | 'type' | 'backupId'>) => `${g.ns}/${g.type}/${g.backupId}`;

// What a moved group hands to the one it moved to. The host only when attached by hand (a job of the hub or of
// Proxmox VE attaches the new group itself) and the new one has none; nothing the new one already has is replaced.
export interface Carry {
  hostId: boolean;
  staleHours: boolean;
  offsite: boolean;
  conflict: string | null; // attached by hand to a host, the new one to another: the host is not carried
}

export function carryOf(from: ChangeGroup, to: ChangeGroup): Carry {
  const byHand = !!from.hostId && !from.source;
  const other = byHand && !!to.hostId && !to.hostId.equals(from.hostId!);
  return {
    hostId: byHand && !to.hostId,
    staleHours: !!from.staleHours && to.staleHours == null,
    offsite: !!from.offsite?.enabled && !to.offsite?.enabled,
    conflict: other ? 'le nouveau groupe est rattaché à un autre hôte' : null,
  };
}

export interface Moved {
  from: ChangeGroup;
  to: ChangeGroup;
  carry: Carry;
}

// The gone groups: moved (one group alive elsewhere with the same namespace, type and id) or vanished (none, or
// several: which one is the same backup is not for the hub to guess).
export function movedGroups(groups: ChangeGroup[]) {
  const alive = new Map<string, ChangeGroup[]>();
  for (const g of groups) if (!g.gone && onPbs(g)) alive.set(twinKey(g), [...(alive.get(twinKey(g)) ?? []), g]);
  const moved: Moved[] = [];
  const vanished: { group: ChangeGroup; candidates: number }[] = [];
  for (const g of groups) {
    if (!g.gone || !onPbs(g)) continue;
    const there = (alive.get(twinKey(g)) ?? []).filter((o) => o.store !== g.store);
    if (there.length === 1) moved.push({ from: g, to: there[0], carry: carryOf(g, there[0]) });
    else vanished.push({ group: g, candidates: there.length });
  }
  const by = (a: ChangeGroup, b: ChangeGroup) => a._id.localeCompare(b._id);
  return { moved: moved.sort((a, b) => by(a.from, b.from)), vanished: vanished.sort((a, b) => by(a.group, b.group)) };
}

export interface PveOnRemoved {
  cluster: string;
  job: string;
  storage: string;
  store: string;
  guests: number;
}

// Backup jobs of Proxmox VE writing to a datastore of the PBS that is no longer there (the hub reads Proxmox VE only).
export function pveOnRemoved(list: ChangeGuest[], stores: Set<string>): PveOnRemoved[] {
  const by = new Map<string, PveOnRemoved>();
  for (const g of list) {
    for (const j of g.jobs ?? []) {
      if (!j.store || stores.has(j.store)) continue;
      const k = `${g.cluster}/${j.id}`;
      const cur = by.get(k) ?? { cluster: g.cluster, job: j.id, storage: j.storage, store: j.store, guests: 0 };
      cur.guests++;
      by.set(k, cur);
    }
  }
  return [...by.values()].sort((a, b) => `${a.cluster}/${a.job}`.localeCompare(`${b.cluster}/${b.job}`));
}

// Datastores of the plugin Nextcloud of a host that are no longer there.
export function nextcloudOnRemoved(p: ChangeNextcloud['plugin'], stores: Set<string>) {
  return [...new Set([p.database, p.config, ...p.users.map((u) => u.store)].filter((s): s is string => !!s && !stores.has(s)))].sort();
}

export interface ChangeInput {
  stores: string[]; // datastores of the main PBS at its last poll
  groups: ChangeGroup[];
  jobs: ChangeJob[];
  nextcloud: ChangeNextcloud[];
  guests: ChangeGuest[];
}

// Everything to decide, from the state of the hub. No datastore known (never polled): nothing.
export function computeChanges(i: ChangeInput) {
  if (!i.stores.length) return { removedStores: [] as string[], moved: [] as Moved[], vanished: [] as ReturnType<typeof movedGroups>['vanished'], jobs: [] as ChangeJob[], nextcloud: [] as { hostId: ObjectId; stores: string[] }[], pve: [] as PveOnRemoved[] };
  const stores = new Set(i.stores);
  const { moved, vanished } = movedGroups(i.groups);
  const jobs = i.jobs.filter((j) => !isPluginJob(j) && !stores.has(j.store));
  const nextcloud = i.nextcloud.map((n) => ({ hostId: n.hostId, stores: nextcloudOnRemoved(n.plugin, stores) })).filter((n) => n.stores.length);
  const pve = pveOnRemoved(i.guests, stores);
  // datastores the hub still knows something of
  const removed = new Set<string>();
  for (const g of i.groups) if (g.gone && onPbs(g) && !stores.has(g.store)) removed.add(g.store);
  for (const j of jobs) removed.add(j.store);
  for (const n of nextcloud) n.stores.forEach((s) => removed.add(s));
  for (const p of pve) removed.add(p.store);
  return { removedStores: [...removed].sort(), moved, vanished, jobs, nextcloud, pve };
}

export type Changes = ReturnType<typeof computeChanges>;

// What the hub sets on the group a moved one hands over to.
export function carriedSet(from: ChangeGroup, to: ChangeGroup, carry: Carry): Partial<BackupDoc> {
  const set: Partial<BackupDoc> = {};
  if (carry.hostId) set.hostId = from.hostId;
  if (carry.staleHours) set.staleHours = from.staleHours;
  if (carry.offsite && from.offsite) {
    // the copies on the secondary are the same (its target group is namespace + type/id): only the job changes
    set.offsite = { ...from.offsite, enabled: true, jobId: syncJobId(to.store, to.ns), error: null, running: null };
  }
  return set;
}

// --- read --------------------------------------------------------------------------------------

const GROUP_FIELDS = { _id: 1, store: 1, ns: 1, type: 1, backupId: 1, comment: 1, hostId: 1, source: 1, placeholder: 1, gone: 1, staleHours: 1, offsite: 1, lastBackup: 1, count: 1 } as const;

async function loadChanges(pbs: PbsSettings) {
  const stores = pbsConnected(pbs) && !pbs.pollError ? (pbs.stores ?? []) : [];
  const [groups, jobs, plugins, guestList] = await Promise.all([
    backups.find({}, { projection: GROUP_FIELDS }).toArray(),
    backupJobs.find({}, { projection: { _id: 1, hostId: 1, name: 1, store: 1, ns: 1, backupId: 1, plugin: 1 } }).toArray(),
    hosts.find({ nextcloud: { $ne: null } }, { projection: { _id: 1, nextcloud: 1 } }).toArray(),
    guests.find({}, { projection: { cluster: 1, jobs: 1 } }).toArray(),
  ]);
  const nextcloud = plugins.filter((h) => h.nextcloud).map((h) => ({ hostId: h._id, plugin: h.nextcloud! }));
  return computeChanges({ stores, groups: groups as ChangeGroup[], jobs: jobs as ChangeJob[], nextcloud, guests: guestList as ChangeGuest[] });
}

const groupLabel = (g: Pick<BackupDoc, 'type' | 'backupId' | 'comment'>) => `${g.type}/${g.backupId}${g.comment ? ` (${g.comment})` : ''}`;

// The changes as the dialog shows them (every profile reads them; applying them is the admin's).
export async function changesView() {
  const pbs = await loadPbsSettings();
  const c = await loadChanges(pbs);
  const ids = new Set<string>();
  for (const m of c.moved) [m.from.hostId, m.to.hostId].forEach((h) => h && ids.add(h.toHexString()));
  for (const v of c.vanished) if (v.group.hostId) ids.add(v.group.hostId.toHexString());
  for (const j of c.jobs) ids.add(j.hostId.toHexString());
  for (const n of c.nextcloud) ids.add(n.hostId.toHexString());
  const names = new Map((await hosts.find({}, { projection: { name: 1 } }).toArray()).map((h) => [h._id.toHexString(), h.name]));
  const hostOf = (id: ObjectId | null | undefined) => (id ? { id: id.toHexString(), name: names.get(id.toHexString()) ?? '?' } : null);
  const server = pbs.serverChange ?? null;
  return {
    stores: pbs.stores ?? [],
    removedStores: c.removedStores,
    server: server
      ? {
          at: new Date(server.at).getTime(),
          url: server.from.url,
          currentUrl: pbs.url,
          agentChanged: !!server.from.agent && !!pbs.agent && !sameLink(server.from.agent, pbs.agent),
          certChanged: !!server.from.fingerprint && !!pbs.fingerprint && server.from.fingerprint !== pbs.fingerprint,
        }
      : null,
    moved: c.moved.map((m) => ({
      id: m.from._id,
      to: m.to._id,
      label: groupLabel(m.from),
      ns: m.from.ns,
      fromStore: m.from.store,
      toStore: m.to.store,
      fromHost: hostOf(m.from.hostId),
      toHost: hostOf(m.to.hostId),
      carry: m.carry,
    })),
    vanished: c.vanished.map((v) => ({
      id: v.group._id,
      label: groupLabel(v.group),
      store: v.group.store,
      ns: v.group.ns,
      storeRemoved: !(pbs.stores ?? []).includes(v.group.store),
      host: hostOf(v.group.hostId),
      lastBackup: v.group.lastBackup,
      count: v.group.count,
      candidates: v.candidates,
    })),
    jobs: c.jobs.map((j) => ({ id: j._id.toHexString(), name: j.name, store: j.store, ns: j.ns, backupId: j.backupId, host: hostOf(j.hostId)! })),
    nextcloud: c.nextcloud.map((n) => ({ host: hostOf(n.hostId)!, stores: n.stores })),
    pve: c.pve,
  };
}

export type ChangesView = Awaited<ReturnType<typeof changesView>>;

// Something for the admin to decide (the banner of the page Sauvegardes).
export const pendingCount = (v: Pick<ChangesView, 'server' | 'moved' | 'vanished' | 'jobs' | 'nextcloud' | 'pve'>) =>
  (v.server ? 1 : 0) + v.moved.length + v.vanished.length + v.jobs.length + v.nextcloud.length + v.pve.length;

// --- apply -------------------------------------------------------------------------------------

export interface ApplyBody {
  move?: string[]; // ids of moved groups (the old ones): their settings carried over, then forgotten
  forget?: string[]; // ids of gone groups to forget
  jobs?: { id: string; store: string }[]; // backup jobs of the hub to point at another datastore
}

export interface ApplyReport {
  moved: number;
  forgotten: number;
  jobs: number;
  errors: string[];
}

export async function applyChanges(body: ApplyBody, log?: FastifyBaseLogger): Promise<ApplyReport> {
  const pbs = await loadPbsSettings();
  const c = await loadChanges(pbs);
  const report: ApplyReport = { moved: 0, forgotten: 0, jobs: 0, errors: [] };

  // 1. moved groups: what the old one had goes to the new one, its statistics too, then it is forgotten
  const want = new Set(body.move ?? []);
  for (const m of c.moved.filter((x) => want.has(x.from._id))) {
    const set = carriedSet(m.from, m.to, m.carry);
    if (Object.keys(set).length) await backups.updateOne({ _id: m.to._id }, { $set: set });
    await backupStats.updateMany({ groupId: m.from._id }, { $set: { groupId: m.to._id } });
    await backups.deleteOne({ _id: m.from._id, gone: true });
    report.moved++;
  }
  for (const id of want) if (!c.moved.some((m) => m.from._id === id)) report.errors.push(`${id} : plus un groupe déplacé`);

  // 2. gone groups forgotten (never one still on the PBS)
  const forget = (body.forget ?? []).filter((id) => !want.has(id));
  if (forget.length) report.forgotten = (await backups.deleteMany({ _id: { $in: forget }, gone: true })).deletedCount;

  // 3. backup jobs of the hub pointed at a datastore of the PBS: the group they write must be free there
  const stores = new Set(pbs.stores ?? []);
  const touched = new Map<string, ObjectId>();
  for (const { id, store } of body.jobs ?? []) {
    const j = c.jobs.find((x) => x._id.toHexString() === id);
    if (!j) {
      report.errors.push(`job ${id} : plus sur un datastore retiré`);
      continue;
    }
    if (!stores.has(store)) {
      report.errors.push(`${j.name} : datastore ${store} absent du PBS`);
      continue;
    }
    const conflict = await groupConflict(j.hostId, store, j.ns, j.backupId, j._id);
    if (conflict) {
      report.errors.push(`${j.name} : ${conflict}`);
      continue;
    }
    await backupJobs.updateOne({ _id: j._id }, { $set: { store, updatedAt: new Date() } });
    touched.set(j.hostId.toHexString(), j.hostId);
    report.jobs++;
  }
  if (touched.size) {
    await refreshManaged();
    for (const id of touched.values()) await syncHost(id).catch((err) => log?.warn({ err, hostId: id.toHexString() }, 'backup definition not sent'));
  }

  // the copies follow the groups they moved with (reconciliation of the sync jobs)
  if (report.moved) pollOffsite(log).catch(() => {});
  publish('backups', {});
  log?.info({ ...report, errors: report.errors.length }, 'changes of the main PBS applied');
  return report;
}

// --- tokens of the hosts and new datastores -----------------------------------------------------

// The rights of the token of a host are given on the namespace Hosts of each datastore that exists when they are
// set (the agent of the PBS expands "{store}"): a datastore added since is not in them. Set again, with the secret
// the hub holds (no rotation), once per new datastore; a failure (agent of the PBS offline) is tried at the next poll.
let extending: Promise<void> | null = null;

export function extendHostTokens(log?: FastifyBaseLogger) {
  extending ??= doExtend(log).finally(() => (extending = null));
  return extending;
}

// Datastores the rights of the tokens of the hosts have to be set again for (none known: all of them, once).
export function storesToGrant(stores: string[], granted: string[] | undefined) {
  return granted ? stores.filter((s) => !granted.includes(s)) : stores;
}

async function doExtend(log?: FastifyBaseLogger) {
  const pbs = await loadPbsSettings();
  const stores = pbs.stores ?? [];
  if (!pbs.agent || !pbsConnected(pbs) || pbs.serverChange || !storesToGrant(stores, pbs.aclStores).length) return;
  const list = await hosts.find({ pbsCredential: { $exists: true } }).toArray();
  let failed = 0;
  for (const h of list) {
    const held = openCredential(h.pbsCredential)!;
    try {
      const t = await ensurePbsToken(pbs.agent, held.tokenId, PBS_TOKEN_ACLS.host, held);
      if (t.tokenSecret !== held.tokenSecret) {
        await hosts.updateOne({ _id: h._id }, { $set: { pbsCredential: { ...h.pbsCredential!, tokenSecret: t.tokenSecret, updatedAt: new Date() } } });
        resealSoon();
        await syncHost(h._id).catch(() => {});
      }
    } catch (err) {
      if (!(err instanceof PbsAgentError)) throw err;
      // the agent of the PBS offline or refusing: the others would fail the same way, tried again at the next poll
      failed++;
      log?.warn({ err, host: h.name }, 'rights of the PBS token of a host not extended to the new datastores');
      break;
    }
  }
  if (!failed) await settings.updateOne({ _id: 'pbs' }, { $set: { aclStores: stores } });
  log?.info({ hosts: list.length, failed, stores }, 'rights of the PBS tokens of the hosts set on the datastores');
}

// --- another server --------------------------------------------------------------------------------

// Recorded when the agent of the main PBS or the fingerprint of its certificate changes: the same server (moved,
// certificate renewed) or another one, the admin says which.
export function serverChangeOf(before: Pick<PbsSettings, 'agent' | 'url' | 'fingerprint' | 'tokenId' | 'serverChange'>, next: Pick<PbsSettings, 'agent' | 'fingerprint'>): PbsServerChange | null {
  if (before.serverChange) return before.serverChange; // the first server before the changes is the one to compare with
  if (!before.url || !before.tokenId) return null; // nothing connected before
  const agent = !!before.agent && !!next.agent && !sameLink(before.agent, next.agent);
  const cert = !!before.fingerprint && !!next.fingerprint && before.fingerprint !== next.fingerprint;
  if (!agent && !cert) return null;
  return { at: new Date(), from: { ...(before.agent ? { agent: before.agent } : {}), url: before.url, fingerprint: before.fingerprint, tokenId: before.tokenId } };
}

export interface ServerReport {
  hosts: string[]; // tokens of the hosts created on the new server
  reader: boolean; // reader token of the secondary created on it
  revoked: string[]; // tokens revoked on the old server
  errors: string[];
}

// The admin's answer. Same server: nothing to do. A new one: the tokens of the hosts (same ids: the groups they
// write are theirs again once copied over) and the reader token of the secondary created on it, the agents given
// them; the old tokens revoked when the old server still answers (else said, to do by hand). The groups of the old
// server are gone: the changes offer to carry their settings over to those of the new one.
export async function resolveServerChange(sameServer: boolean, log?: FastifyBaseLogger): Promise<ServerReport> {
  const pbs = await loadPbsSettings();
  const change = pbs.serverChange;
  const report: ServerReport = { hosts: [], reader: false, revoked: [], errors: [] };
  if (!change) return report;
  if (sameServer) {
    await settings.updateOne({ _id: 'pbs' }, { $unset: { serverChange: '' } });
    publish('backups', {});
    return report;
  }
  if (!pbs.agent) throw new PbsAgentError('PBS principal non relié à son agent : le déclarer dans Rôles (PBS principal)');
  const old = change.from.agent && !sameLink(change.from.agent, pbs.agent) ? change.from.agent : null;
  const toRevoke: string[] = [];

  // 1. the hosts: created again on the new server (the secret of the old one is of no use there)
  const list: HostDoc[] = await hosts.find({ pbsCredential: { $exists: true } }).sort({ name: 1 }).toArray();
  for (const h of list) {
    try {
      const t = await ensurePbsToken(pbs.agent, h.pbsCredential!.tokenId, PBS_TOKEN_ACLS.host, null);
      await hosts.updateOne({ _id: h._id }, { $set: { pbsCredential: { tokenId: t.tokenId, tokenSecret: t.tokenSecret, updatedAt: new Date(), store: '*' } } });
      report.hosts.push(h.name);
      toRevoke.push(t.tokenId);
    } catch (err) {
      if (!(err instanceof PbsAgentError)) throw err;
      report.errors.push(`${h.name} : ${err.message}`);
    }
  }

  // 2. the secondary pulls with the reader token: created on the new server, the remote entry follows (its hash)
  const remote = await loadRemoteSettings();
  if (remote.readerTokenId) {
    try {
      const t = await ensurePbsToken(pbs.agent, remote.readerTokenId, PBS_TOKEN_ACLS.reader, null);
      await settings.updateOne({ _id: 'pbs-remote' }, { $set: { readerTokenId: t.tokenId, readerTokenSecret: t.tokenSecret } });
      report.reader = true;
      toRevoke.push(t.tokenId);
    } catch (err) {
      if (!(err instanceof PbsAgentError)) throw err;
      report.errors.push(`jeton lecteur du PBS de secours : ${err.message}`);
    }
  }
  resealSoon();

  // 3. the old server: its tokens revoked when its agent answers (the monitoring one too)
  if (old) {
    for (const id of [...new Set([change.from.tokenId, ...toRevoke].filter(Boolean))]) {
      try {
        const r = await deletePbsToken(old, id);
        if (r?.deleted) report.revoked.push(r.tokenId);
      } catch (err) {
        report.errors.push(`ancien PBS, jeton ${id} non révoqué : ${(err as Error).message}`);
      }
    }
  } else if (change.from.agent === undefined) {
    report.errors.push('ancien PBS sans agent connu : ses jetons sont à révoquer à la main');
  }

  // the rights of the tokens are those of the new datastores; the agents get their new secret
  await settings.updateOne({ _id: 'pbs' }, { $unset: { serverChange: '' }, $set: { aclStores: pbs.stores ?? [] } });
  await refreshManaged();
  await syncAll().catch((err) => log?.warn({ err }, 'backup definitions not sent'));
  pollPbs(log).catch(() => {});
  pollOffsite(log).catch(() => {});
  publish('backups', {});
  log?.info({ hosts: report.hosts.length, reader: report.reader, revoked: report.revoked.length, errors: report.errors.length }, 'main PBS replaced');
  return report;
}
