import type { Host } from './api';
import { useMe } from './auth';
import { useLogServers } from './queries';

// Address of the Logs page opened on one host.
export const hostLogsPath = (hostId: string, extra = '') => `/logs?host=${hostId}${extra}`;

// The journals of a host as its page sums them up: the log server it sends to, its last journal and its errors over a
// day (a link to the Logs page for who may read them). null: no log server, nothing is shown.
export function useHostLogs(host: Host | undefined) {
  const { canLogs } = useMe();
  const { data: servers = [] } = useLogServers();
  if (!host || !servers.length) return null;
  const check = host.setup?.modules.find((m) => m.module === 'log_forward');
  const server = servers.find((r) => r.id === (host.logs?.roleId ?? check?.role));
  return { canLogs, check, server, logs: host.logs };
}
