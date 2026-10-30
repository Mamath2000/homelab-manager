import { ObjectId } from 'mongodb';
import { hosts, probes, roles, settings } from './db.js';
import type { CarrierKind, HostDoc, LegacyHostRole, MqttBrokerRole, PbsRemoteSettings, PbsSettings, RoleDoc, RoleType } from './types.js';

export type RoleOf<T extends RoleType> = Extract<RoleDoc, { type: T }>;

// Roles of the hub: what the hub can do through something of the homelab (an MQTT broker the probes listen to, the
// reporting of a Proxmox VE cluster, the PBS of the backups and the one that copies them, the Open API of an Omada controller). The administrator declares them in the settings of
// the hub, each carried by a host; never an agent alone: the agents report candidates (agent/roles.go). Without a
// role, what consumes it is off.

export const ROLE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// What each type of role needs.
interface RoleTypeDef<R extends RoleDoc = RoleDoc> {
  label: string;
  carriers: readonly CarrierKind[];
  // at most one role of this type in the homelab
  single: boolean;
  // null: the host may carry this config, else why not (checked on creation and when the carrier or what was
  // detected changes)
  carrierError(host: Pick<HostDoc, 'roleCandidates' | 'capabilities'>, config: R['config']): string | null;
  // two roles of this type on one carrier that would be the same service
  same(a: R['config'], b: R['config']): boolean;
  // what uses the role (shown with it, and a role in use is not deleted)
  uses(id: string): Promise<string[]>;
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

export const ROLE_DEFS: { [T in RoleType]: RoleTypeDef<RoleOf<T>> } = {
  'mqtt-broker': {
    label: 'Broker MQTT',
    carriers: ['host'],
    single: false,
    // a broker is activated from what the agent detected, never declared by hand
    carrierError: (host, c) => (host.roleCandidates?.some((x) => x.type === 'mqtt-broker' && x.port === c.port) ? null : "aucun broker détecté par l'agent sur ce port"),
    same: (a, b) => a.port === b.port,
    uses: async (id) => {
      const [n, ha] = await Promise.all([probes.countDocuments({ 'target.type': 'mqtt', 'target.brokerId': id }), settings.countDocuments({ _id: 'homeassistant', brokerRoleId: id } as never)]);
      return [...(n ? [`${n} sonde${n > 1 ? 's' : ''}`] : []), ...(ha ? ['Home Assistant'] : [])];
    },
  },
  // declared, moved and removed through routes/backups.ts (the token is made and revoked by the agent of the node)
  'pve-reporting': {
    label: 'Reporting PVE',
    carriers: ['host'],
    single: false,
    carrierError: (host) => (host.capabilities?.includes('pve') ? null : "cet hôte n'est pas un nœud Proxmox VE"),
    same: (a, b) => a.cluster === b.cluster,
    // its guests and the groups it attaches go with it
    uses: async () => [],
  },
  // kept in the settings of the backups, declared and disconnected through routes/backups.ts and routes/offsite.ts (the
  // disconnection of the main PBS also disconnects the secondary one, its window says so)
  'pbs-primary': {
    label: 'PBS principal',
    carriers: ['host'],
    single: true,
    carrierError: (host) => (host.capabilities?.includes('pbs') ? null : "cet hôte n'est pas un Proxmox Backup Server"),
    same: () => true,
    uses: async () => [],
  },
  'pbs-offsite': {
    label: 'PBS hors site',
    carriers: ['host'],
    single: true,
    carrierError: (host) => (host.capabilities?.includes('pbs') ? null : "cet hôte n'est pas un Proxmox Backup Server"),
    same: () => true,
    uses: async () => [],
  },
  // typed by hand (address and application of the Open API); its host only tells where the controller runs
  'omada-controller': {
    label: 'Contrôleur Omada',
    carriers: ['host'],
    single: false,
    carrierError: () => null,
    same: (a, b) => sameUrl(a.url, b.url),
    // nothing yet: the equipment source of the controller (#231) will be its use
    uses: async () => [],
  },
};


// The definition of the type of a role, for code that handles any role.
export const defOf = (type: RoleType) => ROLE_DEFS[type] as unknown as RoleTypeDef;

// All the roles, kept in memory (a few, rarely written): the DTO of a host shows the ones it carries without a query.
let cache: RoleDoc[] = [];

export async function loadRoles() {
  const [stored, kept] = await Promise.all([roles.find().sort({ name: 1 }).toArray(), settingsRoles()]);
  cache = [...kept, ...stored];
  return cache;
}

const carrierOf = (agent?: { hostId: string }) => (agent?.hostId && ObjectId.isValid(agent.hostId) ? { kind: 'host' as const, id: new ObjectId(agent.hostId) } : null);

// The PBS of the backups (settings pbs and pbs-remote), roles once connected: an address and the token of the hub,
// made by the agent of their host.
export function pbsRoles(pbs: PbsSettings | null, remote: PbsRemoteSettings | null): RoleDoc[] {
  const out: RoleDoc[] = [];
  const main = carrierOf(pbs?.agent);
  if (pbs && main && pbs.url && pbs.tokenId && pbs.tokenSecret) out.push({ _id: 'pbs-primary', type: 'pbs-primary', name: 'PBS principal', carrier: main, config: pbs, createdAt: new Date(0) });
  const copy = carrierOf(remote?.agent);
  if (remote && copy && remote.url && remote.tokenId && remote.tokenSecret) out.push({ _id: 'pbs-offsite', type: 'pbs-offsite', name: 'PBS hors site', carrier: copy, config: remote, createdAt: new Date(0) });
  return out;
}

async function settingsRoles() {
  const [pbs, remote] = await Promise.all([settings.findOne({ _id: 'pbs' }), settings.findOne({ _id: 'pbs-remote' })]);
  return pbsRoles(pbs as PbsSettings | null, remote as PbsRemoteSettings | null);
}

export const allRoles = () => cache;
export const carriedBy = (id: ObjectId) => cache.filter((r) => r.carrier.id.equals(id));

// null: a role of this type may take this name, carrier and config among the roles of the list, else the refusal.
// self: the role being edited.
export function roleConflict(list: RoleDoc[], type: RoleType, name: string, carrierId: ObjectId, config: RoleDoc['config'], self?: string) {
  const def = defOf(type);
  const others = list.filter((r) => r.type === type && r._id !== self);
  if (def.single && others.length) return `un rôle ${def.label} est déjà déclaré`;
  if (others.some((r) => r.carrier.id.equals(carrierId) && def.same(r.config, config))) return 'ce rôle est déjà déclaré sur cet hôte';
  if (others.some((r) => r.name.toLowerCase() === name.toLowerCase())) return 'un rôle de ce type porte déjà ce nom';
  return null;
}

// Id of a new role, from its name, unique among the roles.
export function newRoleId(name: string, taken: (id: string) => boolean) {
  const base =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'role';
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base.slice(0, 29)}-${n}`;
  return id;
}

// --- migration: the roles were stored on their host (hosts[].roles) before they were the hub's ----------------------

// Same id: the probes name their broker by it.
export function fromLegacy(hostId: ObjectId, r: LegacyHostRole, createdAt: Date): MqttBrokerRole {
  return {
    _id: r.id,
    type: 'mqtt-broker',
    name: r.name,
    carrier: { kind: 'host', id: hostId },
    config: { scheme: r.scheme, port: r.port, ...(r.address ? { address: r.address } : {}), username: r.username, password: r.password ?? '' },
    createdAt,
  };
}

export async function migrateHostRoles() {
  const list = (await hosts.find({ roles: { $exists: true } } as never, { projection: { roles: 1 } }).toArray()) as unknown as { _id: ObjectId; roles?: LegacyHostRole[] }[];
  const now = new Date();
  for (const h of list) {
    for (const r of h.roles ?? []) {
      const { _id, ...rest } = fromLegacy(h._id, r, now);
      await roles.updateOne({ _id }, { $setOnInsert: rest }, { upsert: true });
    }
    await hosts.updateOne({ _id: h._id }, { $unset: { roles: '' } } as never);
  }
}
