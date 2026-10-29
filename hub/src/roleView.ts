import { probeEngine, roleUrl } from './probes.js';
import type { HostDoc, RoleDoc } from './types.js';

// A role as the UI shows it, whatever its type (never a secret): the address the hub reaches, the account it uses, the
// state of the connection and what it gives (summary). host: its carrier (null when unknown).
export function roleView(r: RoleDoc, host: Pick<HostDoc, 'name' | 'info'> | null) {
  const base = { id: r._id, type: r.type, name: r.name, carrier: { kind: r.carrier.kind, id: r.carrier.id.toHexString(), name: host?.name ?? '' } };
  switch (r.type) {
    case 'mqtt-broker': {
      const { password, ...config } = r.config;
      return {
        ...base,
        config: { ...config, address: config.address ?? null },
        hasSecret: !!password,
        url: roleUrl(r.config, host?.info?.ips),
        account: r.config.username,
        status: probeEngine()?.pool.status(r._id) ?? null,
        summary: null,
      };
    }
    case 'pve-reporting': {
      const { tokenSecret, ...config } = r.config;
      return {
        ...base,
        config,
        hasSecret: !!tokenSecret,
        url: r.config.url,
        account: r.config.tokenId,
        // the last poll of the cluster (pve.ts), every 15 minutes
        status: r.config.polledAt ? { state: r.config.pollError ? ('error' as const) : ('connected' as const), error: r.config.pollError ?? null } : null,
        summary: r.config.guests === undefined ? null : `${r.config.guests} VM / CT`,
      };
    }
  }
}
