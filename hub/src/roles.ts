import type { ObjectId } from 'mongodb';
import { hosts, probes, roles } from './db.js';
import type { CarrierKind, HostDoc, LegacyHostRole, RoleDoc, RoleType } from './types.js';

// Roles of the hub: what the hub can do through something of the homelab (an MQTT broker the probes listen to; later
// the PBS of the backups, the reporting of a Proxmox VE cluster…). The administrator declares them in the settings of
// the hub, each carried by a host; never an agent alone: the agents report candidates (agent/roles.go). Without a
// role, what consumes it is off.

export const ROLE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// What each type of role needs.
interface RoleTypeDef {
  label: string;
  carriers: readonly CarrierKind[];
  // at most one role of this type in the homelab
  single: boolean;
  // null: the host may carry this config, else why not (checked on creation and when the carrier or what was
  // detected changes)
  carrierError(host: Pick<HostDoc, 'roleCandidates'>, config: RoleDoc['config']): string | null;
  // two roles of this type on one carrier that would be the same service
  same(a: RoleDoc['config'], b: RoleDoc['config']): boolean;
  // null: may be deleted, else what uses it
  usedBy(id: string): Promise<string | null>;
}

export const ROLE_DEFS: Record<RoleType, RoleTypeDef> = {
  'mqtt-broker': {
    label: 'Broker MQTT',
    carriers: ['host'],
    single: false,
    // a broker is activated from what the agent detected, never declared by hand
    carrierError: (host, c) => (host.roleCandidates?.some((x) => x.type === 'mqtt-broker' && x.port === c.port) ? null : "aucun broker détecté par l'agent sur ce port"),
    same: (a, b) => a.port === b.port,
    usedBy: async (id) => {
      const used = await probes.find({ 'target.type': 'mqtt', 'target.brokerId': id }, { projection: { name: 1 } }).toArray();
      return used.length ? `utilisé par ${used.length} sonde(s) : ${used.slice(0, 5).map((p) => p.name).join(', ')}${used.length > 5 ? '…' : ''}` : null;
    },
  },
};

// All the roles, kept in memory (a few, rarely written): the DTO of a host shows the ones it carries without a query.
let cache: RoleDoc[] = [];

export async function loadRoles() {
  cache = await roles.find().sort({ name: 1 }).toArray();
  return cache;
}

export const allRoles = () => cache;
export const carriedBy = (id: ObjectId) => cache.filter((r) => r.carrier.id.equals(id));

// null: a role of this type may take this name, carrier and config among the roles of the list, else the refusal.
// self: the role being edited.
export function roleConflict(list: RoleDoc[], type: RoleType, name: string, carrierId: ObjectId, config: RoleDoc['config'], self?: string) {
  const def = ROLE_DEFS[type];
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
export function fromLegacy(hostId: ObjectId, r: LegacyHostRole, createdAt: Date): RoleDoc {
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
