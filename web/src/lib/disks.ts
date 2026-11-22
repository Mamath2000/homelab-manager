import { visibleHealthVolumes, type DisksInventory, type DiskThresholds, type HealthSmartDisk, type HealthUnraidDisk, type Host, type PveStorageUsage, type SiteConfig } from './api';

// Model of the Disks page: one row per physical disk, volume, RAID array, Ceph cluster, Proxmox VE storage and guest disk,
// tied to its parent for the hierarchical view (disk → volumes, array → members, Ceph → OSD disks + RBD storages →
// guest disks → volumes of the host the guest is). Levels come from the alerts of the hub (silenced ones left out), so the
// page and the Health page always agree; only the PVE storages and container disks, which the hub does not alert on, are
// coloured from the disk thresholds.

export type DiskLevel = 'ok' | 'warn' | 'alert';
export type DiskNature = 'disk' | 'volume' | 'raid' | 'ceph' | 'storage' | 'guest';

export const NATURE_LABEL: Record<DiskNature, string> = {
  disk: 'Disque',
  volume: 'Volume',
  raid: 'RAID',
  ceph: 'Ceph',
  storage: 'Stockage PVE',
  guest: 'Disque VM / CT',
};

// filter of the nature: the RAID / Ceph group gathers what holds other disks
export type NatureFilter = '' | 'disk' | 'volume' | 'raid' | 'guest';
export const natureGroup = (n: DiskNature): Exclude<NatureFilter, ''> => (n === 'ceph' || n === 'storage' ? 'raid' : n);

export const COLUMNS: { id: Exclude<NatureFilter, ''>; label: string; title: string }[] = [
  { id: 'volume', label: 'Volumes', title: 'Volumes des hôtes' },
  { id: 'disk', label: 'Disques', title: 'Disques physiques (SMART, membres RAID, OSD)' },
  { id: 'raid', label: 'RAID / Ceph', title: 'Arrays RAID, Unraid, Ceph et stockages Proxmox VE' },
  { id: 'guest', label: 'VM / CT', title: 'Disques des machines virtuelles et conteneurs Proxmox VE' },
];

export interface DiskSiteRow {
  id: string; // site id, 'none' without site
  name: string;
  rows: DiskRow[];
}

export function siteRows(rows: DiskRow[], sites: SiteConfig[]): DiskSiteRow[] {
  return [...sites.map((s) => ({ id: s.id, name: s.name })), { id: 'none', name: 'Sans site' }]
    .map((s) => ({ ...s, rows: rows.filter((r) => (r.siteId && sites.some((x) => x.id === r.siteId) ? r.siteId : 'none') === s.id) }))
    .filter((s) => s.rows.length > 0);
}

export interface DiskTag {
  label: string;
  level?: DiskLevel;
}

export interface DiskRow {
  id: string;
  nature: DiskNature;
  level: DiskLevel;
  name: string;
  sub: string;
  // host the row belongs to (link), and the name shown in the Host column (a PVE node or cluster for storages and guests)
  hostId: string | null;
  hostName: string;
  siteId: string | null;
  type: string;
  sizeBytes: number | null;
  used: number | null;
  total: number | null;
  thresholds: { warn: number; alert: number } | null;
  temperature: number | null;
  temperatureLevel: DiskLevel;
  wear: number | null;
  wearLevel: DiskLevel;
  reallocated: number | null;
  powerOnHours: number | null;
  smart: 'ok' | 'failed' | 'standby' | 'error' | null;
  tags: DiskTag[];
  // shown in the space column of a row without a bar: « 2 volumes », « membre de md0 », « parité »…
  hint: string | null;
  reasons: string[];
  parent: string | null;
}

export const LEVEL_RANK: Record<DiskLevel, number> = { ok: 0, warn: 1, alert: 2 };
const worst = (a: DiskLevel, b: DiskLevel): DiskLevel => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a);

// /dev/sdb1 → /dev/sdb, /dev/nvme0n1p3 → /dev/nvme0n1, /dev/mmcblk0p1 → /dev/mmcblk0; md, mapper and others: unchanged.
export function wholeDisk(device: string) {
  const dev = device.startsWith('/dev/') ? device : `/dev/${device}`;
  const m = /^\/dev\/((?:nvme\d+n\d+|mmcblk\d+|loop\d+))p\d+$/.exec(dev) ?? /^\/dev\/((?:sd|vd|hd|xvd)[a-z]+)\d+$/.exec(dev);
  return m ? `/dev/${m[1]}` : dev;
}

// Key of a whole disk: smartctl names an NVMe disk after its controller (/dev/nvme0) while sysfs, RAID and Ceph name its
// namespace (/dev/nvme0n1); both map to the controller so a volume finds its disk.
const diskKey = (device: string) => wholeDisk(device).replace(/^\/dev\/(nvme\d+)n\d+$/, '/dev/$1');

export function diskType(d: Pick<HealthSmartDisk, 'protocol' | 'rotationRate' | 'device'>) {
  if (d.protocol === 'NVMe' || /\/nvme\d/.test(d.device)) return 'NVMe';
  if (d.rotationRate === 0) return 'SSD';
  if (d.rotationRate && d.rotationRate > 0) return 'HDD';
  return d.protocol ?? '';
}

const pctLevel = (used: number, total: number, t: { warn: number; alert: number }): DiskLevel => {
  const p = (used / total) * 100;
  return p >= t.alert ? 'alert' : p >= t.warn ? 'warn' : 'ok';
};
const valueLevel = (v: number | null | undefined, warn?: number, alert?: number): DiskLevel =>
  v === null || v === undefined || warn === undefined || alert === undefined ? 'ok' : v >= alert ? 'alert' : v >= warn ? 'warn' : 'ok';

const DEFAULT_SPACE = { warn: 75, alert: 90 };
// storages that hold no disks of guests: listed only when one of them is on it
const STORAGE_TYPES = new Set(['rbd', 'lvmthin', 'lvm', 'zfspool', 'zfs']);
// the disk a guest boots from: the volumes of its host hang under it
const BOOT_KEYS = ['rootfs', 'scsi0', 'virtio0', 'sata0', 'ide0'];

const shortName = (s: string | undefined | null) => (s ?? '').split('.')[0].toLowerCase();

function blank(id: string, nature: DiskNature, init: Partial<DiskRow>): DiskRow {
  return {
    id, nature, level: 'ok', name: '', sub: '', hostId: null, hostName: '', siteId: null, type: '', sizeBytes: null, used: null, total: null,
    thresholds: null, temperature: null, temperatureLevel: 'ok', wear: null, wearLevel: 'ok', reallocated: null, powerOnHours: null, smart: null,
    tags: [], hint: null, reasons: [], parent: null, ...init,
  };
}

export function buildDiskRows(hostList: Host[], inv: DisksInventory | undefined): DiskRow[] {
  const rows = new Map<string, DiskRow>();
  const add = (r: DiskRow) => (rows.set(r.id, r), r);
  const raise = (r: DiskRow, alerts: { level: DiskLevel; reason: string }[]) => {
    for (const a of alerts) {
      r.level = worst(r.level, a.level);
      if (!r.reasons.includes(a.reason)) r.reasons.push(a.reason);
    }
  };
  const thresholdsOf = (hostId: string | null): DiskThresholds | undefined => (hostId ? inv?.thresholds[hostId] : undefined);
  const hostByNode = new Map<string, Host>();
  for (const h of hostList) for (const n of [shortName(h.info?.hostname), shortName(h.name)]) if (n && !hostByNode.has(n)) hostByNode.set(n, h);
  // Ceph clusters by fsid: the hosts that report them, their OSDs
  const ceph = new Map<string, { hosts: Host[]; status?: string; error?: string; osdsUp: number; osdsTotal: number; pgs: number; pgsClean: number; used: number; total: number }>();
  // volumes whose parent is the boot disk of the guest their host is, resolved once the guests are known
  const toGuest: { row: DiskRow; host: Host }[] = [];
  const diskId = (h: Host, dev: string) => `d|${h.id}|${diskKey(dev)}`;
  // a disk named by a volume, RAID, Unraid, Ceph or LVM but not read in SMART: a row without SMART values, so the tree stays whole
  const ensureDisk = (h: Host, dev: string) =>
    rows.get(diskId(h, dev)) ?? add(blank(diskId(h, dev), 'disk', { hostId: h.id, hostName: h.name, siteId: h.siteId, name: dev, sub: 'pas de relevé SMART' }));

  for (const h of hostList) {
    const health = h.health;
    if (!health) continue;
    const alerts = (health.alerts ?? []).filter((a) => !a.silenced);
    const alertsOf = (prefix: string, except?: (key: string) => boolean) => alerts.filter((a) => a.key.startsWith(prefix) && !except?.(a.key));
    const t = thresholdsOf(h.id);
    const base = { hostId: h.id, hostName: h.name, siteId: h.siteId };

    for (const d of health.smart?.disks ?? []) {
      const r = add(blank(diskId(h, d.device), 'disk', {
        ...base,
        name: d.model || d.device,
        sub: [d.device, d.serial].filter(Boolean).join(' · '),
        type: diskType(d),
        sizeBytes: d.sizeBytes ?? null,
        temperature: d.temperatureC ?? null,
        temperatureLevel: valueLevel(d.temperatureC, t?.temperatureWarning, t?.temperatureAlert),
        wear: d.nvmeWearPercent ?? null,
        wearLevel: valueLevel(d.nvmeWearPercent, t?.wearWarning, t?.wearAlert),
        reallocated: d.reallocated ?? null,
        powerOnHours: d.powerOnHours ?? null,
        smart: d.healthy === false ? 'failed' : d.standby ? 'standby' : d.healthy ? 'ok' : d.error ? 'error' : null,
      }));
      raise(r, alertsOf(`smart:smart:${d.device}:`));
    }

    const raid = health.raid;
    for (const a of raid?.arrays ?? []) {
      const arr = add(blank(`r|${h.id}|${a.name}`, 'raid', {
        ...base,
        name: `/dev/${a.name}`,
        sub: `${a.level} · ${a.raidDisks - a.degraded}/${a.raidDisks} disques · ${a.state}${a.syncAction !== 'idle' ? ` · ${a.syncAction}${a.syncPercent !== undefined ? ` ${a.syncPercent.toFixed(1)} %` : ''}` : ''}`,
        type: a.level,
      }));
      raise(arr, alertsOf(`raid:${a.name}:`, (k) => k.startsWith(`raid:${a.name}:member:`)));
      for (const m of a.members) {
        const disk = ensureDisk(h, wholeDisk(m.device));
        disk.parent = arr.id;
        disk.hint = `membre de ${a.name}`;
        disk.tags.push({ label: a.name }, ...(m.errors > 0 ? [{ label: `${m.errors} err.`, level: 'warn' as const }] : []));
        raise(disk, alertsOf(`raid:${a.name}:member:${m.device}:`));
      }
    }
    if (raid?.unraid) {
      const u = raid.unraid;
      const arr = add(blank(`r|${h.id}|unraid`, 'raid', { ...base, name: 'Array Unraid', sub: `${u.state}${u.syncAction ? ` · ${u.syncAction}` : ''}`, type: 'unraid' }));
      raise(arr, alertsOf('raid:unraid:', (k) => k.startsWith('raid:unraid:disk:') || k.startsWith('raid:unraid:pool:')));
      const member = (d: HealthUnraidDisk, group: DiskRow, tag: string) => {
        if (!d.device) return;
        const disk = ensureDisk(h, wholeDisk(d.device));
        disk.parent = group.id;
        if (d.type === 'Parity') disk.hint = 'parité';
        disk.tags.push({ label: tag });
        raise(disk, alertsOf(`raid:unraid:disk:${d.name}:`));
      };
      for (const d of u.disks) member(d, arr, `Unraid · ${d.name}`);
      // a pool (btrfs, ZFS) holds its disks and the volume mounted at /mnt/<pool>
      for (const p of u.pools) {
        const pool = add(blank(`r|${h.id}|unraid:${p.name}`, 'raid', {
          ...base,
          name: `Pool ${p.name}`,
          sub: [[p.fsType, p.profile].filter(Boolean).join(' '), `${p.devices}/${p.devicesExpected} disques`, p.health].filter(Boolean).join(' · '),
          type: p.fsType,
        }));
        raise(pool, alertsOf(`raid:unraid:pool:${p.name}:`));
        for (const d of p.disks) member(d, pool, `${p.name} · ${d.name}`);
      }
    }
    if (raid?.ceph) {
      const c = raid.ceph;
      const key = c.fsid ?? `host:${h.id}`;
      const known = ceph.get(key);
      if (known) known.hosts.push(h);
      else ceph.set(key, { hosts: [h], status: c.status, error: c.error, osdsUp: c.osdsUp, osdsTotal: c.osdsTotal, pgs: c.pgs, pgsClean: c.pgsClean, used: c.usedBytes, total: c.totalBytes });
      const cephId = `c|${key}`;
      for (const o of c.osds) {
        const devices = o.devices?.length ? o.devices : [];
        const targets = devices.length
          ? devices.map((dev) => ensureDisk(h, wholeDisk(dev)))
          : [rows.get(`o|${h.id}|${o.name}`) ?? add(blank(`o|${h.id}|${o.name}`, 'disk', { ...base, name: o.name, sub: 'disque non relevé (agent à mettre à jour)' }))];
        for (const disk of targets) {
          disk.parent = cephId;
          disk.hint = `OSD ${o.name}`;
          disk.tags.push({ label: `Ceph · ${o.name}`, level: !o.up ? 'alert' : !o.in ? 'warn' : undefined });
          raise(disk, alertsOf(`raid:ceph:${o.name}:`));
        }
      }
    }

    for (const v of visibleHealthVolumes(health.disks?.volumes ?? [])) {
      const space = t ? { warn: t.diskWarning, alert: t.diskAlert } : DEFAULT_SPACE;
      const r = add(blank(`v|${h.id}|${v.mountpoint}`, 'volume', {
        ...base, name: v.mountpoint, sub: `sur ${v.device}`, type: v.fstype, sizeBytes: v.total, used: v.used, total: v.total, thresholds: space,
      }));
      // exact key: a prefix would give "/" the alerts of every other mount point
      raise(r, alerts.filter((a) => a.key === `disks:volume:${v.mountpoint}`));
      // Unraid: a pool is mounted at /mnt/<pool>; an array disk diskN is mounted from /dev/mdN(p1), not followed in sysfs
      const unraid = health.raid?.unraid;
      const unraidPool = unraid?.pools.find((p) => v.mountpoint === `/mnt/${p.name}`);
      const unraidMd = unraid ? /^\/dev\/md(\d+)(?:p\d+)?$/.exec(v.device) : null;
      const unraidDisk = unraidMd ? unraid!.disks.find((d) => d.name === `disk${unraidMd[1]}` && d.device) : undefined;
      if (unraidPool && rows.has(`r|${h.id}|unraid:${unraidPool.name}`)) {
        r.parent = `r|${h.id}|unraid:${unraidPool.name}`;
        continue;
      }
      if (unraidMd) {
        if (unraidDisk) r.parent = ensureDisk(h, wholeDisk(unraidDisk.device!)).id;
        continue;
      }
      const md = /^\/dev\/(md\w+)$/.exec(v.device);
      const candidates = v.disks ?? (v.device.startsWith('/dev/') && !v.device.startsWith('/dev/mapper/') && !md ? [wholeDisk(v.device)] : []);
      if (md && rows.has(`r|${h.id}|${md[1]}`)) r.parent = `r|${h.id}|${md[1]}`;
      else if (candidates.length === 1 && rows.has(diskId(h, candidates[0]))) r.parent = diskId(h, candidates[0]);
      else if (h.pve) toGuest.push({ row: r, host: h });
      // a host that is not a guest of PVE: its disk, even without SMART reading
      else if (candidates.length === 1) r.parent = ensureDisk(h, candidates[0]).id;
      if (candidates.length > 1 && !md) r.sub += ` · ${candidates.length} disques`;
    }
  }

  // Ceph clusters, named after the PVE cluster whose nodes report them
  const clusterOfNode = new Map<string, { id: string; name: string }>();
  for (const c of inv?.clusters ?? []) for (const n of c.nodes) clusterOfNode.set(shortName(n), c);
  const cephOfCluster = new Map<string, string>();
  for (const [key, c] of ceph) {
    const pve = c.hosts.map((h) => clusterOfNode.get(shortName(h.info?.hostname)) ?? clusterOfNode.get(shortName(h.name))).find(Boolean);
    if (pve) cephOfCluster.set(pve.id, `c|${key}`);
    const r = add(blank(`c|${key}`, 'ceph', {
      hostName: pve?.name ?? c.hosts.map((h) => h.name).join(', '),
      hostId: c.hosts.length === 1 ? c.hosts[0].id : null,
      siteId: c.hosts[0].siteId,
      name: pve ? `Ceph ${pve.name}` : 'Ceph',
      sub: c.error ? `injoignable : ${c.error}` : `${c.status ?? '?'} · ${c.osdsUp}/${c.osdsTotal} OSD up · PG ${c.pgsClean}/${c.pgs} propres`,
      type: 'ceph',
      sizeBytes: c.total || null,
      used: c.total ? c.used : null,
      total: c.total || null,
      thresholds: DEFAULT_SPACE,
    }));
    // cluster-wide alerts carry the same key on every node: taken once
    for (const h of c.hosts) {
      raise(r, (h.health?.alerts ?? []).filter((a) => !a.silenced && (a.key === 'raid:ceph:unreachable' || a.key.startsWith('raid:ceph:check:'))));
    }
  }

  // where a local storage lives on its node: the volume holding its directory (longest mount point), or the disk of its
  // LVM volume group when it has only one
  const localParent = (h: Host, s: PveStorageUsage): string | null => {
    if (s.path) {
      const under = (m: string) => m === '/' || s.path === m || s.path!.startsWith(`${m}/`);
      const vol = [...rows.values()]
        .filter((r) => r.nature === 'volume' && r.hostId === h.id && under(r.name))
        .sort((a, b) => b.name.length - a.name.length)[0];
      return vol?.id ?? null;
    }
    const vg = s.vgname ? h.health?.disks?.volumeGroups?.find((g) => g.name === s.vgname) : undefined;
    return vg?.disks.length === 1 ? ensureDisk(h, vg.disks[0]).id : null;
  };

  // PVE storages, then the disks of the guests on them
  const storageId = (cluster: string, storage: string, node: string | null) => `s|${cluster}|${storage}|${node ?? ''}`;
  const usedStorages = new Set((inv?.guests ?? []).flatMap((g) => g.disks.map((d) => `${g.cluster}|${d.storage}`)));
  for (const c of inv?.clusters ?? []) {
    for (const s of c.storages) {
      if (!STORAGE_TYPES.has(s.type) && !usedStorages.has(`${c.id}|${s.storage}`)) continue;
      const node = s.node ? hostByNode.get(shortName(s.node)) : undefined;
      const t = thresholdsOf(node?.id ?? null);
      const space = t ? { warn: t.diskWarning, alert: t.diskAlert } : DEFAULT_SPACE;
      const r = add(blank(storageId(c.id, s.storage, s.node), s.type === 'rbd' ? 'ceph' : 'storage', {
        hostName: s.node ?? c.name,
        hostId: node?.id ?? null,
        siteId: node?.siteId ?? hostList.find((h) => clusterOfNode.get(shortName(h.info?.hostname))?.id === c.id)?.siteId ?? null,
        name: s.storage,
        sub: s.type === 'rbd' ? `pool RBD · ${c.name}` : `${s.node ? `nœud ${s.node}` : 'partagé'} · ${c.name}`,
        type: s.type,
        sizeBytes: s.total,
        used: s.used,
        total: s.total,
        thresholds: space,
        parent: s.type === 'rbd' ? (cephOfCluster.get(c.id) ?? null) : node ? localParent(node, s) : null,
      }));
      r.level = pctLevel(s.used, s.total, space);
      if (r.level !== 'ok') r.reasons.push(`${s.storage} utilisé à ${((s.used / s.total) * 100).toFixed(1)} %`);
    }
  }
  for (const g of inv?.guests ?? []) {
    const node = hostByNode.get(shortName(g.node));
    const linked = g.hostId ? hostList.find((h) => h.id === g.hostId) : undefined;
    for (const d of g.disks) {
      const parent = rows.get(storageId(g.cluster, d.storage, null)) ?? rows.get(storageId(g.cluster, d.storage, g.node));
      const used = g.type === 'lxc' && d.key === 'rootfs' && g.diskUsed !== null && d.sizeBytes ? g.diskUsed : null;
      const t = thresholdsOf(linked?.id ?? node?.id ?? null);
      const space = t ? { warn: t.diskWarning, alert: t.diskAlert } : DEFAULT_SPACE;
      const r = add(blank(`g|${g.cluster}|${g.vmid}|${d.key}`, 'guest', {
        hostId: linked?.id ?? null,
        hostName: g.node,
        siteId: linked?.siteId ?? node?.siteId ?? null,
        name: d.volume,
        sub: `${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid} · ${g.name || '?'} · ${d.key}`,
        type: g.type === 'qemu' ? 'VM' : 'LXC',
        sizeBytes: d.sizeBytes ?? null,
        used,
        total: used !== null ? d.sizeBytes! : null,
        thresholds: used !== null ? space : null,
        parent: parent?.id ?? null,
        tags: [{ label: d.storage }],
      }));
      if (used !== null) r.level = pctLevel(used, d.sizeBytes!, space);
      if (r.level !== 'ok') r.reasons.push(`${d.volume} utilisé à ${((used! / d.sizeBytes!) * 100).toFixed(1)} %`);
    }
  }
  for (const { row, host } of toGuest) {
    const g = inv?.guests.find((x) => x.cluster === host.pve!.cluster && x.vmid === host.pve!.vmid);
    // a CT says where it mounts each disk; otherwise the boot disk
    const mounted = g?.disks.find((d) => d.mountpoint === row.name);
    const boot = g && (mounted ?? [...BOOT_KEYS.map((k) => g.disks.find((d) => d.key === k)), g.disks[0]].find(Boolean));
    if (g && boot) row.parent = `g|${g.cluster}|${g.vmid}|${boot.key}`;
  }
  // a disk of a guest that holds a single volume (rootfs of a CT, VM on one partition) shows it on its own row: space, state
  // and file system as the agent measures them inside the guest (the image is a bit larger than its file system)
  for (const g of [...rows.values()].filter((r) => r.nature === 'guest')) {
    const children = [...rows.values()].filter((r) => r.parent === g.id);
    const v = children.length === 1 && children[0].nature === 'volume' ? children[0] : null;
    if (!v) continue;
    Object.assign(g, {
      sub: `${g.sub} → ${v.name}`,
      type: v.type || g.type,
      used: v.used,
      total: v.total,
      thresholds: v.thresholds,
      level: v.level,
      reasons: v.reasons,
      hint: v.hint,
    });
    for (const r of rows.values()) if (r.parent === v.id) r.parent = g.id;
    rows.delete(v.id);
  }

  // parents that do not exist (filtered out, guest gone) are dropped; the space hint counts the volumes of a disk
  const list = [...rows.values()];
  for (const r of list) if (r.parent && !rows.has(r.parent)) r.parent = null;
  for (const r of list) {
    if (r.nature === 'volume' || r.nature === 'guest') continue;
    const n = list.filter((x) => x.parent === r.id && x.nature === 'volume').length;
    if (n && !r.hint) r.hint = `${n} volume${n > 1 ? 's' : ''}`;
  }
  return list;
}

// --- sorting and tree -----------------------------------------------------------------------------

export type SortKey = 'name' | 'level' | 'host' | 'nature' | 'type' | 'size' | 'used' | 'free' | 'temperature' | 'wear' | 'smart' | 'raid';
export interface Sort {
  key: SortKey;
  desc: boolean;
}

const SMART_RANK = { failed: 3, error: 2, standby: 1, ok: 0 };
const pct = (r: DiskRow) => (r.used !== null && r.total ? r.used / r.total : null);

// Value of a column: null sorts last whatever the direction.
function sortValue(r: DiskRow, key: SortKey): string | number | null {
  switch (key) {
    case 'name': return r.name.toLowerCase();
    case 'level': return LEVEL_RANK[r.level];
    case 'host': return r.hostName.toLowerCase();
    case 'nature': return NATURE_LABEL[r.nature];
    case 'type': return r.type.toLowerCase() || null;
    case 'size': return r.sizeBytes;
    case 'used': return pct(r);
    case 'free': return r.used !== null && r.total ? r.total - r.used : null;
    case 'temperature': return r.temperature;
    case 'wear': return r.wear ?? r.reallocated;
    case 'smart': return r.smart ? SMART_RANK[r.smart] : null;
    case 'raid': return r.tags.map((t) => t.label).join(' ').toLowerCase() || null;
  }
}

export function compareRows(a: DiskRow, b: DiskRow, sort: Sort) {
  const va = sortValue(a, sort.key);
  const vb = sortValue(b, sort.key);
  if (va === null || vb === null) {
    if (va !== vb) return va === null ? 1 : -1;
  } else if (va !== vb) {
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'fr', { numeric: true });
    return sort.desc ? -c : c;
  }
  return a.hostName.localeCompare(b.hostName) || a.name.localeCompare(b.name, 'fr', { numeric: true });
}

export interface TreeRow {
  row: DiskRow;
  depth: number;
  // for each ancestor level, whether a sibling follows (draws the vertical lines), and whether this row is the last child
  rails: boolean[];
  last: boolean;
  hasChildren: boolean;
}

// The rows to show: flat and sorted, or as a tree whose siblings are sorted the same way (a group sorts by the worst of its
// rows when sorting by state). Filtered rows keep their ancestors in the tree, for context.
export function arrange(all: DiskRow[], shown: Set<string>, sort: Sort, tree: boolean): TreeRow[] {
  if (!tree) {
    return all.filter((r) => shown.has(r.id)).sort((a, b) => compareRows(a, b, sort))
      .map((row) => ({ row, depth: 0, rails: [], last: true, hasChildren: false }));
  }
  const byId = new Map(all.map((r) => [r.id, r]));
  const keep = new Set<string>();
  for (const id of shown) {
    for (let r = byId.get(id); r && !keep.has(r.id); r = r.parent ? byId.get(r.parent) : undefined) keep.add(r.id);
  }
  const children = new Map<string | null, DiskRow[]>();
  for (const r of all) {
    if (!keep.has(r.id)) continue;
    const k = r.parent && keep.has(r.parent) ? r.parent : null;
    children.set(k, [...(children.get(k) ?? []), r]);
  }
  const groupLevel = new Map<string, DiskLevel>();
  const levelOf = (r: DiskRow): DiskLevel => {
    const known = groupLevel.get(r.id);
    if (known) return known;
    const l = (children.get(r.id) ?? []).reduce((acc, c) => worst(acc, levelOf(c)), r.level);
    groupLevel.set(r.id, l);
    return l;
  };
  const cmp = (a: DiskRow, b: DiskRow) => (sort.key === 'level' ? compareRows({ ...a, level: levelOf(a) }, { ...b, level: levelOf(b) }, sort) : compareRows(a, b, sort));
  const out: TreeRow[] = [];
  const walk = (parent: string | null, depth: number, rails: boolean[]) => {
    const list = (children.get(parent) ?? []).sort(cmp);
    list.forEach((row, i) => {
      const last = i === list.length - 1;
      const hasChildren = (children.get(row.id)?.length ?? 0) > 0;
      out.push({ row, depth, rails, last, hasChildren });
      if (hasChildren) walk(row.id, depth + 1, depth === 0 ? [] : [...rails, !last]);
    });
  };
  walk(null, 0, []);
  return out;
}
