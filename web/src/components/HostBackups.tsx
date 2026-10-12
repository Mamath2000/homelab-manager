import { useState } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { AlertTriangle, Container, DatabaseBackup, FolderArchive, Link2, Package, PackageX, Play, Search, Unlink } from 'lucide-react';
import { ManagedBackupsModal } from './ManagedBackups';
import { api, type BackupGroup, type BackupOrphan, type Host } from '../lib/api';
import { useMe } from '../lib/auth';
import { type DayVerify, backupClient, backupKind, backupStateMeta, formatBytes, groupLabel, guestLabel, hoursLabel, rhythmLabel, scheduleLabel, thresholdSourceLabel, timeline } from '../lib/backups';
import { dateTime, timeAgo } from '../lib/format';
import { useBackups } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Badge, Button, Modal, Panel } from './ui';

const DAY = 24 * 3600_000;

// One square per day over the last 30 days: snapshots that day (green when all verified, orange when one
// is not verified yet, red when a verification failed), or a missing day for a backup expected at least
// daily (days before its oldest known snapshot are left neutral).
// Full width of its container by default; className sets another width (table cell).
const verifyColor: Record<DayVerify, string> = { ok: 'bg-emerald-500', unverified: 'bg-amber-500', failed: 'bg-red-500' };
const verifyLabel: Record<DayVerify, string> = { ok: ', vérifié', unverified: ', non vérifié', failed: ', vérification en échec' };

export function BackupTimeline({ group, days = 30, className }: { group: Pick<BackupGroup, 'times' | 'interval'>; days?: number; className?: string }) {
  const cells = timeline(group.times, days);
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
            title={`${new Date(c.day).toLocaleDateString('fr-FR')} : ${c.count ? `${c.count} snapshot${c.count > 1 ? 's' : ''}${verifyLabel[c.verify]}` : 'aucun snapshot'}`}
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

// Small icon of the PBS client of the host: installed (APT), image (Docker), none.
function ClientIcon({ host }: { host: Host }) {
  const c = backupClient(host.capabilities);
  if (!c.supported) return null;
  const [Icon, tone, title] =
    c.mode === 'native'
      ? [Package, 'text-emerald-400', 'Client PBS installé (APT)']
      : c.mode === 'docker'
        ? [Container, 'text-sky-400', 'Client PBS en conteneur (image Docker)']
        : [PackageX, 'text-zinc-500', 'Client PBS absent : sauvegardes de répertoires impossibles (bouton Répertoires pour l’installer)'];
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
          <ClientIcon host={host} />
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
                  {canWrite && g.managed && (
                    <Button size="sm" icon={Play} className="ml-auto" loading={running === g.id} disabled={!host.online} onClick={() => run(g)} title="Lancer la sauvegarde maintenant">
                      Lancer
                    </Button>
                  )}
                  {canManage && !g.source && (
                    <Button size="sm" variant="ghost" icon={Unlink} className="ml-auto" title="Détacher : la sauvegarde n'est plus suivie" onClick={() => detach(g)} />
                  )}
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
      <ManagedBackupsModal host={host} open={directories} onClose={() => setDirectories(false)} />
    </Panel>
  );
}
