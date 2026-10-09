import { useState } from 'react';
import { History, LayoutDashboard, PackageCheck, Plus, RefreshCw, RotateCw, Server, ShieldAlert } from 'lucide-react';
import { AddHostModal } from '../components/AddHostModal';
import { JobStatusIcon } from '../components/JobConsole';
import { ItemCard, StatusSection } from '../components/StatusSection';
import { Badge, Button, Empty, PageHeader, Spinner, Tag } from '../components/ui';
import { actionLabel, timeAgo } from '../lib/format';
import { useHosts, useJobs, useRunBulk } from '../lib/queries';
import { connection, connectionMeta, listsStale, osLabel, updateMeta, updateState } from '../lib/status';
import type { Host } from '../lib/api';

const connOrder = { offline: 0, pending: 1, online: 2 };
const updOrder = { security: 0, updates: 1, unknown: 2, uptodate: 3 };

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
  const { data: jobs } = useJobs();
  const bulk = useRunBulk();
  const [adding, setAdding] = useState(false);

  if (isLoading || !hosts) return <div className="flex justify-center p-20"><Spinner /></div>;

  const count = <T extends string>(fn: (h: Host) => T, v: T) => hosts.filter((h) => fn(h) === v).length;
  const online = hosts.filter((h) => h.online);
  const needsUpdate = hosts
    .filter((h) => (h.aptSummary?.upgradable ?? 0) > 0 || h.aptSummary?.rebootRequired)
    .sort((a, b) => updOrder[updateState(a)] - updOrder[updateState(b)] || (b.aptSummary?.upgradable ?? 0) - (a.aptSummary?.upgradable ?? 0));
  const sortedHosts = [...hosts].sort((a, b) => connOrder[connection(a)] - connOrder[connection(b)] || a.name.localeCompare(b.name));

  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const recentJobs = (jobs ?? []).filter((j) => Date.parse(j.createdAt) > dayAgo);

  return (
    <>
      <PageHeader
        icon={LayoutDashboard}
        title="Tableau de bord"
        actions={
          <>
            <Button icon={RefreshCw} loading={bulk.isPending} disabled={!online.length} onClick={() => bulk.mutate({ hostIds: online.map((h) => h.id), action: 'apt_update' })}>
              Tout vérifier
            </Button>
            <Button icon={Plus} variant="primary" onClick={() => setAdding(true)}>Ajouter un hôte</Button>
          </>
        }
      />

      {hosts.length === 0 ? (
        <div className="panel">
          <Empty icon={Server} title="Aucun hôte pour l'instant">
            Ajoute ton premier serveur ou LXC : une commande à copier, et l'agent remonte son état en quelques secondes.
            <div className="mt-4"><Button icon={Plus} variant="primary" onClick={() => setAdding(true)}>Ajouter un hôte</Button></div>
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
            ]}
            cardsTitle="Tous les hôtes"
            cardsIcon={Server}
          >
            {sortedHosts.map((h) => {
              const c = connection(h);
              return (
                <ItemCard key={h.id} to={`/hosts/${h.id}`} icon={Server} tone={connectionMeta[c].tone} title={h.name}
                  right={c !== 'online' && <Badge tone={connectionMeta[c].tone}>{connectionMeta[c].label}</Badge>}>
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
              { label: 'Inconnu', value: count(updateState, 'unknown'), tone: 'unknown' },
              { label: 'Reboot requis', value: hosts.filter((h) => h.aptSummary?.rebootRequired).length, tone: 'info', ringless: true },
            ]}
            cardsTitle="À traiter"
            cardsIcon={ShieldAlert}
            empty={needsUpdate.length === 0 ? <p className="py-6 text-sm text-muted">Tout est à jour. 🎉</p> : undefined}
          >
            {needsUpdate.map((h) => {
              const s = h.aptSummary!;
              return (
                <ItemCard key={h.id} to={`/hosts/${h.id}`} icon={PackageCheck} tone={updateMeta[updateState(h)].tone} title={h.name}
                  right={s.rebootRequired && <RotateCw className="h-4 w-4 text-sky-400" aria-label="Redémarrage requis" />}>
                  {s.security > 0 && <Badge tone="bad">{s.security} sécu</Badge>}
                  {s.upgradable > 0 && <Badge tone="warn">{s.upgradable} paquet{s.upgradable > 1 ? 's' : ''}</Badge>}
                  {s.rebootRequired && <Badge tone="info">reboot</Badge>}
                  {listsStale(h) && <Badge tone="unknown">listes périmées</Badge>}
                </ItemCard>
              );
            })}
          </StatusSection>

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
                title={actionLabel[j.action]} right={<JobStatusIcon status={j.status} />}>
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
