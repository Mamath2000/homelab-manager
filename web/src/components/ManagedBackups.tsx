import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Container, KeyRound, Package, Pencil, Play, Plus, Save, SearchCheck, Trash2, X } from 'lucide-react';
import { api, type BackupJob, type BackupJobInput, type BackupJobKind, type DatabaseCheck, type DatabaseDump, type DatabaseKind, type Host, type HostBackupJobs } from '../lib/api';
import { databaseJobText, dumpArchives, formatBytes } from '../lib/backups';
import { useMe } from '../lib/auth';
import { dateTime, timeAgo } from '../lib/format';
import { pbsTokenScript, splitTokenId } from '../lib/tokenScripts';
import { useBackups } from '../lib/queries';
import { useToast } from '../lib/toast';
import { BackupTimeline } from './HostBackups';
import { TokenSetup } from './TokenSetup';
import { Badge, Button, ConfirmModal, CopyField, Modal, Spinner } from './ui';

const PRESETS = [
  { label: 'Tous les jours à 03:00', value: '03:00' },
  { label: 'Tous les jours à 22:30', value: '22:30' },
  { label: 'Le dimanche à 03:00', value: 'sun 03:00' },
  { label: 'Du lundi au vendredi à 21:00', value: 'mon..fri 21:00' },
];

const slug = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'host';

function tokenHelp(host: Host, tokenId: string) {
  // DatastoreBackup on the namespace Hosts of every datastore: it only sees and changes the backups it owns
  return pbsTokenScript({ ...splitTokenId(tokenId, `host-${slug(host.name)}@pbs`, 'backup'), path: '/datastore/{store}/Hosts', role: 'DatastoreBackup' });
}

// PBS token of the host: the agent writes its backups with it.
function CredentialModal({ host, view, open, onClose }: { host: Host; view: HostBackupJobs; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tokenId, setTokenId] = useState(view.credential?.tokenId ?? `host-${slug(host.name)}@pbs!backup`);
  const [secret, setSecret] = useState('');
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
            <span className={field}>Secret du jeton <span className="font-mono font-normal">({tokenId})</span></span>
            <input
              className="input font-mono text-xs"
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value.trim())}
              placeholder={view.credential ? '•••••••• (inchangé)' : 'reçu par la commande, ou à coller'}
            />
          </label>
        </div>
        <aside className="space-y-2 self-start rounded-md border border-line bg-raised/40 p-4 text-xs text-muted">
          <p className="font-medium text-zinc-100">Créer le jeton sur le PBS</p>
          <p>
            Un jeton par hôte, avec le rôle <b>DatastoreBackup</b> sur le namespace <code>Hosts</code> de chaque datastore : un hôte compromis ne peut ni lire ni
            modifier les sauvegardes des autres, ni écrire dans les namespaces de Proxmox VE. Une commande collée pour un jeton existant met ses droits à jour (nouveau
            datastore) en gardant son secret.
          </p>
          <TokenSetup
            where="du PBS"
            tokenId={tokenId}
            onTokenIdChange={setTokenId}
            request={() => ({ kind: 'host', hostId: host.id })}
            onDone={() => {
              qc.invalidateQueries({ queryKey: ['backup-jobs', host.id] });
              onClose();
            }}
          />
          <details>
            <summary className="cursor-pointer">Sans la commande : bloc à coller (affiche le secret à recopier)</summary>
            <div className="mt-2">
              <CopyField multiline value={tokenHelp(host, tokenId)} />
            </div>
          </details>
        </aside>
      </div>
    </Modal>
  );
}

// Default work directory of a database job (dedicated to the dumps: the agent empties its sub-directories)
const DEFAULT_WORKDIR = '/var/backups/homelab-agent';
const MAX_KEEP = 30;

const KIND_LABEL: Record<BackupJobKind, string> = { directories: 'Répertoires', postgres: 'Base PostgreSQL', mongodb: 'Base MongoDB' };

const splitList = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

const newDatabase = (kind: DatabaseKind): DatabaseDump =>
  kind === 'postgres' ? { mode: 'databases', databases: [], workDir: DEFAULT_WORKDIR, keep: 1 } : { container: '', databases: [], workDir: DEFAULT_WORKDIR, keep: 1 };

// What a database job dumps: fixed commands of the agent, only these parameters.
function DatabaseFields({ host, view, kind, value, onChange }: { host: Host; view: HostBackupJobs; kind: DatabaseKind; value: DatabaseDump; onChange: (d: DatabaseDump) => void }) {
  const [dbs, setDbs] = useState(value.databases.join(', '));
  const [check, setCheck] = useState<{ result?: DatabaseCheck; error?: string; key: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const field = 'mb-1.5 block text-xs font-medium text-muted';
  const set = (patch: Partial<DatabaseDump>) => onChange({ ...value, ...patch });
  const setDatabases = (list: string[]) => {
    setDbs(list.join(', '));
    set({ databases: list });
  };
  const cluster = kind === 'postgres' && value.mode === 'cluster';
  const unusable = view.databases && !view.databases.includes(kind);
  // the result shown is the one of the parameters checked: stale once they change
  const key = JSON.stringify({ m: value.mode, c: value.container, d: value.databases, w: value.workDir });
  const run = async () => {
    setChecking(true);
    try {
      setCheck({ result: await api.checkBackupDatabase(host.id, kind, value), key });
    } catch (err) {
      setCheck({ error: (err as Error).message, key });
    } finally {
      setChecking(false);
    }
  };
  const result = check?.key === key ? check : null;
  const chosen = new Set(value.databases);
  const needed = result?.result ? result.result.databases.filter((d) => cluster || chosen.has(d.name)).reduce((n, d) => n + d.size, 0) : 0;
  return (
    <div className="space-y-4">
      {!view.databases && <p className="text-xs text-amber-400">Agent à mettre à jour pour sauvegarder des bases.</p>}
      {unusable && (
        <p className="text-xs text-amber-400">
          {kind === 'postgres' ? "pg_dump n'a pas été trouvé sur cet hôte." : "Docker n'est pas disponible sur cet hôte."} La sauvegarde échouera tant que ce n'est pas réglé.
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {kind === 'postgres' ? (
          <label className="block">
            <span className={field}>Mode</span>
            <select
              className="input"
              value={value.mode}
              onChange={(e) => {
                const mode = e.target.value as 'databases' | 'cluster';
                set({ mode, databases: mode === 'cluster' ? [] : splitList(dbs) });
              }}
            >
              <option value="databases">Par base (pg_dump de chaque base + rôles)</option>
              <option value="cluster">Cluster complet (pg_basebackup, copie physique)</option>
            </select>
          </label>
        ) : (
          <label className="block">
            <span className={field}>Conteneur MongoDB</span>
            <input className="input font-mono text-xs" value={value.container ?? ''} onChange={(e) => set({ container: e.target.value.trim() })} placeholder="mongo" />
          </label>
        )}
        {!cluster && (
          <label className="block">
            <span className={field}>Bases (séparées par des virgules)</span>
            <input
              className="input font-mono text-xs"
              value={dbs}
              onChange={(e) => {
                setDbs(e.target.value);
                set({ databases: splitList(e.target.value) });
              }}
              placeholder={kind === 'postgres' ? 'hass, hass-jarsay' : 'homelab'}
            />
          </label>
        )}
      </div>
      <div className="space-y-2">
        <Button size="sm" icon={SearchCheck} loading={checking} disabled={!host.online || !view.databases} onClick={run} title="Demande à l'agent les outils, les bases du serveur et leur taille, et la place libre">
          Vérifier sur l'hôte
        </Button>
        {result?.error && <p className="text-xs text-red-400">{result.error}</p>}
        {result?.result && (
          <div className="space-y-1.5 text-xs">
            <p className="text-muted">
              {result.result.tools} · place libre pour le répertoire de travail : {result.result.free < 0 ? 'inconnue' : formatBytes(result.result.free)}
              {needed > 0 && result.result.free >= 0 && (
                <span className={needed > result.result.free ? 'text-red-400' : 'text-emerald-400'}>
                  {' '}({cluster ? 'cluster' : 'bases choisies'} : {formatBytes(needed)}{needed > result.result.free ? ', place insuffisante' : ''})
                </span>
              )}
            </p>
            {result.result.missing.length > 0 && <p className="text-red-400">Absentes du serveur : {result.result.missing.join(', ')}</p>}
            <div className="flex flex-wrap gap-1.5">
              {result.result.databases.map((d) => {
                const on = chosen.has(d.name);
                return (
                  <button
                    key={d.name}
                    type="button"
                    disabled={cluster}
                    onClick={() => setDatabases(on ? value.databases.filter((x) => x !== d.name) : [...value.databases, d.name])}
                    className={clsx(
                      'rounded border px-2 py-0.5 font-mono',
                      on || cluster ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-200' : 'border-line text-zinc-400 hover:text-zinc-200',
                    )}
                    title={cluster ? 'Cluster complet : toutes les bases' : on ? 'Retirer de la sauvegarde' : 'Ajouter à la sauvegarde'}
                  >
                    {d.name} · {formatBytes(d.size)}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <label className="block">
        <span className={field}>Répertoire de travail (dédié aux dumps)</span>
        <input className="input font-mono text-xs" value={value.workDir} onChange={(e) => set({ workDir: e.target.value.trim() })} placeholder={DEFAULT_WORKDIR} />
        <span className="mt-1 block text-xs text-muted">
          Un sous-répertoire par dump, refait à chaque sauvegarde ; ce sont les archives du snapshot :{' '}
          <span className="font-mono">{dumpArchives(kind, value).map((a) => `${a.name}.pxar`).join(', ') || '—'}</span>. Dumps non compressés : le PBS les déduplique d'un jour à l'autre.
        </span>
      </label>
      <label className="block">
        <span className={field}>Dumps gardés sur l'hôte après l'envoi</span>
        <input
          className="input w-28"
          type="number"
          min={0}
          max={MAX_KEEP}
          value={value.keep}
          onChange={(e) => set({ keep: Math.max(0, Math.min(MAX_KEEP, Math.trunc(Number(e.target.value) || 0))) })}
        />
        <span className="mt-1 block text-xs text-muted">
          {value.keep === 0 ? '0 : le dump est supprimé une fois envoyé.' : `Les ${value.keep > 1 ? `${value.keep} derniers` : 'derniers'} dumps restent dans ${value.workDir}/history/<date>/ (restauration locale rapide, au prix de la place disque).`}
          {' '}Un dump en échec est toujours supprimé.
        </span>
      </label>
    </div>
  );
}

function JobModal({ host, view, job, open, onClose }: { host: Host; view: HostBackupJobs; job: BackupJob | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const initial: BackupJobInput = job
    ? { name: job.name, archives: job.archives, excludes: job.excludes, store: job.store, schedule: job.schedule, enabled: job.enabled, kind: job.kind, database: job.database }
    : {
        // named after the machine: the PBS identifier is deduced from it
        name: host.name,
        archives: [{ name: 'home', path: '/home' }],
        excludes: [],
        // the datastore the token of the host has rights on
        store: view.credential?.store && view.credential.store !== '*' ? view.credential.store : (view.datastores[0] ?? ''),
        backupId: slug(host.name),
        schedule: '03:00',
        enabled: true,
        kind: 'directories',
        database: null,
      };
  const [form, setForm] = useState<BackupJobInput>(initial);
  // creation: the identifier follows the name until it is typed by hand
  const [idAuto, setIdAuto] = useState(true);
  // group already on the PBS, written by something else: refused by the hub (snapshots would mix)
  const { data: pbs } = useBackups();
  const groupId = `${form.store}/Hosts/host/${form.backupId ?? ''}`;
  const taken = !job && [...(pbs?.groups ?? []), ...(pbs?.orphans ?? [])].find((g) => g.id === groupId && !g.gone && !('source' in g && g.source === 'managed'));
  const [excludes, setExcludes] = useState(initial.excludes.join('\n'));
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<BackupJobInput>) => setForm({ ...form, ...patch });
  const setArchive = (i: number, patch: Partial<BackupJobInput['archives'][number]>) =>
    set({ archives: form.archives.map((a, j) => (j === i ? { ...a, ...patch } : a)) });

  const kind = form.kind ?? 'directories';
  const db = kind === 'postgres' || kind === 'mongodb';
  // the kind is chosen at creation: a database job holds its dumps only
  const setKind = (k: BackupJobKind) =>
    set(k === 'directories' ? { kind: k, database: null, archives: form.archives.length ? form.archives : [{ name: 'home', path: '/home' }] } : { kind: k, database: newDatabase(k) });

  const save = async () => {
    setBusy(true);
    const body = db ? { ...form, archives: [], excludes: [] } : { ...form, database: null, excludes: excludes.split('\n').map((e) => e.trim()).filter(Boolean) };
    if (job) delete body.kind;
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

  // a new row is added at the bottom of the list: scrolled into view in the body of the modal
  const archivesRef = useRef<HTMLDivElement>(null);
  const addArchive = () => {
    set({ archives: [...form.archives, { name: '', path: '' }] });
    requestAnimationFrame(() => archivesRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };

  const field = 'mb-1.5 block text-xs font-medium text-muted';
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      scroll
      title={job ? `Sauvegarde ${job.name}` : `Nouvelle sauvegarde de ${host.name}`}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" icon={Save} loading={busy} disabled={!!taken} onClick={save}>Enregistrer</Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <label className="block">
          <span className={field}>Type de sauvegarde</span>
          {job ? (
            <div className="input cursor-default bg-raised/40 text-zinc-400" title="Fixé à la création : ses archives sont d'une autre nature">{KIND_LABEL[kind]}</div>
          ) : (
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as BackupJobKind)}>
              {(Object.keys(KIND_LABEL) as BackupJobKind[]).map((k) => (
                <option key={k} value={k} disabled={k !== 'directories' && !view.databases}>{KIND_LABEL[k]}</option>
              ))}
            </select>
          )}
        </label>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className={field}>Nom</span>
            <input
              className="input"
              value={form.name}
              onChange={(e) => set({ name: e.target.value, ...(!job && idAuto ? { backupId: slug(e.target.value) } : {}) })}
            />
          </label>
          <label className="block">
            <span className={clsx(field, 'flex items-center justify-between')}>
              Identifiant sur le PBS
              {!job && (idAuto ? (
                <span className="font-normal text-zinc-500">déduit du nom</span>
              ) : (
                <button
                  type="button"
                  className="font-normal text-emerald-400 hover:underline"
                  onClick={(e) => {
                    e.preventDefault();
                    setIdAuto(true);
                    set({ backupId: slug(form.name) });
                  }}
                >
                  déduire du nom
                </button>
              ))}
            </span>
            <input
              className="input font-mono text-xs"
              value={job ? job.backupId : form.backupId ?? ''}
              disabled={!!job}
              onChange={(e) => {
                setIdAuto(false);
                set({ backupId: e.target.value.trim() });
              }}
              title="Groupe host/<identifiant> du PBS ; fixé à la création (un autre identifiant commence un nouvel historique)"
            />
            {taken && (
              <span className="mt-1 block text-xs text-amber-400">
                Ce groupe existe déjà sur {form.store} › Hosts ({taken.count} snapshot{taken.count > 1 ? 's' : ''}, sauvegarde externe) : choisis un autre identifiant.
              </span>
            )}
          </label>
        </div>
        {db && form.database ? (
          <DatabaseFields host={host} view={view} kind={kind as DatabaseKind} value={form.database} onChange={(database) => set({ database })} />
        ) : (
          <>
            <div>
              <span className={field}>Répertoires (une archive .pxar chacun)</span>
              <div className="space-y-2">
                <div ref={archivesRef} className="space-y-2">
                  {form.archives.map((a, i) => (
                    <div key={i} className="flex gap-2">
                      <input className="input w-36 font-mono text-xs" value={a.name} onChange={(e) => setArchive(i, { name: e.target.value.trim() })} placeholder="home" title="Nom de l'archive" />
                      <input className="input flex-1 font-mono text-xs" value={a.path} onChange={(e) => setArchive(i, { path: e.target.value.trim() })} placeholder="/home" />
                      <Button variant="ghost" icon={X} title="Retirer" disabled={form.archives.length === 1} onClick={() => set({ archives: form.archives.filter((_, j) => j !== i) })} />
                    </div>
                  ))}
                </div>
                <Button size="sm" icon={Plus} onClick={addArchive}>Répertoire</Button>
              </div>
            </div>
            <label className="block">
              <span className={field}>Exclusions (une par ligne, motifs de proxmox-backup-client)</span>
              <textarea className="input h-20 font-mono text-xs" value={excludes} onChange={(e) => setExcludes(e.target.value)} placeholder={'**/.cache\n**/node_modules'} />
            </label>
          </>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className={field}>Datastore</span>
            <select className="input" value={form.store} onChange={(e) => set({ store: e.target.value })}>
              {!view.datastores.includes(form.store) && <option value={form.store}>{form.store || '—'}</option>}
              {view.datastores.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            {view.credential?.store && view.credential.store !== '*' && form.store !== view.credential.store && (
              <span className="mt-1 block text-xs text-amber-400">
                Le jeton de cet hôte n'a de droits que sur {view.credential.store} › Hosts : recolle la commande d'accès PBS pour l'étendre à tous les datastores.
              </span>
            )}
          </label>
          <div>
            <span className={field}>Namespace</span>
            <div className="input cursor-default bg-raised/40 font-mono text-xs text-zinc-400" title="Fixé : le jeton de l'hôte n'écrit que dans Hosts">Hosts</div>
          </div>
        </div>
        <div className="-mt-2 text-xs">
          {(() => {
            const r = view.retention?.[form.store];
            if (r === undefined) return null;
            return r ? (
              <span className="text-muted" title={`Job d'élagage du PBS sur ${form.store}${r.ns ? ` › ${r.ns}` : ''} ; modifiable dans le PBS (Datastore › Élagage et GC)`}>
                Rétention (élagage du PBS{r.schedule ? `, ${r.schedule}` : ''}) : <span className="text-zinc-300">{r.keep}</span>
              </span>
            ) : (
              <span className="text-amber-400">Aucun élagage sur {form.store} › Hosts : les snapshots s'accumulent (à régler dans le PBS, Datastore › Élagage et GC).</span>
            );
          })()}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className={field}>Planification</span>
            <input className="input font-mono text-xs" value={form.schedule} onChange={(e) => set({ schedule: e.target.value })} list="backup-presets" />
            <datalist id="backup-presets">{PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</datalist>
            <span className="mt-1 block text-xs text-muted">Syntaxe Proxmox : <code>03:00</code>, <code>sun 01:00</code>, <code>mon..fri 22:30</code>, <code>daily</code>.</span>
          </label>
          <div>
            <span className={field}>Fuseau horaire</span>
            <div className="input cursor-default bg-raised/40 font-mono text-xs text-zinc-400" title="Fixé : fuseau du hub (variable TZ du compose)">
              {job ? job.timezone : view.timezone}
            </div>
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="h-4 w-4 accent-emerald-500" />
          <span>Active (l'agent la lance à l'heure prévue)</span>
        </label>
      </div>
    </Modal>
  );
}

// Edition of one backup job straight from the list of the backups of the host (pencil of its line),
// without going through the window of the directories.
export function BackupJobEditModal({ host, jobId, onClose }: { host: Host; jobId: string | null; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['backup-jobs', host.id], queryFn: () => api.hostBackupJobs(host.id), enabled: !!jobId });
  if (!jobId) return null;
  const job = data?.jobs.find((j) => j.id === jobId);
  if (!data || !job) {
    return (
      <Modal open onClose={onClose} title="Sauvegarde">
        {data ? <p className="text-sm text-muted">Ce job n'existe plus.</p> : <div className="flex justify-center p-4"><Spinner /></div>}
      </Modal>
    );
  }
  return <JobModal key={job.id} host={host} view={data} job={job} open onClose={onClose} />;
}

// Installation of the PBS client, by the agent: Proxmox repository + package (APT), or the client image
// (Docker); the choice when both are possible. Hosts in Docker mode may switch to APT.
function ClientInstall({ host, mode, options, canManage }: { host: Host; mode: HostBackupJobs['mode']; options: HostBackupJobs['install']; canManage: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const install = async (method: 'apt' | 'docker') => {
    setBusy(method);
    try {
      await api.installBackupClient(host.id, method);
      toast.success(`Installation du client PBS (${method === 'apt' ? 'APT' : 'Docker'}) lancée : suivi dans Activité`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (mode === 'docker') {
    return canManage ? (
      <p className="mb-3 text-xs text-muted">
        Le client tourne en conteneur.{' '}
        <Button size="sm" variant="ghost" icon={Package} loading={busy === 'apt'} disabled={!host.online} onClick={() => install('apt')}>Installer le client APT</Button> (il sera
        alors préféré au conteneur).
      </p>
    ) : null;
  }
  return (
    <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-100">
      <p className="mb-2">Le client PBS (proxmox-backup-client) n'est pas sur cet hôte : l'agent ne peut pas sauvegarder.</p>
      {options.length === 0 ? (
        <p className="text-xs text-amber-200/80">
          Aucune installation automatique possible : le paquet APT n'existe que pour Debian bookworm / trixie amd64, l'image Docker que pour amd64. Installer
          Docker, ou le client à la main, puis l'agent le détectera.
        </p>
      ) : canManage ? (
        <div className="flex flex-wrap gap-2">
          {options.includes('apt') && (
            <Button size="sm" icon={Package} loading={busy === 'apt'} disabled={!host.online} onClick={() => install('apt')} title="Dépôt pbs-client de Proxmox + apt install proxmox-backup-client">
              Installer via APT
            </Button>
          )}
          {options.includes('docker') && (
            <Button size="sm" icon={Container} loading={busy === 'docker'} disabled={!host.online} onClick={() => install('docker')} title="Télécharge l'image du client (mathmath350/pbs-client)">
              Installer via Docker
            </Button>
          )}
        </div>
      ) : (
        <p className="text-xs">Installation possible par un administrateur.</p>
      )}
    </div>
  );
}

// Backups of directories defined here and run by the agent of the host (window opened from the
// Sauvegardes card of the host page).
export function ManagedBackupsModal({ host, open, onClose }: { host: Host; open: boolean; onClose: () => void }) {
  const { data: backups } = useBackups();
  const { canManage, canWrite } = useMe();
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['backup-jobs', host.id], queryFn: () => api.hostBackupJobs(host.id), enabled: !!backups?.enabled && open });
  const [editing, setEditing] = useState<BackupJob | 'new' | null>(null);
  const [removing, setRemoving] = useState<BackupJob | null>(null);
  const [credential, setCredential] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  if (!backups?.enabled || !open) return null;
  if (!data) {
    return (
      <Modal open onClose={onClose} wide="xl" title={`Sauvegardes lancées par l'agent de ${host.name}`}>
        <div className="flex justify-center p-4"><Spinner /></div>
      </Modal>
    );
  }

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
    <Modal open onClose={onClose} wide="xl" scroll title={`Sauvegardes lancées par l'agent de ${host.name}`}>
      {/* the list scrolls under this bar; -top-4/-mt-4 cover the padding of the window body */}
      <div className="sticky -top-4 z-10 -mx-5 -mt-4 mb-3 border-b border-line bg-panel px-5 pb-3 pt-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {data.mode === 'native' && <Badge tone="ok">client PBS installé (APT)</Badge>}
          {data.mode === 'docker' && <Badge tone="ok">client PBS en conteneur (Docker)</Badge>}
          {!data.mode && <Badge tone="warn">{data.supported ? 'client PBS absent' : 'agent à mettre à jour'}</Badge>}
          {data.credential ? (
            <Badge tone="neutral">
              jeton {data.credential.tokenId}
              {data.credential.store && ` · ${data.credential.store === '*' ? 'tous les datastores' : data.credential.store} › Hosts`}
            </Badge>
          ) : (
            <Badge tone="warn">aucun jeton PBS</Badge>
          )}
          {data.sync?.error ? (
            <Badge tone="bad" className="max-w-full truncate">refusée par l'agent : {data.sync.error}</Badge>
          ) : data.jobs.length > 0 && data.sync?.current ? (
            <Badge tone="ok">appliquée par l'agent</Badge>
          ) : data.jobs.length > 0 ? (
            <Badge tone="warn">pas encore appliquée par l'agent</Badge>
          ) : null}
          {canManage && (
            <span className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" icon={KeyRound} onClick={() => setCredential(true)} title="Jeton du PBS de cet hôte">Accès PBS</Button>
              <Button
                size="sm"
                icon={Plus}
                disabled={!data.credential || !data.mode}
                onClick={() => setEditing('new')}
                title={!data.mode ? "Installer d'abord le client PBS" : data.credential ? undefined : "Renseigner d'abord l'accès au PBS"}
              >
                Ajouter
              </Button>
            </span>
          )}
        </div>
        {data.supported && (!data.mode || (data.mode === 'docker' && data.install.includes('apt'))) && (
          // its own bottom margin is taken by the bar's padding
          <div className="-mb-3 mt-3">
            <ClientInstall host={host} mode={data.mode} options={data.install} canManage={canManage} />
          </div>
        )}
      </div>
      {data.jobs.length === 0 ? (
        <p className="text-sm text-muted">
          Aucune sauvegarde définie ici. L'agent sauvegarde sur le PBS les répertoires ou les bases choisis, à l'heure prévue, même si le hub est arrêté.
        </p>
      ) : (
        <ul className="-my-2 divide-y divide-line">
          {data.jobs.map((j) => {
            const g = groupOf(j);
            return (
              <li key={j.id} className="py-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-zinc-100">{j.name}</span>
                  <Badge tone="neutral">{KIND_LABEL[j.kind]}</Badge>
                  {!j.enabled && <Badge tone="neutral">désactivée</Badge>}
                  <span className="ml-auto flex gap-1">
                    {canWrite && <Button size="sm" icon={Play} loading={busy === j.id} disabled={!host.online} onClick={() => run(j)} title="Lancer maintenant">Lancer</Button>}
                    {canManage && <Button size="sm" variant="ghost" icon={Pencil} title="Modifier" onClick={() => setEditing(j)} />}
                    {canManage && <Button size="sm" variant="ghost" icon={Trash2} title="Supprimer" onClick={() => setRemoving(j)} />}
                  </span>
                </div>
                {databaseJobText(j) ? (
                  <div className="mt-0.5 text-xs text-zinc-300">{databaseJobText(j)}</div>
                ) : (
                  <div className="mt-0.5 font-mono text-xs text-zinc-400">{j.archives.map((a) => a.path).join('  ')}</div>
                )}
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
                {/* snapshots seen on the PBS over the last 30 days */}
                {g && <BackupTimeline group={g} className="mt-2 w-full" />}
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
    </Modal>
  );
}
