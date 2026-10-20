import { useState } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Cloud, Container, DatabaseBackup, History, House, Link2, Package, PackageX, Pencil, Play, Plus, Search, Trash2, Unlink, X } from 'lucide-react';
import { SnapshotsModal } from './BackupSnapshots';
import { BackupJobEditModal, CachedJobModal, type JobTab } from './ManagedBackups';
import { NextcloudPluginModal } from './NextcloudPlugin';
import { ApiError, api, type BackupGroup, type BackupJob, type BackupOrphan, type Host } from '../lib/api';
import { useMe } from '../lib/auth';
import { type DayVerify, type OffsiteDay, backupClient, backupKind, backupStateMeta, formatBytes, groupLabel, guestLabel, offsiteLane, timeline } from '../lib/backups';
import { DetailPill } from './OffsiteCopy';
import { dateTime, timeAgo } from '../lib/format';
import { keys, useBackups } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Badge, Button, ConfirmModal, IconGroup, Modal, Panel } from './ui';

const DAY = 24 * 3600_000;

// One square per day over the last 30 days: snapshots that day (green when all verified, orange when one
// is not verified yet, red when a verification failed), or a missing day for a backup expected at least
// daily (days before its oldest known snapshot are left neutral).
// Full width of its container by default; className sets another width (table cell).
const verifyColor: Record<DayVerify, string> = { ok: 'bg-emerald-500', unverified: 'bg-amber-500', failed: 'bg-red-500' };
const verifyLabel: Record<DayVerify, string> = { ok: ', vérifié', unverified: ', non vérifié', failed: ', vérification en échec' };

// Thin lane of the copy to the secondary PBS under it (copy: a secondary is configured): blue when the
// day reached the secondary and is verified there (pale blue: not verified yet, red: verification failed),
// orange outline when a copy is missing, red when the run bringing it failed, dashed when the copy is not
// enabled; none for a backup that cannot be copied.
const offsiteColor: Record<OffsiteDay, string> = {
  copied: 'bg-sky-400',
  unverified: 'bg-sky-400/40',
  verify_failed: 'bg-red-500',
  missing: 'border border-amber-400',
  failed: 'bg-red-500',
  running: 'animate-pulse bg-sky-300',
  none: 'bg-raised',
};
const offsiteDayLabel: Record<OffsiteDay, string> = {
  copied: 'copiée, vérifiée',
  unverified: 'copiée, non vérifiée',
  verify_failed: 'copiée, vérification en échec',
  missing: 'copie manquante',
  failed: 'copie manquante (échec)',
  running: 'copie en cours',
  none: 'pas de copie',
};

export function BackupTimeline({ group, days = 30, className, copy }: { group: Pick<BackupGroup, 'times' | 'interval' | 'offsite' | 'placeholder'> & { source?: BackupGroup['source'] }; days?: number; className?: string; copy?: boolean }) {
  // Home Assistant does not verify its backups
  const verified = group.source !== 'haos';
  const cells = timeline(group.times, days, undefined, verified);
  const daily = !!group.interval && group.interval <= 1.2 * DAY;
  const oldest = group.times?.[0]?.t ?? Infinity;
  const today = cells[cells.length - 1].day;
  const lane = copy ? offsiteLane(group, days) : null;
  const day = (t: number) => new Date(t).toLocaleDateString('fr-FR');
  return (
    // cells share the width (no minimum: 30 of them never overflow a narrow box)
    <div className={clsx('flex flex-col gap-[3px]', className ?? 'w-full')}>
      <div className="flex gap-[2px]" aria-label="Snapshots des 30 derniers jours">
        {cells.map((c) => {
          const missing = daily && !c.count && c.day + DAY > oldest && c.day < today;
          return (
            <span
              key={c.day}
              title={`${day(c.day)} : ${c.count ? `${c.count} snapshot${c.count > 1 ? 's' : ''}${verified ? verifyLabel[c.verify] : ''}` : 'aucun snapshot'}`}
              className={clsx('h-3.5 min-w-0 flex-1 rounded-[2px]', c.count ? verifyColor[c.verify] : missing ? 'bg-red-500/70' : 'bg-raised')}
            />
          );
        })}
      </div>
      {lane && (
        <div className="flex gap-[2px]" aria-label={lane.off ? 'Copie déportée non activée' : 'Copies sur le PBS de secours, 30 derniers jours'}>
          {lane.cells.map((c) =>
            lane.off ? (
              <span key={c.day} title="Copie déportée non activée" className="h-1.5 min-w-0 flex-1 border-b border-dashed border-zinc-600" />
            ) : (
              <span key={c.day} title={`${day(c.day)} : ${offsiteDayLabel[c.state]}`} className={clsx('h-1.5 min-w-0 flex-1 rounded-[2px]', offsiteColor[c.state])} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

// Choose the backups of a host among the orphans (and the ones it already has).
function AttachModal({ host, groups, orphans, open, onClose }: { host: Host; groups: BackupGroup[]; orphans: BackupOrphan[]; open: boolean; onClose: () => void }) {
  const toast = useToast();
  // groups attached by Proxmox VE are not chosen here
  const mine = groups.filter((g) => g.hostId === host.id && !g.source);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = selected ?? new Set(mine.map((g) => g.id));
  const close = () => {
    setSelected(null);
    setQ('');
    onClose();
  };
  const candidates = [
    ...mine.map((g) => ({ id: g.id, store: g.store, ns: g.ns, type: g.type, backupId: g.backupId, comment: g.comment ?? null, lastBackup: g.lastBackup, count: g.count, gone: !!g.gone })),
    ...orphans.filter((o) => !o.gone),
  ];
  const needle = q.toLowerCase();
  const list = candidates.filter((c) => !needle || `${c.store}/${c.ns}/${c.type}/${c.backupId} ${c.comment ?? ''}`.toLowerCase().includes(needle));
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const save = async () => {
    setBusy(true);
    try {
      await api.setHostBackups(host.id, [...chosen]);
      toast.success(`${chosen.size} sauvegarde${chosen.size > 1 ? 's' : ''} rattachée${chosen.size > 1 ? 's' : ''} à ${host.name}`);
      close();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={close}
      wide
      title={`Sauvegardes de ${host.name}`}
      footer={
        <>
          <Button onClick={close}>Annuler</Button>
          <Button variant="primary" icon={Link2} loading={busy} onClick={save}>Enregistrer</Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">
        Coche les sauvegardes du PBS qui appartiennent à cet hôte : elles seront suivies (retard, vérification, alertes). La liste montre ses sauvegardes et
        celles qui ne sont rattachées à aucun hôte.
      </p>
      <label className="relative mb-3 block">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted" />
        <input className="input pl-8" placeholder="Datastore, namespace, nom…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </label>
      <div className="max-h-[50vh] divide-y divide-line overflow-auto rounded-md border border-line">
        {list.length === 0 ? (
          <p className="p-4 text-sm text-muted">Aucune sauvegarde disponible.</p>
        ) : (
          list.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-raised/40">
              <input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={chosen.has(c.id)} onChange={() => toggle(c.id)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-zinc-100">{groupLabel({ type: c.type, backupId: c.backupId, comment: c.comment ?? undefined })}</span>
                <span className="block text-xs text-muted">{c.store}{c.ns ? ` › ${c.ns}` : ''} · {c.count} snapshot{c.count > 1 ? 's' : ''}</span>
              </span>
              <span className="shrink-0 text-xs text-zinc-400" title={dateTime(c.lastBackup)}>{timeAgo(c.lastBackup)}</span>
            </label>
          ))
        )}
      </div>
    </Modal>
  );
}

// Small icon of the PBS client of the host: installed (APT), image (Docker), none; on HAOS, the Home
// Assistant backups read by the agent of the add-on.
function ClientIcon({ host }: { host: Host }) {
  const c = backupClient(host.capabilities);
  const ha = host.capabilities.includes('ha_backups');
  if (!c.supported && !ha) return null;
  const [Icon, tone, title] = !c.supported
    ? [House, 'text-sky-400', 'Sauvegardes de Home Assistant lues par l’agent (application Home Assistant OS)']
    : c.mode === 'native'
      ? [Package, 'text-emerald-400', 'Client PBS installé (APT)']
      : c.mode === 'docker'
        ? [Container, 'text-sky-400', 'Client PBS en conteneur (image Docker)']
        : c.mode === 'cli'
          ? [Package, 'text-emerald-400', 'Client PBS Windows (proxmoxbackup-directory)']
          : [PackageX, 'text-zinc-500', 'Client PBS absent : sauvegardes de répertoires impossibles (options de l’hôte › Sauvegardes pour l’installer)'];
  return (
    <span title={title} className="ml-2 inline-flex align-middle">
      <Icon className={`h-4 w-4 ${tone}`} aria-label={title} />
    </span>
  );
}

// Backups of the host page: the PBS groups attached to it, with their last 30 days.
// onStarted: a backup run here shows its job in the console of the page (a toast otherwise)
export function HostBackups({ host, onStarted }: { host: Host; onStarted?: (jobId: string) => void }) {
  const { data } = useBackups();
  const { canManage, canWrite } = useMe();
  const toast = useToast();
  const qc = useQueryClient();
  const [attaching, setAttaching] = useState(false);
  const [nextcloud, setNextcloud] = useState(false);
  // job id, or 'new'
  const [editing, setEditing] = useState<string | null>(null);
  const [editTab, setEditTab] = useState<JobTab | undefined>();
  const edit = (jobId: string, tab?: JobTab) => {
    setEditTab(tab);
    setEditing(jobId);
  };
  const [running, setRunning] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [removing, setRemoving] = useState<BackupGroup | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [cacheBusy, setCacheBusy] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<BackupJob | null>(null);
  // agent able to run backups of its own (not the HAOS add-on)
  const agentBackups = backupClient(host.capabilities).supported;
  // what a new job needs: the PBS client and the token of the host
  const { data: jobs } = useQuery({ queryKey: ['backup-jobs', host.id], queryFn: () => api.hostBackupJobs(host.id), enabled: !!data?.connected && canManage && agentBackups });
  if (!data) return null;
  const mine = data.groups.filter((g) => g.hostId === host.id).sort((a, b) => a.backupId.localeCompare(b.backupId));
  // without PBS: the card only for the backups of Home Assistant of the host
  if (!data.connected && !mine.length) return null;

  // backup job of the hub writing this group, run now
  const run = async (g: BackupGroup) => {
    if (!g.managed) return;
    setRunning(g.id);
    try {
      const job = await api.runBackupJob(g.managed.jobId);
      if (onStarted) onStarted(job.id);
      else toast.success(`Sauvegarde ${g.managed.name} lancée`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRunning(null);
    }
  };

  // backup job writing this group, deleted (its snapshots stay on the PBS)
  const remove = async () => {
    if (!removing?.managed) return;
    setDeleting(true);
    try {
      await api.deleteBackupJob(removing.managed.jobId);
      qc.invalidateQueries({ queryKey: ['backup-jobs', host.id] });
      qc.invalidateQueries({ queryKey: keys.backups });
      setRemoving(null);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  // jobs kept when the main PBS was disconnected: restored as they were (direct), through their form when the
  // hub refuses them as they are (edit), or dropped (only the cache: direct too)
  const restore = async (j: BackupJob) => {
    setCacheBusy(j.id);
    try {
      await api.restoreCachedJob(host.id, j.id);
      toast.success(`Sauvegarde ${j.name} restaurée`);
      qc.invalidateQueries({ queryKey: ['backup-jobs', host.id] });
      qc.invalidateQueries({ queryKey: keys.backups });
    } catch (err) {
      toast.error((err as Error).message);
      if (err instanceof ApiError && err.data.edit) setRestoring(j);
    } finally {
      setCacheBusy(null);
    }
  };
  const drop = async (j: BackupJob) => {
    setCacheBusy(j.id);
    try {
      await api.dropCachedJob(host.id, j.id);
      qc.invalidateQueries({ queryKey: ['backup-jobs', host.id] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCacheBusy(null);
    }
  };

  // Nextcloud AIO plugin: hub with BACKUP_NEXTCLOUD_AIO, instance found on the host (or plugin already set)
  const nextcloudShown = !!jobs?.nextcloudPlugin && (jobs.nextcloud || !!jobs.nextcloudSettings || !!jobs.nextcloudPrevious);
  // the client and the token are set in the options of the host (Sauvegardes)
  const addBlocked = !jobs ? 'Chargement…' : !jobs.mode ? (jobs.windows ? "Renseigner d'abord le chemin du client PBS (options de l’hôte › Sauvegardes)" : "Installer d'abord le client PBS (options de l’hôte › Sauvegardes)") : !jobs.credential ? "Renseigner d'abord l'accès au PBS (options de l’hôte › Sauvegardes)" : null;

  const detach = async (g: BackupGroup) => {
    try {
      await api.updateBackup(g.id, { hostId: null });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Panel
      title={
        <>
          Sauvegardes{mine.length > 0 && <span className="text-muted"> ({mine.length})</span>}
          <ClientIcon host={host} />
          {host.pve && <span className="ml-2 text-xs font-normal text-muted" title={`Guest ${host.pve.name} du cluster ${host.pve.cluster}, trouvé par son adresse MAC`}>{guestLabel(host.pve)} · {host.pve.node}</span>}
        </>
      }
      icon={DatabaseBackup}
      actions={
        <>
          {/* agent unable to run backups of its own (HAOS add-on): neither Agent nor Ajouter */}
          {canManage && agentBackups && (
            <>
              {nextcloudShown && (
                <Button
                  size="sm"
                  icon={Cloud}
                  disabled={!!addBlocked}
                  onClick={() => setNextcloud(true)}
                  className={clsx(jobs?.nextcloudPrevious && 'border-dashed !border-amber-500/60 !text-amber-200')}
                  title={addBlocked ?? (jobs?.nextcloudPrevious ? 'Plugin Nextcloud AIO : configuration d’avant la déconnexion du PBS, à restaurer' : 'Plugin Nextcloud AIO : base, configuration et données de chaque utilisateur')}
                >
                  Nextcloud
                </Button>
              )}
              <Button size="sm" icon={Plus} disabled={!!addBlocked} onClick={() => edit('new')} title={addBlocked ?? "Nouvelle sauvegarde lancée par l'agent (répertoires ou base de données)"}>
                Ajouter
              </Button>
            </>
          )}
          {canManage && <Button size="sm" icon={Link2} onClick={() => setAttaching(true)}>Rattacher</Button>}
        </>
      }
    >
      {host.pve && !host.pve.covered && (
        <p className="mb-3 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {guestLabel(host.pve)} n'est couvert par aucun job de sauvegarde actif du cluster {host.pve.cluster}.
        </p>
      )}
      {canManage && jobs?.cache && (
        <ul className="mb-3 space-y-1.5" title={`Mises de côté à la déconnexion du PBS (${dateTime(jobs.cache.at)})`}>
          {jobs.cache.jobs.map((j) => (
            <li key={j.id} className="flex items-center gap-2 rounded-md border border-dashed border-amber-500/50 bg-amber-500/[0.06] px-3 py-2">
              <span className="min-w-0 truncate font-medium text-amber-100">{j.name}</span>
              <Badge tone="warn">à restaurer</Badge>
              <span className="min-w-0 truncate text-xs text-muted">
                {j.store} › Hosts › {j.backupId} · {j.connectEveryDays ? `à la connexion, au plus tous les ${j.connectEveryDays} j` : j.schedule}
                {!j.enabled && ' · désactivée'}
              </span>
              <IconGroup
                className="ml-auto shrink-0"
                actions={[
                  { icon: Check, title: jobs.mode ? 'Valider : recréer cette sauvegarde (et le jeton de l’hôte)' : "Valider : installer d'abord le client PBS (options de l’hôte › Sauvegarde)", disabled: !jobs.mode, loading: cacheBusy === j.id, onClick: () => void restore(j) },
                  { icon: X, title: 'Annuler : oublier cette sauvegarde', danger: true, disabled: cacheBusy === j.id, onClick: () => void drop(j) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      {mine.length === 0 ? (
        <p className="text-sm text-muted">
          Aucune sauvegarde rattachée.{canManage && ' « Rattacher » liste les sauvegardes du PBS qui ne sont rattachées à aucun hôte.'}
        </p>
      ) : (
        <ul className="@container -my-2 divide-y divide-line">
          {mine.map((g) => {
            const meta = backupStateMeta[g.state];
            return (
              // name, badges and actions on top; below, the details and the timeline side by side (half each)
              // when the card is wide enough (container query), the timeline below the details otherwise
              <li key={g.id} className="space-y-1.5 py-3">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate font-medium text-zinc-100">{groupLabel(g)}</span>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  <span title={backupKind(g).title}>
                    <Badge tone="neutral">{backupKind(g).label}</Badge>
                  </span>
                  {g.managed && !g.managed.enabled && <Badge tone="neutral">désactivée</Badge>}
                  {/* detail of the backup and of its copy (schedule, delay before an alert...) */}
                  <DetailPill g={g} remote={data.offsite} onStarted={onStarted} />
                  {/* run, edit and delete: backups of the agent only */}
                  {/* before the block: the blocks of the rows stay aligned on the right */}
                  {canManage && !g.source && (
                    <Button size="sm" variant="ghost" icon={Unlink} className="ml-auto" title="Détacher : la sauvegarde n'est plus suivie" onClick={() => detach(g)} />
                  )}
                  <IconGroup
                    className={clsx('shrink-0', !(canManage && !g.source) && 'ml-auto')}
                    actions={[
                      {
                        icon: Play,
                        title: !g.managed ? "Lancer : seulement les sauvegardes de l'agent" : !host.online ? 'Lancer : agent hors ligne' : 'Lancer la sauvegarde maintenant',
                        disabled: !canWrite || !g.managed || !host.online,
                        loading: running === g.id,
                        onClick: () => run(g),
                      },
                      {
                        icon: Pencil,
                        title: g.managed?.plugin ? 'Générée par le plugin Nextcloud AIO : la modifier depuis le plugin' : g.managed ? 'Modifier la sauvegarde' : "Modifier : seulement les sauvegardes de l'agent",
                        disabled: !canManage || !g.managed || !!g.managed.plugin,
                        onClick: () => edit(g.managed!.jobId),
                      },
                      { icon: History, title: 'Historique des snapshots', onClick: () => setHistory(g.id) },
                      {
                        icon: Trash2,
                        title: g.managed?.plugin ? 'Générée par le plugin Nextcloud AIO : la retirer depuis le plugin' : g.managed ? 'Supprimer la sauvegarde' : "Supprimer : seulement les sauvegardes de l'agent",
                        disabled: !canManage || !g.managed || !!g.managed.plugin,
                        danger: true,
                        onClick: () => setRemoving(g),
                      },
                    ]}
                  />
                </div>
                <div className="flex flex-col gap-2 @2xl:flex-row @2xl:items-center @2xl:gap-6">
                  {/* one line: the schedule and the delay before an alert are in the detail */}
                  <div className="min-w-0 @2xl:flex-1 @2xl:basis-0">
                    <div className="truncate text-xs text-muted">
                      {g.store}{g.ns ? ` › ${g.ns}` : ''} · {g.lastBackup ? timeAgo(g.lastBackup) : 'jamais sauvegardée'} · {formatBytes(g.size)}
                      {g.verify === 'ok' && <span className="text-emerald-400"> · vérifiée</span>}
                      {g.verify === 'failed' && <span className="text-red-400"> · vérification en échec</span>}
                    </div>
                    {g.ha?.failedAt && g.ha.failedAt > g.lastBackup && (
                      <div className="text-xs text-red-400" title={dateTime(g.ha.failedAt)}>Sauvegarde automatique non écrite sur cette destination {timeAgo(g.ha.failedAt)}</div>
                    )}
                    {g.ha?.error && <div className="text-xs text-amber-400">Destination illisible : {g.ha.error}</div>}
                    {g.pve?.lastTask && !g.pve.lastTask.ok && (
                      <div className="text-xs text-red-400" title={dateTime(g.pve.lastTask.at)}>Dernière tâche en échec {timeAgo(g.pve.lastTask.at)} : {g.pve.lastTask.error}</div>
                    )}
                  </div>
                  <BackupTimeline group={g} copy={!!data.offsite} className="w-full @2xl:flex-1 @2xl:basis-0" />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">
        <Link to={`/backups?host=${host.id}`} className="text-emerald-400 hover:underline">Voir dans la page Sauvegardes</Link>
      </p>
      {canManage && <AttachModal host={host} groups={data.groups} orphans={data.orphans} open={attaching} onClose={() => setAttaching(false)} />}
      {canManage && <BackupJobEditModal host={host} jobId={editing} tab={editTab} onClose={() => setEditing(null)} />}
      {canManage && restoring && <CachedJobModal host={host} job={restoring} onClose={() => setRestoring(null)} />}
      {canManage && nextcloudShown && <NextcloudPluginModal host={host} open={nextcloud} onClose={() => setNextcloud(false)} />}
      {(() => {
        // looked up at each render: follows the refreshes of the list
        const g = history && mine.find((x) => x.id === history);
        return g ? <SnapshotsModal group={g} open onClose={() => setHistory(null)} /> : null;
      })()}
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={remove} title="Supprimer la sauvegarde" confirmLabel="Supprimer" danger loading={deleting}>
        L'agent ne lancera plus <b>{removing?.managed?.name}</b>. Les snapshots déjà faits restent sur le PBS (le groupe devient orphelin).
      </ConfirmModal>
    </Panel>
  );
}
