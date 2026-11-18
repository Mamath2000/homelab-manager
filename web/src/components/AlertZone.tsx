import { Link } from 'react-router';
import clsx from 'clsx';
import { Check, ScrollText } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, type BackupGroup, type Host, type LogQuery } from '../lib/api';
import { useMe } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { hostLogsPath } from '../lib/hostLogs';
import { useLogServers } from '../lib/queries';
import { aptTile, backupTile, count, oldestBackup } from '../lib/sites';
import { allStacks, connection, hasApt, needsReinstall } from '../lib/status';

type Level = 'bad' | 'warn';
interface Alert { key: string; level: Level; n: number; label: string; to: string }
interface Note { key: string; label: string; to: string }

const chipCls: Record<Level, string> = {
  bad: 'border-red-500/45 bg-red-500/10 [&_b]:text-red-400',
  warn: 'border-amber-500/45 bg-amber-500/10 [&_b]:text-amber-400',
};
const ring: Record<Level | 'ok', string> = {
  bad: 'border-red-500 bg-red-500/15 text-red-400',
  warn: 'border-amber-500 bg-amber-500/15 text-amber-400',
  ok: 'border-emerald-500 bg-emerald-500/15 text-emerald-400',
};
const dot: Record<Level | 'ok', string> = { bad: 'bg-red-500', warn: 'bg-amber-500', ok: 'bg-emerald-500' };
const plural = (n: number, one: string, many = `${one}s`) => (n > 1 ? many : one);

const LOG_RANGE: LogQuery = { severity: 3, from: '24h' };
const BARS = 24;

// Lines and histogram of the errors of the last 24 h, read on the first log server (readers of the journals only).
function useErrorLogs(enabled: boolean, role: string | undefined) {
  const hits = useQuery({ queryKey: ['logs', 'dashboard', 'hits', role], queryFn: () => api.logHits({ ...LOG_RANGE, role }), enabled, refetchInterval: 60_000 });
  const rows = useQuery({ queryKey: ['logs', 'dashboard', 'rows', role], queryFn: () => api.logs({ ...LOG_RANGE, role }, 3), enabled, refetchInterval: 60_000 });
  // the series summed, then the steps grouped into BARS bars
  const steps = hits.data?.timestamps.map((_, i) => hits.data!.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)) ?? [];
  const bars = Array.from({ length: BARS }, (_, b) => steps.slice(Math.floor((b * steps.length) / BARS), Math.floor(((b + 1) * steps.length) / BARS)).reduce((a, n) => a + n, 0));
  const total = steps.reduce((a, n) => a + n, 0);
  return { bars, total, rows: rows.data?.rows ?? [], loading: hits.isLoading || rows.isLoading, error: hits.error ?? rows.error };
}

function Chip({ to, level, n, label }: { to: string; level: Level; n: number; label: string }) {
  return (
    <Link to={to} className={clsx('inline-flex items-center gap-2 rounded-lg border px-2.5 py-1 text-[13px] text-zinc-100 hover:brightness-125', chipCls[level])}>
      <b className="text-[15px] tabular-nums">{n}</b>
      {label}
    </Link>
  );
}

function Ghost({ to, label }: { to: string; label: string }) {
  return <Link to={to} className="inline-flex items-center rounded-lg border border-line px-2.5 py-1 text-[13px] text-muted hover:text-zinc-200">{label}</Link>;
}

function LogsPanel({ role }: { role: string | undefined }) {
  const { bars, total, rows, loading, error } = useErrorLogs(true, role);
  const max = Math.max(1, ...bars);
  const level: Level | 'ok' = error ? 'warn' : total > 0 ? 'warn' : 'ok';
  return (
    <section className="panel flex min-w-0 flex-col">
      <header className="flex items-center gap-2.5 border-b border-line px-4 py-2.5">
        <span className={clsx('h-2 w-2 rounded-full', dot[level])} />
        <h2 className="text-sm font-medium text-zinc-200">Journaux · erreurs sur 24 h</h2>
        {total > 0 && <span className="rounded-full bg-amber-500/15 px-2 text-xs tabular-nums text-amber-400">{total}</span>}
        <Link to="/logs?sev=3&from=24h" className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 text-xs text-zinc-200 hover:bg-zinc-800"><ScrollText className="h-3.5 w-3.5" />Ouvrir les logs</Link>
      </header>
      <div className="flex h-[34px] items-end gap-0.5 px-4 pt-3" aria-hidden>
        {bars.map((n, i) => <span key={i} className={clsx('flex-1 rounded-[1px]', n ? 'bg-red-500' : 'bg-zinc-800')} style={{ height: n ? Math.max(3, Math.round((n / max) * 34)) : 3 }} />)}
      </div>
      {error ? (
        <p className="px-4 py-2 text-xs text-amber-300">Serveur de logs injoignable : {(error as Error).message}</p>
      ) : loading ? (
        <p className="px-4 py-2 text-xs text-muted">Lecture des journaux…</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-2 text-xs text-muted">Aucune erreur sur 24 h.</p>
      ) : (
        <ul className="mt-2 font-mono text-xs">
          {rows.map((r) => (
            <li key={`${r.time}|${r.hostname}|${r.message}`} className="border-t border-line first:border-t-0">
              <Link to={r.hostId ? hostLogsPath(r.hostId, '&sev=3&from=24h') : '/logs?sev=3&from=24h'} className="grid grid-cols-[3.5rem_0.5rem_8rem_6rem_minmax(0,1fr)] items-center gap-2 px-4 py-1.5 hover:bg-raised/50">
                <span className="text-muted" title={r.time}>{timeAgo(Date.parse(r.time)).replace('il y a ', '')}</span>
                <span className={clsx('h-2 w-2 rounded-full', r.severity <= 3 ? 'bg-red-500' : 'bg-amber-500')} />
                <span className="truncate text-zinc-200">{r.hostName}</span>
                <span className="truncate text-muted">{r.app}</span>
                <span className="truncate text-zinc-300">{r.message}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Top of the dashboard: one verdict and the few figures that need action (red: act now, orange: look at it), the
// rest in grey. With a log server, a second card shows the errors of the last 24 h. Replaces the old rows of figures.
export function AlertZone({ hosts, groups }: { hosts: Host[]; groups: BackupGroup[] | undefined }) {
  const { canLogs } = useMe();
  const { data: servers = [] } = useLogServers();

  const apt = hosts.filter(hasApt).map(aptTile);
  const security = count(apt, 'security');
  const updates = count(apt, 'updates');
  const reboot = hosts.filter((h) => h.aptSummary?.rebootRequired).length;
  const bak = hosts.map((h) => backupTile(groups, h.id));
  const backupFail = count(bak, 'bad');
  const backupLate = count(bak, 'warn');
  const oldest = oldestBackup(hosts, groups);
  const stacks = allStacks(hosts).filter((s) => s.managed);
  const stackProblems = stacks.filter((s) => s.problems.length > 0).length;
  const stackUpdates = stacks.filter((s) => s.updates > 0).length;
  const offline = hosts.filter((h) => connection(h) === 'offline' && !needsReinstall(h)).length;
  const reinstall = hosts.filter(needsReinstall).length;
  const logHostsErrors = hosts.filter((h) => (h.logs?.errors ?? 0) > 0).length;
  const logSilent = hosts.filter((h) => h.setup?.modules.some((m) => m.module === 'log_forward' && m.silent)).length;
  const hasLogs = servers.length > 0;

  const alerts: Alert[] = [
    { key: 'sec', level: 'bad' as const, n: security, label: security > 1 ? 'hôtes avec des correctifs de sécurité' : 'hôte avec des correctifs de sécurité', to: '/hosts?f=security' },
    { key: 'bak', level: 'bad' as const, n: backupFail, label: plural(backupFail, 'sauvegarde en échec', 'sauvegardes en échec'), to: '/backups?f=late' },
    { key: 'stk', level: 'bad' as const, n: stackProblems, label: plural(stackProblems, 'stack Docker en problème', 'stacks Docker en problème'), to: '/docker?f=problems' },
    { key: 'off', level: 'bad' as const, n: offline, label: plural(offline, 'hôte hors ligne', 'hôtes hors ligne'), to: '/hosts?f=offline' },
    { key: 'rei', level: 'bad' as const, n: reinstall, label: plural(reinstall, 'hôte à réinstaller', 'hôtes à réinstaller'), to: '/hosts?f=reinstall' },
    { key: 'late', level: 'warn' as const, n: backupLate, label: plural(backupLate, 'sauvegarde en retard', 'sauvegardes en retard'), to: '/backups?f=late' },
    { key: 'log', level: 'warn' as const, n: hasLogs ? logHostsErrors : 0, label: `${plural(logHostsErrors, 'hôte')} avec des erreurs de logs · 24 h`, to: canLogs ? '/logs?sev=3&from=24h' : '/hosts' },
    { key: 'mute', level: 'warn' as const, n: hasLogs ? logSilent : 0, label: plural(logSilent, 'hôte sans journaux', 'hôtes sans journaux'), to: '/settings?tab=logs' },
  ].filter((a) => a.n > 0);
  const bad = alerts.filter((a) => a.level === 'bad');
  const warn = alerts.filter((a) => a.level === 'warn');
  const notes: Note[] = [
    { key: 'upd', label: `${updates} ${plural(updates, 'hôte')} avec des mises à jour`, to: '/updates' },
    { key: 'reb', label: `${reboot} ${plural(reboot, 'redémarrage')} requis`, to: '/hosts?f=reboot' },
    { key: 'img', label: `${stackUpdates} ${plural(stackUpdates, 'stack')} avec une image plus récente`, to: '/docker?f=updates' },
  ].filter((_, i) => [updates, reboot, stackUpdates][i] > 0);

  const level: Level | 'ok' = bad.length ? 'bad' : warn.length ? 'warn' : 'ok';
  const total = alerts.length;
  const title =
    level === 'ok'
      ? 'Tout est en ordre'
      : [bad.length && `${bad.length} ${plural(bad.length, 'problème')}`, warn.length && `${warn.length} ${plural(warn.length, 'avertissement')}`].filter(Boolean).join(' · ');
  const showLogs = canLogs && hasLogs;
  const oldestDays = oldest === null ? null : Math.floor(oldest / (24 * 3600 * 1000));

  return (
    <div className={clsx('grid gap-3', showLogs && 'lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]')}>
      <section className={clsx('panel flex flex-col gap-3 px-[18px] py-4', level === 'ok' && 'border-emerald-500/35 bg-gradient-to-r from-emerald-500/[0.07] to-transparent')}>
        <div className="flex items-center gap-3.5">
          <span className={clsx('flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 text-xl font-bold', ring[level])}>
            {level === 'ok' ? <Check className="h-5 w-5" /> : total}
          </span>
          <div className="min-w-0">
            <p className="text-xl font-semibold text-zinc-100">{title}</p>
            <p className="text-xs text-muted">
              {level === 'ok'
                ? `${hosts.length} ${plural(hosts.length, 'hôte')} · ${stacks.length} ${plural(stacks.length, 'stack')}${oldestDays === null ? '' : ` · dernière sauvegarde il y a ${oldestDays} j au plus`}`
                : 'le plus grave d’abord ; un clic ouvre la page filtrée'}
            </p>
          </div>
        </div>
        {(alerts.length > 0 || notes.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {[...bad, ...warn].map((a) => <Chip key={a.key} to={a.to} level={a.level} n={a.n} label={a.label} />)}
            {notes.map((n) => <Ghost key={n.key} to={n.to} label={n.label} />)}
          </div>
        )}
      </section>
      {showLogs && <LogsPanel role={servers[0]?.id} />}
    </div>
  );
}
