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
    // nothing reads it yet (#231): no state
    case 'omada-controller': {
      const { clientSecret, ...config } = r.config;
      return { ...base, config, hasSecret: !!clientSecret, url: r.config.url, account: r.config.clientId, status: null, summary: null };
    }
  }
}
