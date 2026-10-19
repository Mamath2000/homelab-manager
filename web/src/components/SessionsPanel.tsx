import { Users } from 'lucide-react';
import type { Host, HostSession } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';
import { Badge, Panel } from './ui';
import type { Tone } from '../lib/status';

const STATE: Record<HostSession['state'], { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'ok' },
  locked: { label: 'Verrouillée', tone: 'warn' },
  disconnected: { label: 'Déconnectée', tone: 'neutral' },
};

// Windows: the user sessions the agent reports (console, fast user switching, remote desktop).
export function SessionsPanel({ host }: { host: Host }) {
  const r = host.sessions;
  return (
    <Panel
      title="Sessions"
      icon={Users}
      actions={r && <span className="text-xs text-muted">relevé {timeAgo(r.checkedAt)}</span>}
      bodyClassName="p-0"
    >
      {!r ? (
        <p className="px-4 py-3 text-sm text-muted">Pas encore de relevé des sessions.</p>
      ) : r.sessions.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted">Aucun utilisateur connecté.</p>
      ) : (
        <ul className="divide-y divide-line">
          {r.sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-zinc-100">
                {s.domain ? <span className="text-muted">{s.domain}\</span> : null}
                {s.user}
              </span>
              {s.station && <span className="font-mono text-xs text-muted">{s.station}</span>}
              {s.logonAt ? <span className="text-xs text-muted">ouverte le {dateTime(s.logonAt)}</span> : null}
              <Badge tone={STATE[s.state].tone}>{STATE[s.state].label}</Badge>
            </li>
          ))}
        </ul>
      )}
      {!host.online && r && <p className="border-t border-line px-4 py-2 text-xs text-muted">Agent hors ligne : dernier état connu.</p>}
    </Panel>
  );
}
