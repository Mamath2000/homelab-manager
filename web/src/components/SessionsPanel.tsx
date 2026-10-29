import { Lock, Monitor, MonitorSmartphone, Users } from 'lucide-react';
import type { Host, HostSession } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';
import { useMe } from '../lib/auth';
import { useRunJob } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Badge, Button, Panel, StatusDot } from './ui';
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
  const { canWrite } = useMe();
  const run = useRunJob();
  const toast = useToast();
  const canLock = canWrite && host.online && host.capabilities.includes('lock');
  const sessions = r ? [...r.sessions].sort((a, b) => rank(a) - rank(b) || a.id - b.id) : [];
  const sum = host.sessionSummary;
  const stale = !host.online;
  return (
    <Panel
      title="Sessions"
      icon={Users}
      actions={r && <span className="text-xs text-muted">relevé {timeAgo(r.checkedAt)}</span>}
      bodyClassName="p-0"
    >
      <>
        {stale && r && (
          <p className="border-b border-line px-4 py-2 text-xs text-amber-300">
            Agent hors ligne : dernier relevé {timeAgo(r.checkedAt)}. Les sessions affichées ne reflètent pas l’état actuel.
          </p>
        )}
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
                {!stale && sum.interactive && <Badge tone="ok">Activité clavier/souris</Badge>}
                {!stale && sum.locked && <Badge tone="warn">Verrouillé</Badge>}
                {sum.changedAt ? <span className="ml-auto text-xs text-muted">dernier changement {timeAgo(sum.changedAt)}</span> : null}
              </div>
            )}
            <ul className="divide-y divide-line">
              {sessions.map((s) => {
                const Icon = isRemote(s) ? MonitorSmartphone : Monitor;
                return (
                  <li key={s.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3 text-sm">
                    <Icon size={18} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                    <div className="min-w-0 flex-1 basis-40">
                      <div className="flex items-center gap-2">
                        {!stale && s.interactive && <StatusDot tone="ok" pulse />}
                        <span className="min-w-0 truncate text-zinc-100">
                          {s.domain ? <span className="text-muted">{s.domain}\</span> : null}
                          {s.user}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
                        <span>{isRemote(s) ? `Bureau à distance (${s.station})` : 'Console'}</span>
                        {!stale && s.interactive ? (
                          <span className="text-emerald-300">en cours d'utilisation</span>
                        ) : !stale && s.idleSec != null && s.state === 'active' ? (
                          <span>inactive depuis {idleLabel(s.idleSec)}</span>
                        ) : null}
                        {s.logonAt ? <span>ouverte le {dateTime(s.logonAt)}</span> : null}
                      </div>
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-2 max-sm:w-full max-sm:justify-between max-sm:pl-[30px]">
                      <div className="flex flex-col items-start gap-1 sm:items-end">
                        <Badge tone={stale ? 'neutral' : STATE[s.state].tone}>
                          {stale ? `Dernier état : ${STATE[s.state].label}` : STATE[s.state].label}
                        </Badge>
                        {s.stateAt ? <span className="text-xs text-muted">{timeAgo(s.stateAt)}</span> : null}
                      </div>
                      <Button
                        variant={s.state === 'locked' ? 'ghost' : 'secondary'}
                        icon={Lock}
                        title={
                          s.state === 'locked'
                            ? 'Session verrouillée'
                            : !host.online
                              ? 'Agent hors ligne'
                              : !canWrite
                                ? 'Action non autorisée'
                                : run.isPending
                                  ? 'Verrouillage en cours'
                                  : 'Cliquer pour verrouiller'
                        }
                        aria-label={s.state === 'locked' ? 'Session verrouillée' : 'Cliquer pour verrouiller'}
                        className={`h-11! w-11! px-0! [&>svg]:h-5 [&>svg]:w-5 ${s.state === 'locked' ? 'text-amber-300!' : ''}`}
                        disabled={!canLock || s.state === 'locked' || run.isPending}
                        onClick={() => run.mutate({ hostId: host.id, action: 'lock', target: { sessionId: s.id } }, { onSuccess: (j) => j.status !== 'failed' && toast.success(`Session de ${s.user} verrouillée`) })}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </>
    </Panel>
  );
}
