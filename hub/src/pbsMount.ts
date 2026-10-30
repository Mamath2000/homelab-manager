import type { FastifyBaseLogger } from 'fastify';
import { posix as path } from 'node:path';
import { AgentRequestError, agentRequest, isOnline } from './agents.js';
import { backups, hosts, parseId } from './db.js';
import { publish } from './events.js';
import { hostDto } from './hostDto.js';
import { loadRemoteSettings, remoteReady } from './offsite.js';
import { FINGERPRINT_RE, loadPbsSettings, normalizeFingerprint, offPbs, pbsCall, pbsConnected } from './pbs.js';
import { PbsAgentError, deletePbsToken, ensurePbsToken } from './pbsAgent.js';
import type { BackupDoc, HostDoc, PbsAgentLink, PbsMount, PbsMountSource } from './types.js';

// Read-only mount of a snapshot of a PBS on a host (#209): groups host and ct, archives .pxar.didx. The
// client runs on the destination host (agent pbsmount.go, rpc pbs_mount), never in the container of a PBS.
// The token is volatile: DatastoreReader on the namespace of the group, created by the agent of the PBS
// for this mount, given to the agent of the destination in the rpc only (never stored, never logged), and
// revoked at the unmount. One mount in all the hub; never unmounted automatically, the host stays in
// warning meanwhile (monitoring.ts mountStatus).

export class PbsMountError extends Error {}

export const MOUNT_USER = 'homelab-mount@pbs';
export const SOURCES: PbsMountSource[] = ['main', 'offsite'];
export const ARCHIVE_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,120}\.pxar\.didx$/;
const MOUNTABLE_TYPES = ['host', 'ct'] as const;

export function normalizeMountRoot(value: string) {
  const root = value.trim();
  if (!root || /[\0-\x1f\x7f]/.test(root) || !path.isAbsolute(root)) return null;
  const normalized = path.normalize(root).replace(/\/+$/, '') || '/';
  return normalized === '/' ? null : normalized;
}

type Conn = { url: string; fingerprint: string; tokenId: string; tokenSecret: string };

interface Source {
  id: PbsMountSource;
  label: string;
  conn: Conn; // token of the hub that lists the snapshots (DatastoreAudit)
  link: PbsAgentLink;
  url: string;
  tailscaleUrl?: string;
  fingerprint: string;
  storeOf: (g: Pick<BackupDoc, 'store'>) => string;
}

export const sourceLabel: Record<PbsMountSource, string> = { main: 'PBS principal', offsite: 'PBS de secours' };

// The PBS a mount reads, with what the hub needs to list it and to create the token; error when it cannot be used.
async function sourceOf(id: PbsMountSource): Promise<Source> {
  if (id === 'main') {
    const s = await loadPbsSettings();
    if (!pbsConnected(s)) throw new PbsMountError('PBS principal non connecté');
    if (!s.agent) throw new PbsMountError('PBS principal non relié à son agent : le jeton du montage ne peut pas être créé');
    return { id, label: sourceLabel[id], conn: s, link: s.agent, url: s.url, tailscaleUrl: s.tailscaleUrl, fingerprint: s.fingerprint, storeOf: (g) => g.store };
  }
  const r = await loadRemoteSettings();
  if (!remoteReady(r)) throw new PbsMountError('PBS de secours non connecté');
  if (!r.agent) throw new PbsMountError('PBS de secours non relié à son agent : le jeton du montage ne peut pas être créé');
  return { id, label: sourceLabel[id], conn: r, link: r.agent, url: r.url, tailscaleUrl: r.tailscaleUrl, fingerprint: r.fingerprint, storeOf: () => r.store };
}

export async function mountSources() {
  return Promise.all(
    SOURCES.map(async (id) => {
      try {
        const s = await sourceOf(id);
        return { id, label: s.label, host: new URL(s.url).hostname, ready: true, reason: null };
      } catch (err) {
        return { id, label: sourceLabel[id], host: null, ready: false, reason: (err as Error).message };
      }
    }),
  );
}

// --- what can be mounted -------------------------------------------------------------------

const groupName = (b: Pick<BackupDoc, 'managed' | 'comment' | 'backupId'>) => b.managed?.name ?? b.comment ?? b.backupId;

// A group of the main PBS that can be mounted from this source: host or ct, on the PBS; on the secondary,
// a group it holds a copy of (sync jobs hlm-*).
export function mountable(b: BackupDoc, source: PbsMountSource) {
  if (!(MOUNTABLE_TYPES as readonly string[]).includes(b.type) || b.gone || b.placeholder || offPbs(b)) return false;
  return source === 'main' || !!(b.offsite?.enabled || b.offsite?.lastBackup);
}

export async function mountableGroups(source: PbsMountSource) {
  await sourceOf(source);
  const list = (await backups.find({ type: { $in: [...MOUNTABLE_TYPES] } }).sort({ store: 1, ns: 1, type: 1, backupId: 1 }).toArray()).filter((b) => mountable(b, source));
  const names = new Map((await hosts.find({ _id: { $in: list.flatMap((b) => (b.hostId ? [b.hostId] : [])) } }, { projection: { name: 1 } }).toArray()).map((h) => [h._id.toHexString(), h.name]));
  return list.map((b) => ({
    id: b._id,
    label: groupName(b),
    store: b.store,
    ns: b.ns,
    type: b.type,
    backupId: b.backupId,
    hostName: b.hostId ? (names.get(b.hostId.toHexString()) ?? null) : null,
    lastBackup: source === 'main' ? b.lastBackup : (b.offsite?.lastBackup ?? null),
  }));
}

async function groupOf(source: PbsMountSource, groupId: string) {
  const g = await backups.findOne({ _id: groupId });
  if (!g || !mountable(g, source)) throw new PbsMountError(`sauvegarde introuvable ou non montable depuis le ${sourceLabel[source]}`);
  return g as BackupDoc & { type: 'host' | 'ct' };
}

interface ApiSnapshot {
  'backup-time': number;
  size?: number;
  comment?: string;
  verification?: { state: string };
  files?: { filename: string; size?: number; 'crypt-mode'?: string }[];
}

// Snapshots of a group, read now on the PBS of the source, newest first, with their pxar archives. An
// encrypted archive cannot be mounted without its key: listed, not mountable.
export async function groupSnapshots(source: PbsMountSource, groupId: string) {
  const src = await sourceOf(source);
  const g = await groupOf(source, groupId);
  const q = new URLSearchParams({ 'backup-type': g.type, 'backup-id': g.backupId, ...(g.ns ? { ns: g.ns } : {}) });
  const list = await pbsCall<ApiSnapshot[]>(src.conn, 'GET', `/admin/datastore/${encodeURIComponent(src.storeOf(g))}/snapshots?${q}`);
  return list
    .sort((a, b) => b['backup-time'] - a['backup-time'])
    .map((s) => ({
      time: s['backup-time'],
      size: s.size ?? null,
      comment: s.comment ?? null,
      verify: s.verification?.state === 'ok' ? 'ok' : s.verification?.state === 'failed' ? 'failed' : null,
      archives: (s.files ?? [])
        .filter((f) => ARCHIVE_RE.test(f.filename))
        .map((f) => ({ name: f.filename, size: f.size ?? null, encrypted: f['crypt-mode'] === 'encrypt' })),
    }));
}

// --- destination ---------------------------------------------------------------------------

// Address of the PBS for the client on the host: the Tailscale one for a host of that access network.
export function target(src: Pick<Source, 'url' | 'tailscaleUrl' | 'fingerprint' | 'label'>, host: Pick<HostDoc, 'accessNetwork'>) {
  const url = host.accessNetwork === 'tailscale' && src.tailscaleUrl ? src.tailscaleUrl : src.url;
  const u = new URL(url);
  const fingerprint = src.fingerprint ? normalizeFingerprint(src.fingerprint) : '';
  if (!FINGERPRINT_RE.test(fingerprint)) throw new PbsMountError(`empreinte du ${src.label} absente des paramètres : le client ne peut pas épingler son certificat`);
  return { server: u.hostname, port: Number(u.port) || 8007, fingerprint };
}

const canMount = (h: Pick<HostDoc, 'capabilities'>) => !!h.capabilities?.includes('pbs_mount');

// Why the host of the PBS cannot be the destination (null: it can).
function pbsHostReason(h: HostDoc | null) {
  if (!h) return 'hôte du PBS introuvable';
  if (canMount(h)) return isOnline(h._id.toHexString()) ? null : `agent de ${h.name} hors ligne`;
  if (h.capabilities?.includes('backup:docker') || !h.capabilities?.includes('backup:native'))
    return `${h.name} n'a pas proxmox-backup-client installé nativement (l'image Docker du client ne peut pas monter pour l'hôte) : l'installer par APT depuis sa fiche`;
  return `l'agent de ${h.name} ne sait pas monter (agent à mettre à jour, ou pas de /dev/fuse ni de systemd)`;
}

async function checkReach(hostId: string, t: ReturnType<typeof target>, container: boolean) {
  try {
    const r = await agentRequest<{ ok: boolean; error?: string }>(hostId, 'pbs_mount_check', { pbsMount: t }, 20_000);
    if (r.ok) return { ok: true, error: null };
    return { ok: false, error: `${r.error ?? 'PBS injoignable'}${container ? ' (PBS en conteneur : son port 8007 est-il publié ?)' : ''}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// Hosts the snapshot can be mounted on: the host of the PBS first (default), then the hosts whose agent can
// mount, each tested now (the agent joins the PBS with the pinned certificate).
export async function mountDestinations(source: PbsMountSource) {
  const src = await sourceOf(source);
  const pbsHostId = parseId(src.link.hostId);
  const pbsHost = pbsHostId ? await hosts.findOne({ _id: pbsHostId }) : null;
  const list = await hosts.find({ capabilities: 'pbs_mount' }).sort({ name: 1 }).toArray();
  const t = (h: HostDoc) => target(src, h);
  const out = await Promise.all(
    list.map(async (h) => {
      const id = h._id.toHexString();
      const online = isOnline(id);
      const reach = online ? await checkReach(id, t(h), src.link.mode === 'container') : { ok: false, error: 'hôte hors ligne' };
      return {
        id,
        name: h.name,
        siteId: h.siteId ?? null,
        online,
        isPbsHost: id === src.link.hostId,
        slow: slowLink(source, h, pbsHost),
        reach,
      };
    }),
  );
  out.sort((a, b) => Number(b.isPbsHost) - Number(a.isPbsHost));
  const reason = pbsHostReason(pbsHost);
  return {
    pbsHost: { id: src.link.hostId, name: pbsHost?.name ?? null, reason },
    defaultHostId: !reason && out.find((d) => d.isPbsHost)?.reach.ok ? src.link.hostId : null,
    hosts: out,
  };
}

// Reads across sites are slow. A missing site is unknown; keep the secondary warning conservative.
export const slowLink = (source: PbsMountSource, h: Pick<HostDoc, '_id' | 'siteId'>, pbsHost: Pick<HostDoc, '_id' | 'siteId'> | null) =>
  pbsHost && h._id.equals(pbsHost._id)
    ? false
    : pbsHost && h.siteId && pbsHost.siteId
      ? h.siteId !== pbsHost.siteId
      : source === 'offsite';

// --- mount / unmount -----------------------------------------------------------------------

export async function activeMount() {
  return hosts.findOne({ pbsMount: { $exists: true } });
}

async function emit(hostId: HostDoc['_id']) {
  const h = await hosts.findOne({ _id: hostId });
  if (h) publish('host', hostDto(h));
  publish('pbs-mount', {});
}

const agentMessage = (err: unknown) => (err instanceof AgentRequestError || err instanceof PbsAgentError || err instanceof PbsMountError ? err.message : (err as Error).message);

// The ACL of the token: the namespace of the group (the datastore for the root namespace).
export const mountAclPath = (store: string, ns: string) => `/datastore/${store}${ns ? `/${ns}` : ''}`;
// unique per mount: a token left behind is never reused
export const mountTokenId = (now = Date.now()) => `${MOUNT_USER}!m${now.toString(36)}`;

let busy = false;

export interface MountInput {
  source: PbsMountSource;
  groupId: string;
  time: number;
  archive: string;
  hostId: string;
}

export async function mount(input: MountInput, log?: FastifyBaseLogger) {
  if (!SOURCES.includes(input.source)) throw new PbsMountError('source invalide');
  if (!Number.isInteger(input.time) || input.time <= 0) throw new PbsMountError('snapshot invalide');
  if (!ARCHIVE_RE.test(input.archive)) throw new PbsMountError('archive invalide : une archive .pxar.didx');
  const destId = parseId(input.hostId);
  if (!destId) throw new PbsMountError('hôte de destination invalide');
  if (busy) throw new PbsMountError('un montage est déjà en cours');
  busy = true;
  try {
    const current = await activeMount();
    if (current) throw new PbsMountError(`une sauvegarde est déjà montée sur ${current.name} : la démonter d'abord`);
    const src = await sourceOf(input.source);
    const g = await groupOf(input.source, input.groupId);
    const mountRoot = (await loadPbsSettings()).mountRoot ?? '/srv/pbs-restore';
    const dest = await hosts.findOne({ _id: destId });
    if (!dest) throw new PbsMountError('hôte de destination introuvable');
    if (!canMount(dest)) throw new PbsMountError(`l'agent de ${dest.name} ne sait pas monter une sauvegarde`);
    if (!isOnline(input.hostId)) throw new PbsMountError(`${dest.name} est hors ligne`);
    // the snapshot and the archive as the PBS has them now
    const snap = (await groupSnapshots(input.source, input.groupId)).find((s) => s.time === input.time);
    if (!snap) throw new PbsMountError('snapshot introuvable sur le PBS');
    const archive = snap.archives.find((a) => a.name === input.archive);
    if (!archive) throw new PbsMountError(`archive ${input.archive} absente de ce snapshot`);
    if (archive.encrypted) throw new PbsMountError('archive chiffrée : non montable sans sa clé');
    const t = target(src, dest);
    const reach = await checkReach(input.hostId, t, src.link.mode === 'container');
    if (!reach.ok) throw new PbsMountError(`${dest.name} ne joint pas le ${src.label} : ${reach.error}`);

    const pbsHostId = parseId(src.link.hostId);
    const pbsHost = pbsHostId ? await hosts.findOne({ _id: pbsHostId }, { projection: { siteId: 1 } }) : null;
    const store = src.storeOf(g);
    const record: PbsMount = {
      state: 'mounting',
      source: input.source,
      link: src.link,
      groupId: g._id,
      label: groupName(g),
      store,
      ns: g.ns,
      type: g.type,
      backupId: g.backupId,
      time: input.time,
      archive: input.archive,
      mountRoot,
      tokenId: mountTokenId(),
      slow: slowLink(input.source, dest, pbsHost),
      startedAt: new Date(),
    };
    // recorded before the token exists: a failure (or a restart of the hub) from here on is cleaned up
    const res = await hosts.updateOne({ _id: destId, pbsMount: { $exists: false } }, { $set: { pbsMount: record } });
    if (!res.modifiedCount) throw new PbsMountError('montage concurrent');
    await emit(destId);
    try {
      const token = await ensurePbsToken(src.link, record.tokenId, [{ path: mountAclPath(store, g.ns), role: 'DatastoreReader' }]);
      const st = await agentRequest<{ active: boolean; paths: string[] }>(
        input.hostId,
        'pbs_mount',
        { pbsMount: { ...t, mountRoot, store, ns: g.ns, type: g.type, id: g.backupId, time: input.time, archive: input.archive, tokenId: record.tokenId, secret: token.tokenSecret } },
        200_000,
      );
      const path = st.paths[0];
      await hosts.updateOne({ _id: destId }, { $set: { 'pbsMount.state': 'mounted', 'pbsMount.path': path, 'pbsMount.mountedAt': new Date() } });
      await emit(destId);
      log?.info({ host: dest.name, group: g._id, time: input.time, archive: input.archive, path }, 'PBS snapshot mounted');
      return { path, slow: record.slow };
    } catch (err) {
      await hosts.updateOne({ _id: destId }, { $set: { 'pbsMount.state': 'unmounting' } });
      busy = false;
      // a settle started meanwhile skipped the mount being set up: once more after it
      await settling;
      await settleMount(log);
      throw new PbsMountError(`montage impossible : ${agentMessage(err)}`);
    }
  } finally {
    busy = false;
  }
}

// Unmount asked: the host unmounts, the agent of the PBS revokes the token. What cannot be done now (an
// agent offline) is done when it comes back; the mount stays in warning until then.
export async function unmount(log?: FastifyBaseLogger) {
  const h = await activeMount();
  if (!h) return null;
  if (h.pbsMount!.state !== 'unmounting') await hosts.updateOne({ _id: h._id }, { $set: { 'pbsMount.state': 'unmounting' } });
  await settleMount(log);
  return (await activeMount())?.pbsMount ?? null;
}

let settling: Promise<void> | null = null;

// Brings the mount in line with reality: a lost mount (reboot of the host, unit stopped by hand) is
// unmounted and its token revoked; an unmount waiting for an agent goes on. One at a time.
export function settleMount(log?: FastifyBaseLogger) {
  settling ??= doSettle(log).finally(() => (settling = null));
  return settling;
}

async function doSettle(log?: FastifyBaseLogger) {
  const h = await activeMount();
  if (!h) return;
  const m = h.pbsMount!;
  const id = h._id.toHexString();
  // being set up in this process: its own failure path settles it
  if (m.state === 'mounting' && busy) return;
  if (m.state === 'mounted') {
    if (!isOnline(id)) return;
    const mountRoot = m.mountRoot ?? '/srv/pbs-restore';
    const st = await agentRequest<{ active: boolean; paths: string[] }>(id, 'pbs_mount_status', { pbsMount: { mountRoot } }).catch(() => null);
    if (!st || st.active || st.paths.length) return;
    log?.warn({ host: h.name }, 'PBS mount lost: revoking its token');
  }
  let { unmounted = false, revoked = false } = m;
  const errors: string[] = [];
  if (!unmounted) {
    if (!isOnline(id)) errors.push(`${h.name} hors ligne : démontage à sa reconnexion`);
    else {
      try {
        await agentRequest(id, 'pbs_umount', { pbsMount: { mountRoot: m.mountRoot ?? '/srv/pbs-restore' } }, 75_000);
        unmounted = true;
      } catch (err) {
        errors.push(`démontage : ${agentMessage(err)}`);
      }
    }
  }
  // revoked even when the host could not unmount: the mount can no longer read anything
  if (!revoked) {
    try {
      await deletePbsToken(m.link, m.tokenId);
      revoked = true;
    } catch (err) {
      errors.push(`révocation du jeton : ${agentMessage(err)}`);
    }
  }
  if (unmounted && revoked) {
    await hosts.updateOne({ _id: h._id }, { $unset: { pbsMount: '' } });
    log?.info({ host: h.name, token: m.tokenId }, 'PBS mount removed, token revoked');
  } else {
    await hosts.updateOne({ _id: h._id }, { $set: { 'pbsMount.state': 'unmounting', 'pbsMount.unmounted': unmounted, 'pbsMount.revoked': revoked, 'pbsMount.error': errors.join(' · ') } });
  }
  await emit(h._id);
}

// The agent of the destination or of the PBS came back: what was waiting for it.
export async function onMountHello(hostId: HostDoc['_id'], log?: FastifyBaseLogger) {
  const h = await activeMount();
  if (!h) return;
  const id = hostId.toHexString();
  if (h._id.equals(hostId) || h.pbsMount!.link.hostId === id) await settleMount(log);
}

// Every 5 minutes (and 30 s after start): a mount lost without a hello in between, a restart of the hub
// during a mount.
export function startMountReconciler(log: FastifyBaseLogger) {
  const run = () => settleMount(log).catch((err) => log.warn({ err }, 'PBS mount reconciliation failed'));
  const first = setTimeout(run, 30_000);
  const timer = setInterval(run, 5 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
