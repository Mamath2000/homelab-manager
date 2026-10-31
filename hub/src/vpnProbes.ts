import { ObjectId } from 'mongodb';
import { equipments, hosts, omada, probes } from './db.js';
import { publish } from './events.js';
import type { Measure } from './probeRunners.js';
import { pingFromHost, SOURCE_GONE } from './probeSource.js';
import { addressIn, inSubnet } from './subnet.js';
import type { EquipmentDoc, HostDoc, OmadaStateDoc, OmadaVpn, ProbeDoc } from './types.js';

// Probes of the site-to-site VPNs (homelab#261): one per tunnel, on the gateway that carries it. A host of the networks
// the tunnel carries on this side (the source, through its agent) pings a machine of the networks on the other side (the
// target): a tunnel the controller says established can still carry nothing. Source and target are chosen by the admin,
// among the ones whose address is in those networks (the site of a host in the hub says nothing of its network); a single
// candidate is chosen on its own. Not chosen, or no longer in the networks: down at once, for the admin to handle.

const INTERVAL_SEC = 60;
const TIMEOUT_SEC = 5;
// one lost packet over a tunnel is not a failure
const RETRIES = 1;

export const SOURCE_TODO = 'source à choisir';
export const TARGET_TODO = 'cible à choisir';
export const PAUSED = 'tunnel désactivé dans Omada : sonde en pause';

type VpnTarget = Extract<ProbeDoc['target'], { type: 'vpn' }>;

const todo = (message: string): Measure => ({ state: 'down', message, immediate: true });

const hostIps = (h: Pick<HostDoc, 'info'>) => h.info?.ips ?? [];

export interface VpnCandidates {
  sources: { id: string; name: string; ip: string; online?: boolean }[];
  targets: { kind: 'host' | 'equipment'; id: string; name: string; ip: string; gateway: boolean }[];
}

// The hosts able to ping from an address of the local networks, the hosts and equipments with an address in the remote
// ones (a gateway first: the most stable target).
export function vpnCandidates(v: Pick<OmadaVpn, 'localSubnets' | 'remoteSubnets'>, hostList: Pick<HostDoc, '_id' | 'name' | 'info' | 'capabilities'>[], equipmentList: Pick<EquipmentDoc, '_id' | 'name' | 'ip' | 'type'>[]): VpnCandidates {
  const sources = hostList
    .filter((h) => h.capabilities?.includes('ping_from'))
    .flatMap((h) => {
      const ip = addressIn(hostIps(h), v.localSubnets);
      return ip ? [{ id: h._id.toHexString(), name: h.name, ip }] : [];
    });
  const targets = [
    ...equipmentList.flatMap((e) => (e.ip && v.remoteSubnets.some((s) => inSubnet(e.ip!, s)) ? [{ kind: 'equipment' as const, id: e._id.toHexString(), name: e.name, ip: e.ip, gateway: e.type === 'gateway' }] : [])),
    ...hostList.flatMap((h) => {
      const ip = addressIn(hostIps(h), v.remoteSubnets);
      return ip ? [{ kind: 'host' as const, id: h._id.toHexString(), name: h.name, ip, gateway: false }] : [];
    }),
  ].sort((a, b) => Number(b.gateway) - Number(a.gateway) || a.name.localeCompare(b.name));
  return { sources, targets };
}

export const findVpn = async (t: Pick<VpnTarget, 'roleId' | 'vpnId'>) => (await omada.findOne({ _id: t.roleId }))?.vpns?.find((v) => v.id === t.vpnId) ?? null;

// What a measure reads (replaced in the tests)
export const vpnMeasureDeps = {
  findVpn,
  findHost: (_id: ObjectId) => hosts.findOne({ _id }, { projection: { name: 1, 'info.ips': 1 } }) as Promise<Pick<HostDoc, 'name' | 'info'> | null>,
  ping: (hostId: ObjectId, address: string, timeoutMs: number, from: string) => pingFromHost(hostId, address, timeoutMs, from),
};

// One measure of a VPN probe, with the networks of the last poll of its controller.
export async function measureVpn(p: Pick<ProbeDoc, 'runFrom' | 'timeoutSec'> & { target: VpnTarget }, deps = vpnMeasureDeps): Promise<Measure> {
  const v = await deps.findVpn(p.target);
  if (!v) return { state: 'unknown', message: 'tunnel inconnu du dernier relevé Omada' };
  if (!v.enabled) return { state: 'unknown', message: PAUSED };
  if (p.runFrom === 'hub') return todo(SOURCE_TODO);
  if (!p.target.host) return todo(TARGET_TODO);
  const source = await deps.findHost(p.runFrom.hostId);
  if (!source) return todo(SOURCE_GONE);
  const from = addressIn(hostIps(source), v.localSubnets);
  if (!from) return todo(`source ${source.name} hors des réseaux locaux du tunnel`);
  if (!v.remoteSubnets.some((s) => inSubnet(p.target.host, s))) return todo(`cible ${p.target.host} hors des réseaux distants du tunnel`);
  const m = await deps.ping(p.runFrom.hostId, p.target.host, p.timeoutSec * 1000, from);
  // the two signals side by side: the controller says the tunnel is down, or it is up and carries nothing
  if (m.state === 'down' && !m.immediate) return { ...m, message: `${m.message ?? 'pas de réponse'} (${v.established ? 'tunnel établi selon Omada' : 'tunnel non établi selon Omada'})` };
  return m;
}

const vpnQuery = (roleId: string) => ({ 'target.type': 'vpn', 'target.roleId': roleId });

// After a poll that read the VPNs of a controller: a probe for each tunnel whose gateway is an equipment, the single
// candidates set on a probe still to set up, the probes of the tunnels gone removed (the admin is told).
export async function syncVpnProbes(state: OmadaStateDoc) {
  const vpns = state.vpns ?? [];
  const existing = await probes.find(vpnQuery(state._id)).toArray();
  const gone = existing.filter((p) => p.target.type === 'vpn' && !vpns.some((v) => v.id === (p.target as VpnTarget).vpnId));
  if (gone.length) {
    await probes.deleteMany({ _id: { $in: gone.map((p) => p._id) } });
    publish('probe.removed', { host: '', reason: "le tunnel n'existe plus dans Omada", probes: gone.map((p) => ({ name: p.name })) });
  }
  const gateways = await equipments.find({ source: 'omada', type: 'gateway', externalId: { $in: state.devices.filter((d) => d.type === 'gateway').map((d) => d.mac) } }).toArray();
  const [hostList, equipmentList] = await Promise.all([
    hosts.find({}, { projection: { name: 1, 'info.ips': 1, capabilities: 1 } }).toArray(),
    equipments.find({}, { projection: { name: 1, ip: 1, type: 1 } }).toArray(),
  ]);
  let changed = gone.length > 0;
  for (const v of vpns) {
    const gw = state.devices.find((d) => d.type === 'gateway' && d.siteId === v.siteId);
    const equipment = gw && gateways.find((e) => e.externalId === gw.mac);
    if (!equipment) continue;
    const { sources, targets } = vpnCandidates(v, hostList, equipmentList);
    const only = <T>(l: T[]) => (l.length === 1 ? l[0] : undefined);
    const p = existing.find((x) => (x.target as VpnTarget).vpnId === v.id);
    if (!p) {
      const source = only(sources);
      const doc: ProbeDoc = {
        _id: new ObjectId(),
        subject: { kind: 'equipment', id: equipment._id },
        name: `VPN ${v.name}`,
        target: { type: 'vpn', roleId: state._id, vpnId: v.id, host: only(targets)?.ip ?? '' },
        runFrom: source ? { hostId: new ObjectId(source.id) } : 'hub',
        intervalSec: INTERVAL_SEC,
        timeoutSec: TIMEOUT_SEC,
        retries: RETRIES,
        createdAt: new Date(),
      };
      await probes.insertOne(doc);
      changed = true;
      continue;
    }
    // set up by the admin (or already completed): never touched again
    const t = p.target as VpnTarget;
    const set: Record<string, unknown> = {};
    if (p.runFrom === 'hub' && only(sources)) set.runFrom = { hostId: new ObjectId(only(sources)!.id) };
    if (!t.host && only(targets)) set['target.host'] = only(targets)!.ip;
    if (Object.keys(set).length) {
      await probes.updateOne({ _id: p._id }, { $set: set, $unset: { state: '', since: '', message: '' } });
      changed = true;
    }
  }
  if (changed) publish('probe.config', {});
}
