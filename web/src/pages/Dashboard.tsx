import { useState } from 'react';
import clsx from 'clsx';
import { LayoutDashboard, Plus, RefreshCw, Server } from 'lucide-react';
import { AddHostModal } from '../components/AddHostModal';
import { DashboardActions } from '../components/DashboardActions';
import { DashboardTodo } from '../components/DashboardTodo';
import { SiteOverview } from '../components/SiteOverview';
import { SiteTimeline } from '../components/SiteTimeline';
import { Button, Empty, PageHeader, Spinner } from '../components/ui';
import { useBackups, useHosts, useJobs, useRunBulk, useSites } from '../lib/queries';
import { aptTile, backupTile, count, groupSites, oldestBackup } from '../lib/sites';
import { hasApt, type Tone } from '../lib/status';
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

// Figures of the two priorities, same weight: system updates (security first) and backups.
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
  return (
    <div className={clsx('grid gap-3', backups && 'lg:grid-cols-2')}>
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
    </div>
  );
}

export function Dashboard() {
  const { data: hosts, isLoading } = useHosts();
  const { data: jobs, dataUpdatedAt: jobsAt } = useJobs();
  const { data: backups } = useBackups();
  const { data: siteConfig } = useSites();
  const bulk = useRunBulk();
  const { canWrite, canManage } = useMe();
  const [adding, setAdding] = useState(false);

  if (isLoading || !hosts) return <div className="flex justify-center p-20"><Spinner /></div>;

  const onlineApt = hosts.filter((h) => h.online && hasApt(h));
  const sites = groupSites(hosts, siteConfig?.sites ?? []);
  // only the backups attached to a host are followed
  const groups = backups?.enabled ? backups.groups : undefined;
  const withBackups = !!backups?.enabled;

  return (
    <>
      <PageHeader
        icon={LayoutDashboard}
        title="Tableau de bord"
        actions={
          <>
            {canWrite && (
              <Button icon={RefreshCw} loading={bulk.isPending} disabled={!onlineApt.length} onClick={() => bulk.mutate({ hostIds: onlineApt.map((h) => h.id), action: 'apt_update' })}>
                Tout vérifier
              </Button>
            )}
            {canManage && <Button icon={Plus} variant="primary" onClick={() => setAdding(true)}>Ajouter un hôte</Button>}
          </>
        }
      />

      {hosts.length === 0 ? (
        <div className="panel">
          <Empty icon={Server} title="Aucun hôte pour l'instant">
            Ajoute ton premier serveur ou LXC : une commande à copier, et l'agent remonte son état en quelques secondes.
            {canManage && <div className="mt-4"><Button icon={Plus} variant="primary" onClick={() => setAdding(true)}>Ajouter un hôte</Button></div>}
          </Empty>
        </div>
      ) : (
        <div className="space-y-4">
          <Kpis hosts={hosts} groups={groups} backups={withBackups} />
          <div className="grid items-start gap-4 min-[1100px]:grid-cols-[minmax(0,1fr)_400px]">
            <div className="flex min-w-0 flex-col gap-4">
              <SiteOverview sites={sites} groups={groups} backups={withBackups} />
              <SiteTimeline sites={sites} />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              {canWrite && <DashboardActions hosts={hosts} groups={groups} />}
              <DashboardTodo hosts={hosts} groups={groups} jobs={jobs} jobsAt={jobsAt} />
            </div>
          </div>
        </div>
      )}
      <AddHostModal open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
