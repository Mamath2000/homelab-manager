import { bridgeStatusOf } from './homeassistant/bridge.js';
import { omadaPollOf } from './omadaSync.js';
import { probeEngine, roleUrl } from './probes.js';
import type { HostDoc, RoleDoc } from './types.js';

// A role as the UI shows it, whatever its type (never a secret): the address the hub reaches, the account it uses, the
// state of the connection and what it gives (summary). host: its carrier (null when unknown).
// a broker is used by the probes (pool) and by the Home Assistant bridge, each with its own connection: the worst one shows
const RANK = { connected: 0, connecting: 1, error: 2 } as const;
const worst = <T extends { state: keyof typeof RANK }>(list: (T | null)[]) =>
  list.reduce<T | null>((a, b) => (!b ? a : !a || RANK[b.state] > RANK[a.state] ? b : a), null);

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
        status: worst([probeEngine()?.pool.status(r._id) ?? null, bridgeStatusOf(r._id)]),
        summary: null,
      };
    }
    case 'pve-cluster': {
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
    // the settings of the backups: only what the UI shows of them
    case 'pbs-primary': {
      const c = r.config;
      return {
        ...base,
        config: { url: c.url, tailscaleUrl: c.tailscaleUrl ?? '', mode: c.agent?.mode ?? 'native', container: c.agent?.container ?? '' },
        hasSecret: !!c.tokenSecret,
        url: c.url,
        account: c.tokenId,
        status: c.polledAt ? { state: c.pollError ? ('error' as const) : ('connected' as const), error: c.pollError ?? null } : null,
        summary: c.datastores ? `${c.datastores.length} datastore${c.datastores.length > 1 ? 's' : ''}` : null,
      };
    }
    case 'pbs-offsite': {
      const c = r.config;
      const error = c.pollError || c.agentError || null;
      return {
        ...base,
        config: { url: c.url, tailscaleUrl: c.tailscaleUrl ?? '', store: c.store, startTime: c.startTime ?? '' },
        hasSecret: !!c.tokenSecret,
        url: c.url,
        account: c.tokenId,
        status: c.polledAt ? { state: error ? ('error' as const) : ('connected' as const), error } : null,
        summary: c.agentReport?.day ? `datastore ${c.store}, dernière série ${c.agentReport.day}` : c.store ? `datastore ${c.store}` : null,
      };
    }
    // the state of its last poll (omadaSync.ts): every 5 minutes, sites, devices and VPNs
    case 'omada-controller': {
      const { clientSecret, ...config } = r.config;
      const p = omadaPollOf(r._id);
      const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
      const summary = p?.polledAt && !p.pollError
        ? [plural(p.sites, 'site', 'sites'), plural(p.devices, 'appareil', 'appareils'), p.vpnError ? 'lecture des VPN en échec' : p.vpns !== undefined ? plural(p.vpns, 'VPN', 'VPN') : null].filter(Boolean).join(', ')
        : null;
      return {
        ...base,
        config,
        hasSecret: !!clientSecret,
        url: r.config.url,
        account: r.config.clientId,
        status: p?.polledAt ? { state: p.pollError ? ('error' as const) : ('connected' as const), error: p.pollError ?? null } : null,
        summary,
      };
    }
  }
}
