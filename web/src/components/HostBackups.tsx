import { useState } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { AlertTriangle, DatabaseBackup, FolderArchive, Link2, Play, Search, Unlink } from 'lucide-react';
import { ManagedBackupsModal } from './ManagedBackups';
import { api, type BackupGroup, type BackupOrphan, type Host } from '../lib/api';
import { useMe } from '../lib/auth';
import { backupStateMeta, formatBytes, groupLabel, guestLabel, hoursLabel, rhythmLabel, scheduleLabel, thresholdSourceLabel, timeline } from '../lib/backups';
import { dateTime, timeAgo } from '../lib/format';
import { useBackups } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Badge, Button, Modal, Panel } from './ui';

const DAY = 24 * 3600_000;

// One square per day over the last 30 days: a snapshot that day, or a missing day for a backup
// expected at least daily (days before its oldest known snapshot are left neutral).
// Full width of its container by default; className sets another width (table cell).
export function BackupTimeline({ group, days = 30, className }: { group: Pick<BackupGroup, 'times' | 'interval'>; days?: number; className?: string }) {
  const cells = timeline(group.times, days);
  const daily = !!group.interval && group.interval <= 1.2 * DAY;
  const oldest = group.times?.[0] ?? Infinity;
  const today = cells[cells.length - 1].day;
  return (
    <div className={clsx('flex gap-[3px]', className ?? 'w-full')} aria-label="Snapshots des 30 derniers jours">
      {cells.map((c) => {
        const missing = daily && !c.count && c.day + DAY > oldest && c.day < today;
        return (
          <span
            key={c.day}
            title={`${new Date(c.day).toLocaleDateString('fr-FR')} : ${c.count ? `${c.count} snapshot${c.count > 1 ? 's' : ''}` : 'aucun snapshot'}`}
            className={clsx('h-3.5 min-w-1.5 flex-1 rounded-[2px]', c.count ? 'bg-emerald-500' : missing ? 'bg-red-500/70' : 'bg-raised')}
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

// Backups of the host page: the PBS groups attached to it, with their last 30 days.
export function HostBackups({ host }: { host: Host }) {
  const { data } = useBackups();
  const { canManage, canWrite } = useMe();
  const toast = useToast();
  const [attaching, setAttaching] = useState(false);
  const [directories, setDirectories] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
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
          {host.pve && <span className="ml-2 text-xs font-normal text-muted" title={`Guest ${host.pve.name} du cluster ${host.pve.cluster}, trouvé par son adresse MAC`}>{guestLabel(host.pve)} · {host.pve.node}</span>}
        </>
      }
      icon={DatabaseBackup}
      actions={
        <>
          <Button size="sm" variant="ghost" icon={FolderArchive} onClick={() => setDirectories(true)} title="Sauvegardes de répertoires lancées par l'agent de cet hôte">
            Répertoires
          </Button>
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
        <ul className="-my-2 divide-y divide-line">
          {mine.map((g) => {
            const meta = backupStateMeta[g.state];
            const rhythm = rhythmLabel(g.interval);
            return (
              <li key={g.id} className="space-y-2 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate font-medium text-zinc-100">{groupLabel(g)}</span>
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    {canWrite && g.managed && (
                      <Button size="sm" icon={Play} className="ml-auto" loading={running === g.id} disabled={!host.online} onClick={() => run(g)} title="Lancer la sauvegarde maintenant">
                        Lancer
                      </Button>
                    )}
                    {canManage && !g.source && (
                      <Button size="sm" variant="ghost" icon={Unlink} className="ml-auto" title="Détacher : la sauvegarde n'est plus suivie" onClick={() => detach(g)} />
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {g.store}{g.ns ? ` › ${g.ns}` : ''} · {g.lastBackup ? timeAgo(g.lastBackup) : 'jamais sauvegardée'} · {formatBytes(g.size)}
                    {g.verify === 'ok' && <span className="text-emerald-400"> · vérifiée</span>}
                    {g.verify === 'failed' && <span className="text-red-400"> · vérification en échec</span>}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {g.pve ? `Proxmox ${g.pve.cluster} · ${scheduleLabel(g)}` : g.managed ? `agent · ${scheduleLabel(g)}` : rhythm ? `rythme ${rhythm}` : 'rythme inconnu'} · en retard après {hoursLabel(g.threshold)} ({thresholdSourceLabel[g.thresholdSource]})
                  </div>
                  {g.pve?.lastTask && !g.pve.lastTask.ok && (
                    <div className="text-xs text-red-400" title={dateTime(g.pve.lastTask.at)}>Dernière tâche en échec {timeAgo(g.pve.lastTask.at)} : {g.pve.lastTask.error}</div>
                  )}
                </div>
                <BackupTimeline group={g} />
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">
        <Link to={`/backups?host=${host.id}`} className="text-emerald-400 hover:underline">Voir dans la page Sauvegardes</Link>
      </p>
      {canManage && <AttachModal host={host} groups={data.groups} orphans={data.orphans} open={attaching} onClose={() => setAttaching(false)} />}
      <ManagedBackupsModal host={host} open={directories} onClose={() => setDirectories(false)} />
    </Panel>
  );
}
