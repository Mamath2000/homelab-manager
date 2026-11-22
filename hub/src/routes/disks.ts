import type { FastifyInstance } from 'fastify';
import { guests, hosts } from '../db.js';
import { loadHealthSettings, resolveHealthSettings } from '../health.js';
import { loadPveSettings } from '../pve.js';

// What the Disks page needs beyond the hosts (GET /api/hosts carries their volumes, SMART, RAID and Ceph): the thresholds
// of each host (to draw them on the bars), the disks of the Proxmox VE guests with the host each one is, and the space of
// the storages of the clusters. Every profile reads.
export function registerDiskRoutes(app: FastifyInstance) {
  app.get('/api/disks', async () => {
    const [s, global, hostList, guestList] = await Promise.all([
      loadPveSettings(),
      loadHealthSettings(),
      hosts.find({}, { projection: { healthOverrides: 1 } }).toArray(),
      guests.find({}, { projection: { cluster: 1, vmid: 1, type: 1, node: 1, name: 1, status: 1, hostId: 1, ambiguous: 1, disks: 1, diskUsed: 1 } })
        .sort({ cluster: 1, vmid: 1 }).toArray(),
    ]);
    return {
      thresholds: Object.fromEntries(hostList.map((h) => {
        const t = resolveHealthSettings(global, h.healthOverrides);
        return [h._id.toHexString(), {
          diskWarning: t.diskWarningThreshold,
          diskAlert: t.diskAlertThreshold,
          temperatureWarning: t.smartTemperatureWarningThreshold,
          temperatureAlert: t.smartTemperatureAlertThreshold,
          wearWarning: t.smartWearWarningThreshold,
          wearAlert: t.smartWearAlertThreshold,
        }];
      })),
      clusters: s.clusters.map((c) => ({ id: c.id, name: c.name, nodes: (c.nodes ?? []).map((n) => n.node), polledAt: c.polledAt ?? null, storages: c.storages ?? [] })),
      guests: guestList.map((g) => ({
        cluster: g.cluster,
        vmid: g.vmid,
        type: g.type,
        node: g.node,
        name: g.name,
        status: g.status,
        hostId: g.ambiguous ? null : (g.hostId ?? null),
        disks: g.disks ?? [],
        diskUsed: g.diskUsed ?? null,
      })),
    };
  });
}
