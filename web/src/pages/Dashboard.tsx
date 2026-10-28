import { useState } from 'react';
import clsx from 'clsx';
import { LayoutDashboard, Plus, Server } from 'lucide-react';
import { AddHostModal } from '../components/AddHostModal';
import { DashboardActions } from '../components/DashboardActions';
import { DashboardTodo } from '../components/DashboardTodo';
import { MountBanner } from '../components/PbsMount';
import { SiteOverview } from '../components/SiteOverview';
import { SiteTimeline } from '../components/SiteTimeline';
import { HeaderTitle } from '../components/HeaderSlot';
import { Button, Empty, Spinner } from '../components/ui';
import { useBackups, useHosts, useJobs, useSites } from '../lib/queries';
import { aptTile, backupTile, count, groupSites, oldestBackup } from '../lib/sites';
import { allStacks, hasApt, type Tone } from '../lib/status';
import { useMe } from '../lib/auth';
import type { BackupGroup, Host } from '../lib/api';

const border: Record<Tone, string> = {
  ok: 'border-emerald-500',
  warn: 'border-amber-500',
  bad: 'border-red-500',
  info: 'border-sky-500',
  unknown: 'border-violet-500',
  neutral: 'border-line',
};

function Kpi({ value, label, tone }: { value: string | number; label: string; tone: Tone }) {
  return (
    <div className={clsx('border-l-[3px] py-0.5 pl-2.5', border[tone])}>
      <b className="block text-[26px] font-semibold leading-tight tabular-nums text-zinc-100">{value}</b>
      <span className="text-xs text-muted">{label}</span>
    </div>
  );
}

function KpiGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2.5 px-4 py-3">
      <p className="col-span-full text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</p>
      {children}
    </section>
  );
}

// Figures of the priorities, same weight: system updates (security first), backups and Docker.
function Kpis({ hosts, groups, backups }: { hosts: Host[]; groups: BackupGroup[] | undefined; backups: boolean }) {
  const apt = hosts.filter(hasApt).map(aptTile);
  const followed = apt.filter((t) => t !== 'unknown' && t !== 'offline').length;
  const security = count(apt, 'security');
  const updates = security + count(apt, 'updates');
  const reboot = hosts.filter((h) => h.aptSummary?.rebootRequired).length;
  const bak = hosts.map((h) => backupTile(groups, h.id));
  const tracked = bak.filter((b) => b !== 'none').length;
  const oldest = oldestBackup(hosts, groups);
  const oldestDays = oldest === null ? null : Math.floor(oldest / (24 * 3600 * 1000));
  // managed stacks only: an unmanaged one has neither state nor problems to follow
  const stacks = allStacks(hosts).filter((s) => s.managed);
  const stackProblems = stacks.filter((s) => s.problems.length > 0).length;
  const stackUpdates = stacks.filter((s) => s.updates > 0).length;
  const stackStopped = stacks.filter((s) => s.status === 'stopped' || s.status === 'down').length;
  const stackRunning = stacks.filter((s) => s.status === 'running').length;
  const docker = hosts.some((h) => h.docker);
  return (
    <div className={clsx('grid gap-3', backups && docker ? 'lg:grid-cols-3' : (backups || docker) && 'lg:grid-cols-2')}>
      <KpiGroup title="Mises à jour">
        <Kpi value={security} label="hôtes avec des correctifs de sécurité" tone={security ? 'bad' : 'ok'} />
        <Kpi value={`${updates} / ${followed}`} label="hôtes avec des mises à jour" tone={updates ? 'warn' : 'ok'} />
        <Kpi value={reboot} label="redémarrages requis" tone={reboot ? 'info' : 'ok'} />
      </KpiGroup>
      {backups && (
        <KpiGroup title="Sauvegardes">
          <Kpi value={count(bak, 'bad')} label="hôtes en échec" tone={count(bak, 'bad') ? 'bad' : 'ok'} />
          <Kpi value={count(bak, 'warn')} label="hôtes en retard" tone={count(bak, 'warn') ? 'warn' : 'ok'} />
          <Kpi value={`${count(bak, 'ok')} / ${tracked}`} label="à jour sur les hôtes suivis" tone={count(bak, 'ok') === tracked ? 'ok' : 'warn'} />
          <Kpi value={oldestDays === null ? '—' : `${oldestDays} j`} label="âge de la plus ancienne" tone={oldestDays === null ? 'neutral' : oldestDays > 3 ? 'bad' : oldestDays > 1 ? 'warn' : 'ok'} />
        </KpiGroup>
      )}
      {docker && (
        <KpiGroup title="Docker">
          <Kpi value={stackProblems} label="stacks en problème" tone={stackProblems ? 'bad' : 'ok'} />
          <Kpi value={stackUpdates} label="stacks avec une image plus récente" tone={stackUpdates ? 'warn' : 'ok'} />
          <Kpi value={stackStopped} label="stacks arrêtées" tone={stackStopped ? 'info' : 'ok'} />
          <Kpi value={`${stackRunning} / ${stacks.length}`} label="stacks en marche" tone={stackRunning === stacks.length ? 'ok' : 'warn'} />
        </KpiGroup>
      )}
    </div>
  );
}

export function Dashboard() {
  const { data: hosts, isLoading } = useHosts();
  const { data: jobs, dataUpdatedAt: jobsAt } = useJobs();
  const { data: backups } = useBackups();
  const { data: siteConfig } = useSites();
  const { canWrite, canManage } = useMe();
  const [adding, setAdding] = useState(false);

  if (isLoading || !hosts) return <div className="flex justify-center p-20"><Spinner /></div>;

  const sites = groupSites(hosts, siteConfig ?? []);
  // only the backups attached to a host are followed (without PBS: those of Home Assistant)
  const withBackups = !!backups && (backups.connected || backups.groups.length > 0);
  const groups = withBackups ? backups.groups : undefined;

  return (
    <>
      <HeaderTitle icon={LayoutDashboard} title="Tableau de bord" />

      {hosts.length === 0 ? (
        <div className="panel">
          <Empty icon={Server} title="Aucun hôte pour l'instant">
            Ajoute ton premier serveur ou LXC : une commande à copier, et l'agent remonte son état en quelques secondes.
            {canManage && <div className="mt-4"><Button icon={Plus} variant="primary" onClick={() => setAdding(true)}>Ajouter un hôte</Button></div>}
          </Empty>
        </div>
      ) : (
        <div className="space-y-4">
          <MountBanner hosts={hosts} />
          <Kpis hosts={hosts} groups={groups} backups={withBackups} />
          <div className="min-[1100px]:hidden">
            <DashboardTodo section="others" hosts={hosts} groups={groups} jobs={jobs} jobsAt={jobsAt} />
          </div>
          <div className="grid items-start gap-4 min-[1100px]:grid-cols-[minmax(0,1fr)_400px]">
            <div className="flex min-w-0 flex-col gap-4">
              <SiteOverview sites={sites} />
              <SiteTimeline sites={sites} />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              {canWrite && <DashboardActions hosts={hosts} groups={groups} />}
              <div className="hidden min-[1100px]:block">
                <DashboardTodo hosts={hosts} groups={groups} jobs={jobs} jobsAt={jobsAt} />
              </div>
              <div className="min-[1100px]:hidden">
                <DashboardTodo section="regular" hosts={hosts} groups={groups} jobs={jobs} jobsAt={jobsAt} />
              </div>
            </div>
          </div>
        </div>
      )}
      <AddHostModal open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
