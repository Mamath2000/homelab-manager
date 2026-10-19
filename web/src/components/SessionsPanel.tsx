import { Monitor, MonitorSmartphone, Users } from 'lucide-react';
import type { Host, HostSession } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';
import { Badge, Panel, StatusDot } from './ui';
import type { Tone } from '../lib/status';

const STATE: Record<HostSession['state'], { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'ok' },
  locked: { label: 'Verrouillée', tone: 'warn' },
  disconnected: { label: 'Déconnectée', tone: 'neutral' },
};

// interactive first, then active, locked, disconnected
const rank = (s: HostSession) => (s.interactive ? 0 : { active: 1, locked: 2, disconnected: 3 }[s.state]);

const idleLabel = (sec: number) => (sec < 3600 ? `${Math.max(1, Math.round(sec / 60))} min` : `${Math.round(sec / 3600)} h`);

const isRemote = (s: HostSession) => !!s.station && !/^console$/i.test(s.station);

// Windows: the user sessions the agent reports (console, fast user switching, remote desktop).
export function SessionsPanel({ host }: { host: Host }) {
  const r = host.sessions;
  const sessions = r ? [...r.sessions].sort((a, b) => rank(a) - rank(b) || a.id - b.id) : [];
  const sum = host.sessionSummary;
  return (
    <Panel
      title="Sessions"
      icon={Users}
      actions={r && <span className="text-xs text-muted">relevé {timeAgo(r.checkedAt)}</span>}
      bodyClassName="p-0"
    >
      {!r ? (
        <p className="px-4 py-3 text-sm text-muted">Pas encore de relevé des sessions.</p>
      ) : sessions.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted">Aucun utilisateur connecté.</p>
      ) : (
        <>
          {sum && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5 text-sm">
              <span className="text-zinc-100">
                {sum.users.length} utilisateur{sum.users.length > 1 ? 's' : ''}
              </span>
              <span className="text-muted">
                {sessions.length} session{sessions.length > 1 ? 's' : ''}
              </span>
              {sum.interactive && <Badge tone="ok">Activité clavier/souris</Badge>}
              {sum.locked && <Badge tone="warn">Verrouillé</Badge>}
              {sum.changedAt ? <span className="ml-auto text-xs text-muted">dernier changement {timeAgo(sum.changedAt)}</span> : null}
            </div>
          )}
          <ul className="divide-y divide-line">
            {sessions.map((s) => {
              const Icon = isRemote(s) ? MonitorSmartphone : Monitor;
              return (
                <li key={s.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                  <Icon size={18} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {s.interactive && <StatusDot tone="ok" pulse />}
                      <span className="min-w-0 truncate text-zinc-100">
                        {s.domain ? <span className="text-muted">{s.domain}\</span> : null}
                        {s.user}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
                      <span>{isRemote(s) ? `Bureau à distance (${s.station})` : 'Console'}</span>
                      {s.interactive ? (
                        <span className="text-emerald-300">en cours d'utilisation</span>
                      ) : s.idleSec != null && s.state === 'active' ? (
                        <span>inactive depuis {idleLabel(s.idleSec)}</span>
                      ) : null}
                      {s.logonAt ? <span>ouverte le {dateTime(s.logonAt)}</span> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge tone={STATE[s.state].tone}>{STATE[s.state].label}</Badge>
                    {s.stateAt ? <span className="text-xs text-muted">{timeAgo(s.stateAt)}</span> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {!host.online && r && <p className="border-t border-line px-4 py-2 text-xs text-muted">Agent hors ligne : dernier état connu.</p>}
    </Panel>
  );
}
