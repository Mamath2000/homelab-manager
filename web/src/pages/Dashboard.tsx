import { useState } from 'react';
import clsx from 'clsx';
import { LayoutDashboard, Plus, Server, Zap } from 'lucide-react';
import { AddHostModal } from '../components/AddHostModal';
import { AlertZone } from '../components/AlertZone';
import { DashboardActions } from '../components/DashboardActions';
import { DashboardTodo } from '../components/DashboardTodo';
import { FloatingAside } from '../components/FloatingAside';
import { useAsideDocked } from '../lib/asideDocked';
import { MountBanner } from '../components/PbsMount';
import { SiteOverview } from '../components/SiteOverview';
import { SiteTimeline } from '../components/SiteTimeline';
import { HeaderTitle } from '../components/HeaderSlot';
import { Button, Empty, Spinner } from '../components/ui';
import { useBackups, useEquipments, useHosts, useJobs, useSites } from '../lib/queries';
import { groupSites } from '../lib/sites';
import { useMe } from '../lib/auth';

export function Dashboard() {
  const { data: hosts, isLoading } = useHosts();
  const { data: jobs, dataUpdatedAt: jobsAt } = useJobs();
  const { data: backups } = useBackups();
  const { data: siteConfig } = useSites();
  const { data: equipments } = useEquipments();
  const { canWrite, canManage } = useMe();
  const [adding, setAdding] = useState(false);
  const [docked, setDocked] = useAsideDocked();

  if (isLoading || !hosts) return <div className="flex justify-center p-20"><Spinner /></div>;

  const sites = groupSites(hosts, siteConfig ?? [], equipments ?? []);
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
          <AlertZone hosts={hosts} groups={groups} />
          <div className={clsx('grid items-start gap-4', docked && 'grid-cols-[minmax(0,1fr)_400px]')}>
            <div className="flex min-w-0 flex-col gap-4">
              <SiteOverview sites={sites} />
              <SiteTimeline sites={sites} />
            </div>
            <FloatingAside label="Actions et à-faire" icon={Zap} docked={docked} onDock={setDocked}>
              {canWrite && <DashboardActions hosts={hosts} groups={groups} />}
              <DashboardTodo hosts={hosts} groups={groups} jobs={jobs} jobsAt={jobsAt} />
            </FloatingAside>
          </div>
        </div>
      )}
      <AddHostModal open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
