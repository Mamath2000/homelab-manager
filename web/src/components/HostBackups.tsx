import { useState } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, Cloud, Container, DatabaseBackup, History, House, Link2, Package, PackageX, Pencil, Play, Plus, Search, Trash2, Unlink } from 'lucide-react';
import { SnapshotsModal } from './BackupSnapshots';
import { BackupJobEditModal, ManagedBackupsModal } from './ManagedBackups';
import { NextcloudPluginModal } from './NextcloudPlugin';
import { api, type BackupGroup, type BackupOrphan, type Host } from '../lib/api';
import { useMe } from '../lib/auth';
import { type DayVerify, backupClient, backupKind, backupStateMeta, formatBytes, groupLabel, guestLabel, hoursLabel, databaseJobText, rhythmLabel, scheduleLabel, thresholdSourceLabel, timeline } from '../lib/backups';
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

export function BackupTimeline({ group, days = 30, className }: { group: Pick<BackupGroup, 'times' | 'interval'> & { source?: BackupGroup['source'] }; days?: number; className?: string }) {
  // Home Assistant does not verify its backups
  const verified = group.source !== 'haos';
  const cells = timeline(group.times, days, undefined, verified);
  const daily = !!group.interval && group.interval <= 1.2 * DAY;
  const oldest = group.times?.[0]?.t ?? Infinity;
  const today = cells[cells.length - 1].day;
  return (
    // cells share the width (no minimum: 30 of them never overflow a narrow box)
    <div className={clsx('flex gap-[2px]', className ?? 'w-full')} aria-label="Snapshots des 30 derniers jours">
      {cells.map((c) => {
        const missing = daily && !c.count && c.day + DAY > oldest && c.day < today;
        return (
          <span
            key={c.day}
            title={`${new Date(c.day).toLocaleDateString('fr-FR')} : ${c.count ? `${c.count} snapshot${c.count > 1 ? 's' : ''}${verified ? verifyLabel[c.verify] : ''}` : 'aucun snapshot'}`}
            className={clsx('h-3.5 min-w-0 flex-1 rounded-[2px]', c.count ? verifyColor[c.verify] : missing ? 'bg-red-500/70' : 'bg-raised')}
          />
        );
      })}
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
        : [PackageX, 'text-zinc-500', 'Client PBS absent : sauvegardes de répertoires impossibles (bouton Agent pour l’installer)'];
  return (
    <span title={title} className="ml-2 inline-flex align-middle">
      <Icon className={`h-4 w-4 ${tone}`} aria-label={title} />
    </span>
  );
}

// Backups of the host page: the PBS groups attached to it, with their last 30 days.
export function HostBackups({ host }: { host: Host }) {
  const { data } = useBackups();
  const { canManage, canWrite } = useMe();
  const toast = useToast();
  const qc = useQueryClient();
  const [attaching, setAttaching] = useState(false);
  const [agent, setAgent] = useState(false);
  const [nextcloud, setNextcloud] = useState(false);
  // job id, or 'new'
  const [editing, setEditing] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [removing, setRemoving] = useState<BackupGroup | null>(null);
  const [deleting, setDeleting] = useState(false);
  // agent able to run backups of its own (not the HAOS add-on)
  const agentBackups = backupClient(host.capabilities).supported;
  // what a new job needs: the PBS client and the token of the host
  const { data: jobs } = useQuery({ queryKey: ['backup-jobs', host.id], queryFn: () => api.hostBackupJobs(host.id), enabled: !!data?.enabled && canManage && agentBackups });
  if (!data?.enabled) return null;
  const mine = data.groups.filter((g) => g.hostId === host.id).sort((a, b) => a.backupId.localeCompare(b.backupId));

  // backup job of the hub writing this group, run now
  const run = async (g: BackupGroup) => {
    if (!g.managed) return;
    setRunning(g.id);
    try {
      await api.runBackupJob(g.managed.jobId);
      toast.success(`Sauvegarde ${g.managed.name} lancée`);
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

  // Nextcloud AIO plugin: hub with BACKUP_NEXTCLOUD_AIO, instance found on the host (or plugin already set)
  const nextcloudShown = !!jobs?.nextcloudPlugin && (jobs.nextcloud || !!jobs.nextcloudSettings);
  const addBlocked = !jobs ? 'Chargement…' : !jobs.mode ? "Installer d'abord le client PBS (bouton Agent)" : !jobs.credential ? "Renseigner d'abord l'accès au PBS (bouton Agent)" : null;

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
              <Button size="sm" variant="ghost" icon={Bot} onClick={() => setAgent(true)} title="Agent de sauvegarde : client PBS et accès au PBS (jeton)">
                Agent
              </Button>
              {nextcloudShown && (
                <Button size="sm" variant="ghost" icon={Cloud} disabled={!!addBlocked} onClick={() => setNextcloud(true)} title={addBlocked ?? 'Plugin Nextcloud AIO : base, configuration et données de chaque utilisateur'}>
                  Nextcloud
                </Button>
              )}
              <Button size="sm" variant="ghost" icon={Plus} disabled={!!addBlocked} onClick={() => setEditing('new')} title={addBlocked ?? "Nouvelle sauvegarde lancée par l'agent (répertoires ou base de données)"}>
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
      {mine.length === 0 ? (
        <p className="text-sm text-muted">
          Aucune sauvegarde rattachée.{canManage && ' « Rattacher » liste les sauvegardes du PBS qui ne sont rattachées à aucun hôte.'}
        </p>
      ) : (
        <ul className="@container -my-2 divide-y divide-line">
          {mine.map((g) => {
            const meta = backupStateMeta[g.state];
            const rhythm = rhythmLabel(g.interval);
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
                        onClick: () => setEditing(g.managed!.jobId),
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
                  <div className="min-w-0 @2xl:flex-1 @2xl:basis-0">
                    <div className="text-xs text-muted">
                      {g.store}{g.ns ? ` › ${g.ns}` : ''} · {g.lastBackup ? timeAgo(g.lastBackup) : 'jamais sauvegardée'} · {formatBytes(g.size)}
                      {g.verify === 'ok' && <span className="text-emerald-400"> · vérifiée</span>}
                      {g.verify === 'failed' && <span className="text-red-400"> · vérification en échec</span>}
                    </div>
                    <div className="text-xs text-zinc-500">
                      {g.pve ? `Proxmox ${g.pve.cluster} · ${scheduleLabel(g)}` : g.managed || g.ha ? `${g.ha ? 'Home Assistant' : 'agent'} · ${scheduleLabel(g)}` : rhythm ? `rythme ${rhythm}` : 'rythme inconnu'} · {g.threshold === null ? 'aucun rythme connu : pas de retard signalé' : `en retard après ${hoursLabel(g.threshold)} (${thresholdSourceLabel[g.thresholdSource]})`}
                    </div>
                    {g.managed && databaseJobText(g.managed) && <div className="text-xs text-zinc-400">{databaseJobText(g.managed)}</div>}
                    {g.ha?.failedAt && g.ha.failedAt > g.lastBackup && (
                      <div className="text-xs text-red-400" title={dateTime(g.ha.failedAt)}>Sauvegarde automatique non écrite sur cette destination {timeAgo(g.ha.failedAt)}</div>
                    )}
                    {g.ha?.error && <div className="text-xs text-amber-400">Destination illisible : {g.ha.error}</div>}
                    {g.pve?.lastTask && !g.pve.lastTask.ok && (
                      <div className="text-xs text-red-400" title={dateTime(g.pve.lastTask.at)}>Dernière tâche en échec {timeAgo(g.pve.lastTask.at)} : {g.pve.lastTask.error}</div>
                    )}
                  </div>
                  <BackupTimeline group={g} className="w-full @2xl:flex-1 @2xl:basis-0" />
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
      <ManagedBackupsModal host={host} open={agent} onClose={() => setAgent(false)} />
      {canManage && <BackupJobEditModal host={host} jobId={editing} onClose={() => setEditing(null)} />}
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
