import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ClipboardList, DatabaseBackup, ShieldAlert, type LucideIcon } from 'lucide-react';
import type { BackupGroup, Host, Job } from '../lib/api';
import { backupStateMeta, groupLabel } from '../lib/backups';
import { jobTitle, timeAgo } from '../lib/format';
import { NO_SITE } from '../lib/sites';
import { allStacks, connection, needsReinstall, stackPath } from '../lib/status';
import { Badge, Panel } from './ui';

const MAX = 6;

function Row({ to, badge, title, right, sub }: { to: string; badge: ReactNode; title: ReactNode; right?: ReactNode; sub?: ReactNode }) {
  return (
    <li className="border-t border-line first:border-t-0">
      <Link to={to} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 py-2 text-sm hover:bg-raised/50">
        {badge}
        <span className="truncate text-zinc-200">{title}</span>
        <span className="text-xs text-muted">{right}</span>
        {sub && <span className="col-start-2 col-end-4 truncate text-[11px] text-muted">{sub}</span>}
      </Link>
    </li>
  );
}

function TodoPanel({ title, icon, more, children }: { title: string; icon: LucideIcon; more: string; children: ReactNode[] }) {
  return (
    <Panel title={title} icon={icon} bodyClassName="px-4 py-1">
      <ul>{children.slice(0, MAX)}</ul>
      {children.length > MAX && (
        <Link to={more} className="block pb-2 pt-1 text-xs text-muted hover:text-zinc-200">
          + {children.length - MAX} autre{children.length - MAX > 1 ? 's' : ''}
        </Link>
      )}
    </Panel>
  );
}

const site = (h: Host | undefined) => h?.group?.trim() || NO_SITE;

// Lists of the right column: backups to watch, then pending security updates, then the rest (hosts
// offline, agents to reinstall, Docker problems, failed tasks of the last 24 h).
export function DashboardTodo({ hosts, groups, jobs, jobsAt }: { hosts: Host[]; groups: BackupGroup[] | undefined; jobs: Job[] | undefined; jobsAt: number }) {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const failedFirst = (g: BackupGroup) => (g.state === 'failed' || g.state === 'task_failed' ? 0 : 1);
  const backups = (groups ?? []).filter((g) => g.state !== 'ok').sort((a, b) => failedFirst(a) - failedFirst(b) || a.lastBackup - b.lastBackup);
  const security = hosts.filter((h) => (h.aptSummary?.security ?? 0) > 0).sort((a, b) => b.aptSummary!.security - a.aptSummary!.security);

  const offline = hosts.filter((h) => connection(h) === 'offline' && !needsReinstall(h));
  const reinstall = hosts.filter(needsReinstall);
  const problems = allStacks(hosts).filter((s) => s.managed && s.problems.length > 0);
  const dayAgo = jobsAt - 24 * 3600 * 1000;
  const failedJobs = (jobs ?? []).filter((j) => j.status === 'failed' && Date.parse(j.createdAt) > dayAgo);
  const others = [
    ...offline.map((h) => (
      <Row key={`off-${h.id}`} to={`/hosts/${h.id}`} badge={<Badge tone="bad">hors ligne</Badge>} title={h.name} right={timeAgo(h.lastSeenAt)} sub={site(h)} />
    )),
    ...reinstall.map((h) => (
      <Row key={`re-${h.id}`} to={`/hosts/${h.id}`} badge={<Badge tone="bad">réinstaller</Badge>} title={h.name} sub="ancien jeton refusé : nouvelle commande d'installation depuis sa fiche" />
    )),
    ...problems.map((s) => (
      <Row key={`st-${s.host.id}-${s.name}`} to={stackPath(s.host.id, s.name)} badge={<Badge tone="bad">Docker</Badge>} title={s.name} right={s.host.name} sub={s.problems.join(', ')} />
    )),
    ...failedJobs.map((j) => (
      <Row key={`job-${j.id}`} to={`/jobs/${j.id}`} badge={<Badge tone="bad">échec</Badge>} title={jobTitle(j)} right={timeAgo(j.createdAt)} sub={j.hostName} />
    )),
  ];

  return (
    <>
      {backups.length > 0 && (
        <TodoPanel title="Sauvegardes à surveiller" icon={DatabaseBackup} more="/backups?f=late">
          {backups.map((g) => {
            const h = g.hostId ? byId.get(g.hostId) : undefined;
            return (
              <Row
                key={g.id}
                to={g.hostId ? `/backups?host=${g.hostId}` : '/backups?f=late'}
                badge={<Badge tone={backupStateMeta[g.state].tone}>{failedFirst(g) === 0 ? 'échec' : 'retard'}</Badge>}
                title={h?.name ?? groupLabel(g)}
                right={g.lastBackup ? timeAgo(g.lastBackup) : 'jamais'}
                sub={`${h ? `${site(h)} · ${groupLabel(g)}` : groupLabel(g)} · ${backupStateMeta[g.state].label}`}
              />
            );
          })}
        </TodoPanel>
      )}
      {security.length > 0 && (
        <TodoPanel title="Correctifs de sécurité en attente" icon={ShieldAlert} more="/updates">
          {security.map((h) => (
            <Row
              key={h.id}
              to={`/hosts/${h.id}`}
              badge={<Badge tone="bad">{h.aptSummary!.security} sécu</Badge>}
              title={h.name}
              right={`${h.aptSummary!.upgradable} paquet${h.aptSummary!.upgradable > 1 ? 's' : ''}`}
              sub={site(h)}
            />
          ))}
        </TodoPanel>
      )}
      {others.length > 0 && (
        <TodoPanel title="Autres points à traiter" icon={ClipboardList} more="/activity">
          {others}
        </TodoPanel>
      )}
    </>
  );
}
