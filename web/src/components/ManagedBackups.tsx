import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderArchive, KeyRound, Pencil, Play, Plus, Save, Trash2, X } from 'lucide-react';
import { api, type BackupJob, type BackupJobInput, type Host, type HostBackupJobs } from '../lib/api';
import { useMe } from '../lib/auth';
import { dateTime, timeAgo } from '../lib/format';
import { pbsTokenScript } from '../lib/tokenScripts';
import { useBackups } from '../lib/queries';
import { useToast } from '../lib/toast';
import { TokenSetup } from './TokenSetup';
import { Badge, Button, ConfirmModal, CopyField, Modal, Panel, Spinner } from './ui';

const PRESETS = [
  { label: 'Tous les jours à 03:00', value: '03:00' },
  { label: 'Tous les jours à 22:30', value: '22:30' },
  { label: 'Le dimanche à 03:00', value: 'sun 03:00' },
  { label: 'Du lundi au vendredi à 21:00', value: 'mon..fri 21:00' },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'host';

function tokenHelp(host: Host, store: string) {
  // DatastoreBackup: it only sees and changes the backups it owns
  return pbsTokenScript({ user: `host-${slug(host.name)}@pbs`, token: 'backup', path: `/datastore/${store}/Hosts`, role: 'DatastoreBackup' });
}

// PBS token of the host: the agent writes its backups with it.
function CredentialModal({ host, view, open, onClose }: { host: Host; view: HostBackupJobs; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tokenId, setTokenId] = useState(view.credential?.tokenId ?? `host-${slug(host.name)}@pbs!backup`);
  const [secret, setSecret] = useState('');
  const [store, setStore] = useState(view.datastores[0] ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.setPbsCredential(host.id, { tokenId, ...(secret ? { tokenSecret: secret } : {}) });
      qc.invalidateQueries({ queryKey: ['backup-jobs', host.id] });
      setSecret('');
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const field = 'mb-1.5 block text-xs font-medium text-muted';
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide="xl"
      title={`Accès au PBS de ${host.name}`}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" icon={Save} loading={busy} onClick={save}>Enregistrer</Button>
        </>
      }
    >
      <div className="grid gap-6 text-sm lg:grid-cols-2">
        <div className="space-y-4">
          <p className="text-muted">
            L'agent écrit les sauvegardes de cet hôte avec ce jeton. Le hub le lui transmet par la connexion chiffrée de l'agent ; il est gardé sur l'hôte dans un
            fichier lisible par root seulement, et jamais renvoyé à l'interface.
          </p>
          <label className="block">
            <span className={field}>Identifiant du jeton</span>
            <input className="input font-mono text-xs" value={tokenId} onChange={(e) => setTokenId(e.target.value.trim())} spellCheck={false} />
          </label>
          <label className="block">
            <span className={field}>Secret du jeton</span>
            <input
              className="input font-mono text-xs"
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value.trim())}
              placeholder={view.credential ? '•••••••• (inchangé)' : 'xxxxxxxx-xxxx-…'}
            />
          </label>
        </div>
        <aside className="space-y-2 self-start rounded-md border border-line bg-raised/40 p-4 text-xs text-muted">
          <p className="font-medium text-zinc-100">Créer le jeton sur le PBS</p>
          <label className="flex items-center gap-2">
            <span>Datastore des sauvegardes de cet hôte</span>
            <select className="input h-8 w-28 py-1 text-xs" value={store} onChange={(e) => setStore(e.target.value)}>
              {view.datastores.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <p>
            Un jeton par hôte, avec le rôle <b>DatastoreBackup</b> sur le namespace des hôtes : un hôte compromis ne peut ni lire ni modifier les sauvegardes des
            autres.
          </p>
          <TokenSetup
            where="du PBS"
            disabled={!store}
            request={() => ({ kind: 'host', hostId: host.id, store })}
            onDone={() => {
              qc.invalidateQueries({ queryKey: ['backup-jobs', host.id] });
              onClose();
            }}
          />
          <details>
            <summary className="cursor-pointer">Sans la commande : bloc à coller (affiche le secret à recopier)</summary>
            <div className="mt-2">
              <CopyField multiline value={tokenHelp(host, store || 'ds2')} />
            </div>
          </details>
        </aside>
      </div>
    </Modal>
  );
}

function JobModal({ host, view, job, open, onClose }: { host: Host; view: HostBackupJobs; job: BackupJob | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const initial: BackupJobInput = job
    ? { name: job.name, archives: job.archives, excludes: job.excludes, store: job.store, ns: job.ns, schedule: job.schedule, timezone: job.timezone, enabled: job.enabled }
    : {
        name: 'home',
        archives: [{ name: 'home', path: '/home' }],
        excludes: [],
        store: view.datastores[0] ?? '',
        ns: 'Hosts',
        backupId: slug(host.name),
        schedule: '03:00',
        timezone: view.timezone,
        enabled: true,
      };
  const [form, setForm] = useState<BackupJobInput>(initial);
  const [excludes, setExcludes] = useState(initial.excludes.join('\n'));
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<BackupJobInput>) => setForm({ ...form, ...patch });
  const setArchive = (i: number, patch: Partial<BackupJobInput['archives'][number]>) =>
    set({ archives: form.archives.map((a, j) => (j === i ? { ...a, ...patch } : a)) });

  const save = async () => {
    setBusy(true);
    const body = { ...form, excludes: excludes.split('\n').map((e) => e.trim()).filter(Boolean) };
    try {
      if (job) await api.updateBackupJob(job.id, body);
      else await api.createBackupJob(host.id, body);
      qc.invalidateQueries({ queryKey: ['backup-jobs', host.id] });
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = 'mb-1.5 block text-xs font-medium text-muted';
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={job ? `Sauvegarde ${job.name}` : `Nouvelle sauvegarde de ${host.name}`}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" icon={Save} loading={busy} onClick={save}>Enregistrer</Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className={field}>Nom</span>
            <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="block">
            <span className={field}>Identifiant sur le PBS</span>
            <input
              className="input font-mono text-xs"
              value={job ? job.backupId : form.backupId ?? ''}
              disabled={!!job}
              onChange={(e) => set({ backupId: e.target.value.trim() })}
              title="Groupe host/<identifiant> du PBS ; fixé à la création (un autre identifiant commence un nouvel historique)"
            />
          </label>
        </div>
        <div>
          <span className={field}>Répertoires (une archive .pxar chacun)</span>
          <div className="space-y-2">
            {form.archives.map((a, i) => (
              <div key={i} className="flex gap-2">
                <input className="input w-36 font-mono text-xs" value={a.name} onChange={(e) => setArchive(i, { name: e.target.value.trim() })} placeholder="home" title="Nom de l'archive" />
                <input className="input flex-1 font-mono text-xs" value={a.path} onChange={(e) => setArchive(i, { path: e.target.value.trim() })} placeholder="/home" />
                <Button variant="ghost" icon={X} title="Retirer" disabled={form.archives.length === 1} onClick={() => set({ archives: form.archives.filter((_, j) => j !== i) })} />
              </div>
            ))}
            <Button size="sm" icon={Plus} onClick={() => set({ archives: [...form.archives, { name: '', path: '' }] })}>Répertoire</Button>
          </div>
        </div>
        <label className="block">
          <span className={field}>Exclusions (une par ligne, motifs de proxmox-backup-client)</span>
          <textarea className="input h-20 font-mono text-xs" value={excludes} onChange={(e) => setExcludes(e.target.value)} placeholder={'**/.cache\n**/node_modules'} />
        </label>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className={field}>Datastore</span>
            <select className="input" value={form.store} onChange={(e) => set({ store: e.target.value })}>
              {!view.datastores.includes(form.store) && <option value={form.store}>{form.store || '—'}</option>}
              {view.datastores.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={field}>Namespace</span>
            <input className="input font-mono text-xs" value={form.ns} onChange={(e) => set({ ns: e.target.value.trim() })} />
          </label>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className={field}>Planification</span>
            <input className="input font-mono text-xs" value={form.schedule} onChange={(e) => set({ schedule: e.target.value })} list="backup-presets" />
            <datalist id="backup-presets">{PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</datalist>
            <span className="mt-1 block text-xs text-muted">Syntaxe Proxmox : <code>03:00</code>, <code>sun 01:00</code>, <code>mon..fri 22:30</code>, <code>daily</code>.</span>
          </label>
          <label className="block">
            <span className={field}>Fuseau horaire</span>
            <input className="input font-mono text-xs" value={form.timezone ?? ''} onChange={(e) => set({ timezone: e.target.value.trim() })} />
          </label>
        </div>
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="h-4 w-4 accent-emerald-500" />
          <span>Active (l'agent la lance à l'heure prévue)</span>
        </label>
      </div>
    </Modal>
  );
}

// Backups of directories defined here and run by the agent of the host.
export function ManagedBackups({ host }: { host: Host }) {
  const { data: backups } = useBackups();
  const { canManage, canWrite } = useMe();
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['backup-jobs', host.id], queryFn: () => api.hostBackupJobs(host.id), enabled: !!backups?.enabled });
  const [editing, setEditing] = useState<BackupJob | 'new' | null>(null);
  const [removing, setRemoving] = useState<BackupJob | null>(null);
  const [credential, setCredential] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  if (!backups?.enabled) return null;
  if (!data) return <Panel title="Sauvegardes de répertoires" icon={FolderArchive}><div className="flex justify-center p-4"><Spinner /></div></Panel>;
  // nothing to show on a host that cannot back up and has no job
  if (!data.mode && data.jobs.length === 0 && !canManage) return null;

  const run = async (j: BackupJob) => {
    setBusy(j.id);
    try {
      await api.runBackupJob(j.id);
      toast.success(`Sauvegarde ${j.name} lancée`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(removing.id);
    try {
      await api.deleteBackupJob(removing.id);
      qc.invalidateQueries({ queryKey: ['backup-jobs', host.id] });
      setRemoving(null);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const state = backups.groups.filter((g) => g.managed);
  const groupOf = (j: BackupJob) => state.find((g) => g.managed?.jobId === j.id);
  return (
    <Panel
      title="Sauvegardes de répertoires"
      icon={FolderArchive}
      actions={
        canManage && (
          <>
            <Button size="sm" variant="ghost" icon={KeyRound} onClick={() => setCredential(true)} title="Jeton du PBS de cet hôte">Accès PBS</Button>
            <Button size="sm" icon={Plus} disabled={!data.credential} onClick={() => setEditing('new')} title={data.credential ? undefined : "Renseigner d'abord l'accès au PBS"}>
              Ajouter
            </Button>
          </>
        )
      }
    >
      <div className="mb-3 flex flex-wrap gap-2 text-xs text-muted">
        {data.mode === 'native' && <Badge tone="ok">client PBS installé</Badge>}
        {data.mode === 'docker' && <Badge tone="ok">client PBS en conteneur</Badge>}
        {!data.mode && <Badge tone="warn">ni client PBS ni Docker (ou agent à mettre à jour)</Badge>}
        {data.credential ? <Badge tone="neutral">jeton {data.credential.tokenId}</Badge> : <Badge tone="warn">aucun jeton PBS</Badge>}
        {data.sync?.error ? (
          <Badge tone="bad" className="max-w-full truncate">refusée par l'agent : {data.sync.error}</Badge>
        ) : data.jobs.length > 0 && data.sync?.current ? (
          <Badge tone="ok">appliquée par l'agent</Badge>
        ) : data.jobs.length > 0 ? (
          <Badge tone="warn">pas encore appliquée par l'agent</Badge>
        ) : null}
      </div>
      {data.jobs.length === 0 ? (
        <p className="text-sm text-muted">
          Aucune sauvegarde définie ici. L'agent sauvegarde les répertoires choisis sur le PBS, à l'heure prévue, même si le hub est arrêté.
        </p>
      ) : (
        <ul className="-my-2 divide-y divide-line">
          {data.jobs.map((j) => {
            const g = groupOf(j);
            return (
              <li key={j.id} className="py-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-zinc-100">{j.name}</span>
                  {!j.enabled && <Badge tone="neutral">désactivée</Badge>}
                  <span className="ml-auto flex gap-1">
                    {canWrite && <Button size="sm" icon={Play} loading={busy === j.id} disabled={!host.online} onClick={() => run(j)} title="Lancer maintenant">Lancer</Button>}
                    {canManage && <Button size="sm" variant="ghost" icon={Pencil} title="Modifier" onClick={() => setEditing(j)} />}
                    {canManage && <Button size="sm" variant="ghost" icon={Trash2} title="Supprimer" onClick={() => setRemoving(j)} />}
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-xs text-zinc-400">{j.archives.map((a) => a.path).join('  ')}</div>
                <div className="text-xs text-muted">
                  {g?.managed?.scheduleText ?? j.schedule} · {j.store}{j.ns ? ` › ${j.ns}` : ''} · host/{j.backupId}
                </div>
                {j.lastRun && (
                  <div className={j.lastRun.ok ? 'text-xs text-emerald-400' : 'text-xs text-red-400'} title={dateTime(j.lastRun.end)}>
                    {j.lastRun.ok ? 'Réussie' : 'Échec'} {timeAgo(j.lastRun.end)}
                    {j.lastRun.error && ` : ${j.lastRun.error}`}
                    {j.lastRun.jobId && <> · <Link to={`/jobs/${j.lastRun.jobId}`} className="hover:underline">journal</Link></>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canManage && (
        <>
          <JobModal key={editing === 'new' ? 'new' : editing?.id ?? 'none'} host={host} view={data} job={editing === 'new' ? null : editing} open={!!editing} onClose={() => setEditing(null)} />
          <CredentialModal key={String(credential)} host={host} view={data} open={credential} onClose={() => setCredential(false)} />
          <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={remove} title="Supprimer la sauvegarde" confirmLabel="Supprimer" danger loading={!!busy}>
            L'agent ne lancera plus <b>{removing?.name}</b>. Les snapshots déjà faits restent sur le PBS (le groupe devient orphelin).
          </ConfirmModal>
        </>
      )}
    </Panel>
  );
}
