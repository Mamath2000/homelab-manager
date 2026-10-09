import { useState } from 'react';
import { Link } from 'react-router';
import { CircleArrowUp, Container, History, LayoutDashboard, PackageCheck, Plus, RefreshCw, RotateCw, Server, ShieldAlert, ShieldX } from 'lucide-react';
import { AddHostModal } from '../components/AddHostModal';
import { AgentBadge, ReinstallBadge, UpdateAgentButton } from '../components/Agent';
import { ImageUpdateBadge } from '../components/Docker';
import { JobStatusIcon } from '../components/JobConsole';
import { RebootStatus } from '../components/Reboot';
import { ItemCard, StatusSection } from '../components/StatusSection';
import { Badge, Button, Empty, PageHeader, Spinner, Tag } from '../components/ui';
import { jobTitle, timeAgo } from '../lib/format';
import { useHosts, useJobs, useRunBulk } from '../lib/queries';
import { allStacks, connection, connectionMeta, listsStale, needsReinstall, osLabel, stackMeta, stackPath, updateMeta, updateState } from '../lib/status';
import type { Host } from '../lib/api';
import { useMe } from '../lib/auth';

const connOrder = { offline: 0, pending: 1, online: 2 };
const updOrder = { reboot: 0, security: 1, updates: 2, unknown: 3, uptodate: 4 };

function HostTags({ h }: { h: Host }) {
  return (
    <>
      {h.group && <Tag>{h.group}</Tag>}
      {osLabel(h) && <Tag>{osLabel(h)}</Tag>}
      {h.info?.virt && h.info.virt !== 'none' && <Tag>{h.info.virt}</Tag>}
    </>
  );
}

export function Dashboard() {
  const { data: hosts, isLoading } = useHosts();
  const { data: jobs, dataUpdatedAt: jobsAt } = useJobs();
  const bulk = useRunBulk();
  const { canWrite, canManage } = useMe();
  const [adding, setAdding] = useState(false);

  if (isLoading || !hosts) return <div className="flex justify-center p-20"><Spinner /></div>;

  const count = <T extends string>(fn: (h: Host) => T, v: T) => hosts.filter((h) => fn(h) === v).length;
  const online = hosts.filter((h) => h.online);
  const outdated = hosts.filter((h) => h.agentOutdated);
  const reinstall = hosts.filter(needsReinstall);
  const needsUpdate = hosts
    .filter((h) => (h.aptSummary?.upgradable ?? 0) > 0 || h.aptSummary?.rebootRequired)
    .sort((a, b) => updOrder[updateState(a)] - updOrder[updateState(b)] || (b.aptSummary?.upgradable ?? 0) - (a.aptSummary?.upgradable ?? 0));
  const stacks = allStacks(hosts);
  const stacksToHandle = stacks
    .filter((s) => s.problems.length > 0 || s.updates > 0)
    .sort((a, b) => b.problems.length - a.problems.length || b.updates - a.updates);
  const sortedHosts = [...hosts].sort((a, b) => connOrder[connection(a)] - connOrder[connection(b)] || a.name.localeCompare(b.name));

  const dayAgo = jobsAt - 24 * 3600 * 1000;
  const recentJobs = (jobs ?? []).filter((j) => Date.parse(j.createdAt) > dayAgo);

  return (
    <>
      <PageHeader
        icon={LayoutDashboard}
        title="Tableau de bord"
        actions={
          <>
            {canWrite && (
              <Button icon={RefreshCw} loading={bulk.isPending} disabled={!online.length} onClick={() => bulk.mutate({ hostIds: online.map((h) => h.id), action: 'apt_update' })}>
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
        <div className="space-y-5">
          <StatusSection
            icon={Server}
            title="Hôtes"
            to="/hosts"
            stats={[
              { label: 'En ligne', value: count(connection, 'online'), tone: 'ok' },
              { label: 'Hors ligne', value: count(connection, 'offline'), tone: 'bad' },
              { label: 'En attente', value: count(connection, 'pending'), tone: 'unknown' },
              { label: 'Agent à mettre à jour', value: outdated.length, tone: 'warn', ringless: true },
            ]}
            cardsTitle="Tous les hôtes"
            cardsIcon={Server}
          >
            {sortedHosts.map((h) => {
              const c = connection(h);
              return (
                <ItemCard key={h.id} to={`/hosts/${h.id}`} icon={Server} tone={connectionMeta[c].tone} title={h.name}
                  right={c !== 'online' && <Badge tone={connectionMeta[c].tone}>{connectionMeta[c].label}</Badge>}>
                  {needsReinstall(h) && <ReinstallBadge />}
                  {h.agentOutdated && <AgentBadge />}
                  <HostTags h={h} />
                </ItemCard>
              );
            })}
          </StatusSection>

          <StatusSection
            icon={PackageCheck}
            title="Mises à jour"
            to="/updates"
            stats={[
              { label: 'À jour', value: count(updateState, 'uptodate'), tone: 'ok' },
              { label: 'Mises à jour', value: count(updateState, 'updates'), tone: 'warn' },
              { label: 'Sécurité', value: count(updateState, 'security'), tone: 'bad' },
              { label: 'Reboot requis', value: count(updateState, 'reboot'), tone: 'info' },
              { label: 'Inconnu', value: count(updateState, 'unknown'), tone: 'unknown' },

              { label: 'Reboot après MAJ', value: hosts.filter((h) => !h.aptSummary?.rebootRequired && h.aptSummary?.rebootPending).length, tone: 'warn', ringless: true },
              { label: 'À nettoyer', value: hosts.filter((h) => (h.aptSummary?.autoremovable ?? 0) > 0).length, tone: 'neutral', ringless: true },
            ]}
            cardsTitle="À traiter"
            cardsIcon={ShieldAlert}
            empty={needsUpdate.length === 0 && outdated.length === 0 && reinstall.length === 0 ? <p className="py-6 text-sm text-muted">Tout est à jour. 🎉</p> : undefined}
          >
            {reinstall.length > 0 && (
              <div className="flex min-w-0 flex-col gap-2.5 rounded-md border border-red-500/40 bg-red-500/5 p-3.5">
                <span className="flex items-center gap-2.5 text-sm font-medium text-red-200">
                  <ShieldX className="h-4 w-4 shrink-0 text-red-400" />
                  Agents à réinstaller ({reinstall.length})
                </span>
                <p className="text-xs text-muted">Ancien jeton en clair, refusé par le hub : nouvelle commande d'installation depuis la fiche de chaque hôte.</p>
                <div className="flex flex-wrap gap-1.5">
                  {reinstall.map((h) => (
                    <Link key={h.id} to={`/hosts/${h.id}`} className="hover:opacity-80"><Tag>{h.name}</Tag></Link>
                  ))}
                </div>
              </div>
            )}
            {outdated.length > 0 && (
              <div className="flex min-w-0 flex-col gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-3.5">
                <span className="flex items-center gap-2.5 text-sm font-medium text-amber-200">
                  <CircleArrowUp className="h-4 w-4 shrink-0 text-amber-400" />
                  Agents à mettre à jour ({outdated.length})
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {outdated.slice(0, 6).map((h) => <Tag key={h.id}>{h.name}</Tag>)}
                  {outdated.length > 6 && <span className="self-center text-xs text-muted">+{outdated.length - 6}</span>}
                </div>
                <div>
                  <UpdateAgentButton hosts={outdated} label="Mettre à jour" />
                </div>
              </div>
            )}
            {needsUpdate.map((h) => {
              const s = h.aptSummary!;
              return (
                <ItemCard key={h.id} to={`/hosts/${h.id}`} icon={PackageCheck} tone={updateMeta[updateState(h)].tone} title={h.name}
                  right={(s.rebootRequired || !!s.rebootPending) && <RotateCw className={`h-4 w-4 ${s.rebootRequired ? 'text-red-400' : 'text-amber-400'}`} aria-label="Redémarrage" />}>
                  {s.security > 0 && <Badge tone="bad">{s.security} sécu</Badge>}
                  {s.upgradable > 0 && <Badge tone="warn">{s.upgradable} paquet{s.upgradable > 1 ? 's' : ''}</Badge>}
                  <RebootStatus summary={s} compact />
                  {listsStale(h) && <Badge tone="unknown">listes périmées</Badge>}
                </ItemCard>
              );
            })}
          </StatusSection>

          {hosts.some((h) => h.docker) && (
            <StatusSection
              icon={Container}
              title="Docker"
              to="/docker"
              stats={[
                { label: 'En marche', value: stacks.filter((s) => s.status === 'running').length, tone: 'ok' },
                { label: 'Partielles', value: stacks.filter((s) => s.status === 'partial').length, tone: 'warn' },
                { label: 'Arrêtées', value: stacks.filter((s) => s.status === 'stopped' || s.status === 'down').length, tone: 'neutral' },
                { label: 'À mettre à jour', value: stacks.filter((s) => s.updates > 0).length, tone: 'warn', ringless: true },
                { label: 'Problèmes', value: stacks.filter((s) => s.problems.length > 0).length, tone: 'bad', ringless: true },
              ]}
              cardsTitle="Stacks à traiter"
              cardsIcon={Container}
              empty={stacksToHandle.length === 0 ? <p className="py-6 text-sm text-muted">Toutes les stacks tournent et sont à jour.</p> : undefined}
            >
              {stacksToHandle.slice(0, 12).map((s) => (
                <ItemCard key={`${s.host.id}/${s.name}`} to={stackPath(s.host.id, s.name)} icon={Container}
                  tone={s.problems.length ? 'bad' : 'warn'} title={s.name}
                  right={s.status !== 'running' && <Badge tone={stackMeta[s.status].tone}>{stackMeta[s.status].label}</Badge>}>
                  <Tag>{s.host.name}</Tag>
                  {s.updates > 0 && <ImageUpdateBadge update={s.update} count={s.updates} />}
                  {s.problems.map((p) => <Badge key={p} tone="bad">{p}</Badge>)}
                </ItemCard>
              ))}
            </StatusSection>
          )}

          <StatusSection
            icon={History}
            title="Activité"
            to="/activity"
            stats={[
              { label: 'Réussies', value: recentJobs.filter((j) => j.status === 'success').length, tone: 'ok' },
              { label: 'En cours', value: recentJobs.filter((j) => j.status === 'running').length, tone: 'info' },
              { label: 'Échouées', value: recentJobs.filter((j) => j.status === 'failed').length, tone: 'bad' },
            ]}
            cardsTitle="Dernières tâches · compteurs sur 24 h"
            cardsIcon={History}
            empty={!jobs?.length ? <p className="py-6 text-sm text-muted">Aucune tâche pour le moment.</p> : undefined}
          >
            {(jobs ?? []).slice(0, 8).map((j) => (
              <ItemCard key={j.id} to={`/jobs/${j.id}`} icon={History}
                tone={j.status === 'success' ? 'ok' : j.status === 'failed' ? 'bad' : 'info'}
                title={jobTitle(j)} right={<JobStatusIcon status={j.status} />}>
                <Tag>{j.hostName}</Tag>
                <span className="self-center text-xs text-muted">{timeAgo(j.createdAt)}</span>
              </ItemCard>
            ))}
          </StatusSection>
        </div>
      )}
      <AddHostModal open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
