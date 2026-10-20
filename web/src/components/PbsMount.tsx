import { useState } from 'react';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, FolderOpen, Lock, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import { api, type Host, type PbsMount, type PbsMountSource } from '../lib/api';
import { useMe } from '../lib/auth';
import { formatBytes } from '../lib/backups';
import { dateTime, timeAgo } from '../lib/format';
import { stepStates } from '../lib/steps';
import { useToast } from '../lib/toast';
import { Step, Steps } from './PbsDialog';
import { Badge, Button, ConfirmModal, CopyField, Modal, Segmented, Spinner } from './ui';

// Read-only mount of a snapshot of a PBS on a host (hub/src/pbsMount.ts, #209): a window in four steps
// (backup of the PBS chosen, snapshot, archive, destination) and the banner shown as long as a snapshot
// is mounted (dashboard, backups page). Never unmounted automatically.

const snapshotDate = (t: number) => dateTime(t * 1000);

function Choice({ selected, disabled, onClick, children }: { selected: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'w-full rounded-md border px-2.5 py-2 text-left text-xs transition disabled:cursor-not-allowed disabled:opacity-50',
        selected ? 'border-emerald-500/60 bg-emerald-500/10 text-zinc-100' : 'border-line bg-raised/40 text-zinc-300 hover:border-zinc-500',
      )}
    >
      {children}
    </button>
  );
}

const listCls = 'max-h-[46vh] min-h-0 space-y-1.5 overflow-y-auto pr-1';

function Loading({ q }: { q: { isPending: boolean; error: unknown } }) {
  if (q.error) return <p className="text-xs text-red-400">{(q.error as Error).message}</p>;
  return q.isPending ? <Spinner className="h-4 w-4" /> : null;
}

export function MountDialog({ open, initialGroupId, onClose }: { open: boolean; initialGroupId?: string | null; onClose: () => void }) {
  const toast = useToast();
  // null: not chosen, the first ready PBS
  const [picked, setSource] = useState<PbsMountSource | null>(null);
  const [time, setTime] = useState<number | null>(null);
  const [archive, setArchive] = useState<string | null>(null);
  const [pickedHost, setHostId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const overview = useQuery({ queryKey: ['pbs-mount'], queryFn: api.pbsMount, enabled: open });
  const source: PbsMountSource = picked ?? overview.data?.sources.find((s) => s.ready)?.id ?? 'main';
  const src = overview.data?.sources.find((s) => s.id === source);
  const groups = useQuery({ queryKey: ['pbs-mount', source, 'groups'], queryFn: () => api.pbsMountGroups(source), enabled: open && !!src?.ready });
  const selectedGroupId = initialGroupId && groups.data?.some((g) => g.id === initialGroupId) ? initialGroupId : null;
  const snaps = useQuery({ queryKey: ['pbs-mount', source, 'snapshots', selectedGroupId], queryFn: () => api.pbsMountSnapshots(source, selectedGroupId!), enabled: open && !!selectedGroupId, staleTime: 0 });
  // tested by the agents now: asked once the archive is chosen
  const dests = useQuery({ queryKey: ['pbs-mount', source, 'destinations'], queryFn: () => api.pbsMountDestinations(source), enabled: open && !!archive, staleTime: 0, gcTime: 0 });

  // the host of the PBS by default, when it can
  const hostId = pickedHost ?? dests.data?.defaultHostId ?? null;

  const pickSource = (s: PbsMountSource | null) => {
    setSource(s);
    setTime(null);
    setArchive(null);
    setHostId(null);
  };
  const pickTime = (t: number) => {
    setTime(t);
    setArchive(null);
  };

  const snap = snaps.data?.find((s) => s.time === time);
  const selectedGroup = groups.data?.find((g) => g.id === selectedGroupId);
  const dest = dests.data?.hosts.find((h) => h.id === hostId);
  const active = overview.data?.active;
  const states = stepStates([!!selectedGroupId, time !== null, !!archive, !!dest?.reach.ok]);

  const close = () => {
    pickSource(null);
    onClose();
  };

  const run = async () => {
    if (!selectedGroupId || time === null || !archive || !hostId) return;
    setBusy(true);
    try {
      const r = await api.mountSnapshot({ source, groupId: selectedGroupId, time, archive, hostId });
      toast.success(`Sauvegarde montée sous ${r.path}`);
      close();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} wide="screen" title="Monter une sauvegarde (lecture seule)">
      {active && (
        <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Une sauvegarde est déjà montée sur {active.hostName} : un seul montage à la fois, la démonter d’abord.
        </p>
      )}
      <Steps>
        <Step n={1} title="Sauvegarde" state={states[0]} intro="Sauvegarde choisie depuis sa ligne dans la page Sauvegardes.">
          {overview.data && (
            <Segmented label="PBS" options={overview.data.sources.map((s) => ({ id: s.id, label: s.label }))} value={source} onChange={pickSource} />
          )}
          {src && !src.ready ? (
            <p className="text-xs text-red-400">{src.reason}</p>
          ) : (
            <div className="mt-3">
              <Loading q={groups} />
              {selectedGroup ? (
                <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs">
                  <p className="font-medium text-zinc-100">{selectedGroup.label}</p>
                  <p className="mt-1 font-mono text-[11px] text-muted">
                    {selectedGroup.type}/{selectedGroup.backupId} · {selectedGroup.store} › {selectedGroup.ns || 'racine'}
                  </p>
                  <p className="mt-1 text-[11px] text-muted">
                    {selectedGroup.hostName ?? 'orpheline'}
                    {selectedGroup.lastBackup ? ` · ${timeAgo(selectedGroup.lastBackup)}` : ''}
                  </p>
                </div>
              ) : groups.data ? (
                <p className="text-xs text-amber-300">Cette sauvegarde n’est pas disponible sur ce PBS.</p>
              ) : null}
            </div>
          )}
        </Step>

        <Step n={2} title="Snapshot" state={states[1]} intro="Lu à l’instant sur le PBS choisi, du plus récent au plus ancien.">
          {selectedGroupId && <Loading q={snaps} />}
          <div className={listCls}>
            {snaps.data?.map((s) => (
              <Choice key={s.time} selected={s.time === time} onClick={() => pickTime(s.time)}>
                <span className="flex items-center gap-2">
                  <span className="font-medium">{snapshotDate(s.time)}</span>
                  {s.verify === 'ok' && <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-label="vérifié" />}
                  {s.verify === 'failed' && <Badge tone="bad">vérification en échec</Badge>}
                </span>
                <span className="block text-[11px] text-muted">
                  {formatBytes(s.size)}
                  {s.comment ? ` · ${s.comment}` : ''}
                </span>
              </Choice>
            ))}
            {snaps.data && !snaps.data.length && <p className="text-xs text-muted">Aucun snapshot.</p>}
          </div>
        </Step>

        <Step n={3} title="Archive" state={states[2]} intro="Une archive pxar par répertoire sauvegardé ; root.pxar pour un conteneur.">
          <div className={listCls}>
            {snap?.archives.map((a) => (
              <Choice key={a.name} selected={a.name === archive} disabled={a.encrypted} onClick={() => setArchive(a.name)}>
                <span className="flex items-center gap-2 font-mono">
                  {a.name.replace(/\.didx$/, '')}
                  {a.encrypted && <Lock className="h-3.5 w-3.5" aria-label="chiffrée" />}
                </span>
                <span className="block text-[11px] text-muted">{a.encrypted ? 'chiffrée : non montable sans sa clé' : formatBytes(a.size)}</span>
              </Choice>
            ))}
            {snap && !snap.archives.length && <p className="text-xs text-muted">Aucune archive pxar dans ce snapshot.</p>}
          </div>
        </Step>

        <Step
          n={4}
          title="Destination"
          state={states[3]}
          intro="Par défaut l’hôte du PBS. Autres hôtes : client natif et FUSE, et joignant le PBS (testé à l’instant)."
          footer={
            <Button variant="primary" icon={FolderOpen} loading={busy} disabled={!!active || !selectedGroupId || time === null || !archive || !dest?.reach.ok} onClick={run} className="w-full">
              Monter
            </Button>
          }
        >
          {archive && <Loading q={dests} />}
          {dests.data?.pbsHost.reason && <p className="text-xs text-amber-300">Hôte du PBS : {dests.data.pbsHost.reason}</p>}
          <div className={listCls}>
            {dests.data?.hosts.map((h) => (
              <Choice key={h.id} selected={h.id === hostId} disabled={!h.reach.ok} onClick={() => setHostId(h.id)}>
                <span className="flex items-center gap-2 font-medium">
                  {h.name}
                  {h.isPbsHost && <Badge tone="info">hôte du PBS</Badge>}
                  {h.slow && h.reach.ok && <Badge tone="warn">lien lent</Badge>}
                </span>
                {!h.reach.ok && <span className="block text-[11px] text-red-400">{h.reach.error}</span>}
              </Choice>
            ))}
            {dests.data && !dests.data.hosts.length && <p className="text-xs text-muted">Aucun hôte ne sait monter : agent à jour, client natif et /dev/fuse requis.</p>}
          </div>
          {dest?.slow && (
            <p className="flex gap-1.5 text-xs text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Lecture à travers un lien lent ({source === 'offsite' ? 'PBS de secours' : 'autre site'}) : parcourir et copier sera lent.
            </p>
          )}
          {dest && <p className="text-xs text-muted">Sous {overview.data?.mountRoot ?? '/srv/pbs-restore'} sur {dest.name}, lisible par root seulement.</p>}
        </Step>
      </Steps>
    </Modal>
  );
}

function MountText({ m, host }: { m: PbsMount; host: Host }) {
  const what = (
    <>
      <b className="text-zinc-100">{m.label}</b> du {snapshotDate(m.time)} ({m.archive.replace(/\.didx$/, '')}, {m.source === 'offsite' ? 'PBS de secours' : 'PBS principal'})
    </>
  );
  if (m.state === 'mounting') return <p>Montage de {what} sur <b className="text-zinc-100">{host.name}</b> en cours…</p>;
  if (m.state === 'unmounting')
    return (
      <p>
        Démontage de {what} sur <b className="text-zinc-100">{host.name}</b> en attente{m.error ? ` : ${m.error}` : '…'} Il reprend au retour des agents.
      </p>
    );
  return (
    <p>
      Sauvegarde {what} montée en lecture seule sur <b className="text-zinc-100">{host.name}</b> depuis {timeAgo(m.mountedAt ?? m.startedAt)}.
      {m.type === 'ct' && ' Conteneur non privilégié : les propriétaires y apparaissent décalés de 100000 (uid 1000 → 101000).'}
      {m.slow && ' Lien lent : lecture lente.'}
    </p>
  );
}

// Shown as long as a snapshot is mounted (or its unmount waits for an agent): the host is in warning meanwhile.
export function MountBanner({ hosts }: { hosts: Host[] }) {
  const { canManage } = useMe();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const host = hosts.find((h) => h.pbsMount);
  const m = host?.pbsMount;
  if (!host || !m) return null;

  const unmount = async () => {
    setBusy(true);
    try {
      const r = await api.unmountSnapshot();
      if (r.pending) toast.error(`Démontage incomplet : ${r.pending.error ?? 'en attente'}`);
      else toast.success('Sauvegarde démontée, jeton révoqué');
      setConfirm(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel flex flex-col gap-3 border-amber-500/50 bg-amber-500/5 px-4 py-3 text-sm text-zinc-300 md:flex-row md:items-center">
      <FolderOpen className="hidden h-5 w-5 shrink-0 text-amber-400 md:block" />
      <div className="min-w-0 flex-1 space-y-2">
        <MountText m={m} host={host} />
        {m.state === 'mounted' && m.path && <CopyField value={m.path} />}
      </div>
      {canManage && m.state !== 'mounting' && (
        <Button icon={m.state === 'unmounting' ? RefreshCw : Unplug} loading={busy} onClick={() => (m.state === 'unmounting' ? unmount() : setConfirm(true))}>
          {m.state === 'unmounting' ? 'Réessayer' : 'Démonter'}
        </Button>
      )}
      <ConfirmModal open={confirm} onClose={() => setConfirm(false)} onConfirm={unmount} title="Démonter la sauvegarde" confirmLabel="Démonter" danger loading={busy}>
        <p>
          {m.path} sera démonté sur {host.name} : une copie en cours depuis ce répertoire sera interrompue. Le jeton de lecture créé pour ce montage est révoqué
          sur le PBS.
        </p>
      </ConfirmModal>
    </section>
  );
}
