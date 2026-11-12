import { Link } from 'react-router';
import type { Host } from '../lib/api';
import { timeAgo } from '../lib/format';
import { hostLogsPath, useHostLogs } from '../lib/hostLogs';

// The line « Journaux » of a host page.
export function HostLogsStatus({ host }: { host: Host }) {
  const state = useHostLogs(host);
  if (!state) return null;
  const { canLogs, check, server, logs } = state;
  if (!logs) {
    if (check?.silent) return <span className="text-amber-300" title={check.detail}>aucun journal reçu</span>;
    return <span className="text-muted">{check && check.state !== 'na' ? `aucun journal reçu${server ? ` par ${server.name}` : ''}` : 'non envoyés'}</span>;
  }
  const errors = logs.errors ? `${logs.errors} erreur${logs.errors > 1 ? 's' : ''} sur 24 h` : 'aucune erreur sur 24 h';
  return (
    <span title={server ? `Envoyés à ${server.name}` : undefined}>
      <span className={check?.silent ? 'text-amber-300' : undefined}>reçu {timeAgo(logs.lastAt)}</span>
      {' · '}
      {canLogs && logs.errors ? (
        <Link to={hostLogsPath(host.id, '&sev=3&from=24h')} className="text-red-300 hover:underline">{errors}</Link>
      ) : (
        <span className={logs.errors ? 'text-red-300' : 'text-muted'}>{errors}</span>
      )}
    </span>
  );
}
