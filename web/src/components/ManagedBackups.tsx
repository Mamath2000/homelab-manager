import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Calculator, Container, KeyRound, ListChecks, Package, Plus, Save, X } from 'lucide-react';
import { api, type BackupArchive, type BackupEstimate, type BackupJob, type BackupJobInput, type DatabaseCheck, type DatabaseDump, type DatabaseKind, type Host, type HostBackupJobs } from '../lib/api';
import { databaseKindLabel, dumpArchives, formatBytes, offsiteForm, offsiteInput, offsiteNotCopiable } from '../lib/backups';
import { OffsiteSettingsTab } from './OffsiteCopy';
import { useMe } from '../lib/auth';
import { keys, useBackups } from '../lib/queries';
import { useToast } from '../lib/toast';
import { TokenButton } from './AgentPicker';
import { Badge, Button, Modal, Spinner, VerticalTabs } from './ui';

const PRESETS = [
  { label: 'Tous les jours à 03:00', value: '03:00' },
  { label: 'Tous les jours à 22:30', value: '22:30' },
  { label: 'Le dimanche à 03:00', value: 'sun 03:00' },
  { label: 'Du lundi au vendredi à 21:00', value: 'mon..fri 21:00' },
];

const slug = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'host';

// PBS token of the host: the agent writes its backups with it. The agent of the PBS creates it.
function CredentialModal({ host, view, open, onClose }: { host: Host; view: HostBackupJobs; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [tokenId, setTokenId] = useState(view.credential?.tokenId ?? `host-${slug(host.name)}@pbs!backup`);
  return (
    <Modal open={open} onClose={onClose} wide="xl" title={`Accès au PBS de ${host.name}`} footer={<Button onClick={onClose}>Fermer</Button>}>
      <div className="space-y-4 text-sm">
        <p className="text-muted">
          L'agent écrit les sauvegardes de cet hôte avec ce jeton. L'agent du PBS le crée et l'envoie au hub, qui le transmet à cet hôte par la connexion chiffrée de
          l'agent ; il est gardé sur l'hôte dans un fichier lisible par root seulement, et jamais affiché.
        </p>
        <p className="text-xs text-muted">
          Un jeton par hôte, avec le rôle <b>DatastoreBackup</b> sur le namespace <code>Hosts</code> de chaque datastore : un hôte compromis ne peut ni lire ni modifier
          les sauvegardes des autres, ni écrire dans les namespaces de Proxmox VE. Recréer un jeton existant met ses droits à jour (nouveau datastore) en gardant son
          secret.
        </p>
        {view.pbsAgent ? (
          <TokenButton
            tokenId={tokenId}
            onTokenIdChange={setTokenId}
            create={async () => {
              const r = await api.createPbsCredential(host.id, tokenId);
              qc.invalidateQueries({ queryKey: ['backup-jobs', host.id] });
              return r;
            }}
          />
        ) : (
          <p className="text-amber-400">Le PBS n'est pas relié à son agent : le faire dans Paramètres › Sauvegardes, puis revenir créer le jeton.</p>
        )}
        {view.credential && <p className="text-xs text-muted">Jeton enregistré : <code>{view.credential.tokenId}</code>.</p>}
      </div>
    </Modal>
  );
}

// Default work directory of a database job (dedicated to the dumps: the agent empties its sub-directories)
const DEFAULT_WORKDIR = '/var/backups/homelab-agent';
const MAX_KEEP = 30;

// kinds of this form (nextcloud: jobs of the plugin only)
type FormKind = 'directories' | DatabaseKind;
const KIND_LABEL: Record<FormKind, string> = { directories: 'Répertoires', postgres: 'Base PostgreSQL', mongodb: 'Base MongoDB' };


const newDatabase = (kind: DatabaseKind): DatabaseDump =>
  kind === 'postgres' ? { mode: 'databases', databases: [], workDir: DEFAULT_WORKDIR, keep: 1 } : { container: '', databases: [], workDir: DEFAULT_WORKDIR, keep: 1 };

// What a database job dumps: fixed commands of the agent, only these parameters. The databases are chosen
// among those the agent lists on the server (button at the end of the line), never typed.
function DatabaseFields({ host, view, kind, value, onChange }: { host: Host; view: HostBackupJobs; kind: DatabaseKind; value: DatabaseDump; onChange: (d: DatabaseDump) => void }) {
  const [check, setCheck] = useState<{ result?: DatabaseCheck; error?: string; key: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const field = 'mb-1.5 block text-xs font-medium text-muted';
  const set = (patch: Partial<DatabaseDump>) => onChange({ ...value, ...patch });
  const cluster = kind === 'postgres' && value.mode === 'cluster';
  const unusable = view.databases && !view.databases.includes(kind);
  // the listing is the one of the server asked: stale once the container changes
  const key = JSON.stringify({ c: value.container ?? '' });
  const canList = !!host.online && !!view.databases && (kind === 'postgres' || !!value.container);
  const list = async () => {
    setChecking(true);
    try {
      setCheck({ result: await api.checkBackupDatabase(host.id, kind, value), key });
    } catch (err) {
      setCheck({ error: (err as Error).message, key });
    } finally {
      setChecking(false);
    }
  };
  // a job being edited: its server is listed at once (its databases and their size)
  const listed = useRef(false);
  useEffect(() => {
    if (!listed.current && canList && value.databases.length > 0) {
      listed.current = true;
      void list();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const result = check?.key === key ? check : null;
  const chosen = new Set(value.databases);
  const server = result?.result?.databases ?? [];
  const sizes = new Map(server.map((d) => [d.name, d.size]));
  // the databases of the server, then those chosen that it does not have (shown to be removed)
  const chips = [...server.map((d) => d.name), ...value.databases.filter((d) => !sizes.has(d))];
  const needed = server.filter((d) => cluster || chosen.has(d.name)).reduce((n, d) => n + d.size, 0);
  const toggle = (name: string) => set({ databases: chosen.has(name) ? value.databases.filter((x) => x !== name) : [...value.databases, name] });
  const listButton = (
    <Button
      icon={ListChecks}
      loading={checking}
      disabled={!canList}
      onClick={list}
      title={kind === 'mongodb' && !value.container ? "Indiquer d'abord le conteneur" : "Demande à l'agent les bases du serveur, leur taille et la place libre"}
    >
      Lister les bases
    </Button>
  );
  return (
    <div className="space-y-4">
      {!view.databases && <p className="text-xs text-amber-400">Agent à mettre à jour pour sauvegarder des bases.</p>}
      {unusable && (
        <p className="text-xs text-amber-400">
          {kind === 'postgres' ? "pg_dump n'a pas été trouvé sur cet hôte." : "Docker n'est pas disponible sur cet hôte."} La sauvegarde échouera tant que ce n'est pas réglé.
        </p>
      )}
      {kind === 'postgres' ? (
        <label className="block">
          <span className={field}>Mode</span>
          <div className="flex gap-2">
            <select className="input flex-1" value={value.mode} onChange={(e) => set({ mode: e.target.value as 'databases' | 'cluster', databases: [] })}>
              <option value="databases">Par base (pg_dump de chaque base + rôles)</option>
              <option value="cluster">Cluster complet (pg_basebackup, copie physique)</option>
            </select>
            {listButton}
          </div>
        </label>
      ) : (
        <label className="block">
          <span className={field}>Conteneur MongoDB</span>
          <div className="flex gap-2">
            <input className="input flex-1 font-mono text-xs" value={value.container ?? ''} onChange={(e) => set({ container: e.target.value.trim() })} placeholder="mongo" />
            {listButton}
          </div>
        </label>
      )}
      <div>
        <span className={field}>{cluster ? 'Bases du cluster (toutes sauvegardées)' : 'Bases à sauvegarder (clic pour choisir)'}</span>
        {result?.error && <p className="mb-1.5 text-xs text-red-400">{result.error}</p>}
        {chips.length === 0 ? (
          <p className="text-xs text-muted">{result?.result ? 'Aucune base sur ce serveur.' : '« Lister les bases » pour les afficher.'}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {chips.map((name) => {
              const on = cluster || chosen.has(name);
              const absent = !!result?.result && !sizes.has(name);
              return (
                <button
                  key={name}
                  type="button"
                  disabled={cluster}
                  onClick={() => toggle(name)}
                  className={clsx(
                    'rounded border px-2 py-0.5 font-mono text-xs',
                    absent
                      ? 'border-red-500/60 bg-red-500/10 text-red-300'
                      : on
                        ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-200'
                        : 'border-line text-zinc-400 hover:text-zinc-200',
                  )}
                  title={absent ? 'Absente du serveur : clic pour la retirer' : cluster ? 'Cluster complet : toutes les bases' : on ? 'Retirer de la sauvegarde' : 'Ajouter à la sauvegarde'}
                >
                  {name}
                  {sizes.has(name) && ` · ${formatBytes(sizes.get(name))}`}
                  {absent && ' · absente'}
                </button>
              );
            })}
          </div>
        )}
        {result?.result && (
          <p className="mt-1.5 text-xs text-muted">
            {result.result.tools} · place libre pour le répertoire de travail : {result.result.free < 0 ? 'inconnue' : formatBytes(result.result.free)}
            {needed > 0 && result.result.free >= 0 && (
              <span className={needed > result.result.free ? 'text-red-400' : 'text-emerald-400'}>
                {' '}({cluster ? 'cluster' : 'bases choisies'} : {formatBytes(needed)}{needed > result.result.free ? ', place insuffisante' : ''})
              </span>
            )}
          </p>
        )}
      </div>
      <details className="border-t border-line pt-3">
        <summary className="cursor-pointer text-xs text-muted hover:text-zinc-200">Avancé : stockage des dumps sur l'hôte</summary>
        <div className="mt-3 space-y-4">
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
      </details>
    </div>
  );
}

// Size of the directories of a job with its exclusions, walked by the agent with the rules of the PBS client, to
// check the filters before saving; next to it, the size of the last real snapshot of the job.
function DirectoryEstimate({ host, view, archives, excludes, lastSize }: { host: Host; view: HostBackupJobs; archives: BackupArchive[]; excludes: string[]; lastSize: number | null }) {
  const [state, setState] = useState<{ key: string; result?: BackupEstimate[]; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // the result is the one of the form estimated: stale once the directories or the exclusions change
  const key = JSON.stringify({ archives, excludes });
  const ready = archives.length > 0 && archives.every((a) => a.name && a.path.startsWith('/'));
  const run = async () => {
    setBusy(true);
    try {
      setState({ key, result: await api.estimateBackup(host.id, archives, excludes) });
    } catch (err) {
      setState({ key, error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const stale = !!state && state.key !== key;
  const rows = state?.result ?? [];
  const total = rows.reduce((n, r) => n + r.size, 0);
  const excluded = rows.reduce((n, r) => n + r.excluded.size, 0);
  return (
    <div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          icon={Calculator}
          loading={busy}
          disabled={!host.online || !view.estimate || !ready}
          onClick={run}
          title={!view.estimate ? "Agent à mettre à jour" : !host.online ? 'Hôte hors ligne' : "L'agent parcourt les répertoires avec les exclusions (mêmes règles que proxmox-backup-client), sans rien envoyer"}
        >
          Estimer la taille
        </Button>
        {stale && <span className="text-xs text-amber-400">formulaire modifié : relancer l'estimation</span>}
      </div>
      {state?.error && <p className="mt-1.5 text-xs text-red-400">{state.error}</p>}
      {rows.length > 0 && (
        <div className={clsx('mt-2 space-y-2 text-xs', stale && 'opacity-50')}>
          {rows.map((r) => (
            <div key={r.name}>
              <div className="flex flex-wrap gap-x-2">
                <span className="font-mono">{r.name}.pxar</span>
                <span className="text-muted">{r.path}</span>
                {r.error ? (
                  <span className="text-red-400">{r.error}</span>
                ) : (
                  <span>
                    {formatBytes(r.size)} · {r.files.toLocaleString('fr-FR')} fichiers
                    {r.excluded.files > 0 && <span className="text-muted"> · exclus : {formatBytes(r.excluded.size)} ({r.excluded.files.toLocaleString('fr-FR')} fichiers)</span>}
                    {r.partial && <span className="text-amber-400"> · parcours interrompu (durée ou nombre d'entrées) : minimum</span>}
                  </span>
                )}
              </div>
              {r.excluded.top.length > 0 && (
                <ul className="ml-3 mt-0.5 text-muted">
                  {r.excluded.top.map((it) => (
                    <li key={it.path} className="font-mono">
                      {it.path}
                      {it.dir ? '/' : ''} <span className="font-sans">· {formatBytes(it.size)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <p className="text-muted">
            Total : <span className="text-zinc-200">{formatBytes(total)}</span>
            {excluded > 0 && ` (${formatBytes(excluded)} exclus)`}
            {lastSize != null && ` · dernier snapshot sur le PBS : ${formatBytes(lastSize)}`}. Taille brute des fichiers : le PBS stocke moins (déduplication, compression).
          </p>
        </div>
      )}
    </div>
  );
}

// The agent that runs the backups of a host: who, with which PBS client and token, which databases it can
// dump, and whether it applied the definition (window of the jobs). actions: buttons of its first line.
function AgentHeader({ host, view, sync, actions }: { host: Host; view: HostBackupJobs; sync?: boolean; actions?: ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-raised/40 px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-100">Agent de {host.name}</span>
        <Badge tone={host.online ? 'ok' : 'warn'}>{host.online ? 'en ligne' : 'hors ligne'}</Badge>
        {actions && <span className="ml-auto flex gap-2">{actions}</span>}
      </div>
      <dl className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">Version</dt>
        <dd className={host.agentOutdated ? 'text-amber-400' : 'text-zinc-300'}>
          {host.agentVersion ? `v${host.agentVersion}` : 'inconnue'}
          {host.agentOutdated && host.latestAgentVersion && ` : v${host.latestAgentVersion} disponible`}
        </dd>
        <dt className="text-muted">Client PBS</dt>
        <dd className={view.mode ? 'text-zinc-300' : 'text-amber-400'}>
          {view.mode === 'native' ? 'proxmox-backup-client installé (APT)' : view.mode === 'docker' ? 'en conteneur (image Docker)' : view.supported ? 'absent : à installer' : 'agent à mettre à jour'}
        </dd>
        <dt className="text-muted">Jeton PBS</dt>
        <dd className={view.credential ? 'font-mono text-zinc-300' : 'text-amber-400'}>
          {view.credential ? view.credential.tokenId : 'aucun : renseigner l’accès PBS'}
          {view.credential?.store && <span className="font-sans text-muted"> · droits sur {view.credential.store === '*' ? 'tous les datastores' : view.credential.store} › Hosts</span>}
        </dd>
        <dt className="text-muted">Bases</dt>
        <dd className="text-zinc-300">
          {!view.databases ? <span className="text-amber-400">agent à mettre à jour</span> : view.databases.length ? view.databases.map((k) => databaseKindLabel[k]).join(', ') : 'aucun moteur détecté (PostgreSQL, MongoDB)'}
        </dd>
        {sync && view.jobs.length > 0 && (
          <>
            <dt className="text-muted">Définition</dt>
            <dd className={view.sync?.error ? 'text-red-400' : view.sync?.current ? 'text-emerald-400' : 'text-amber-400'}>
              {view.sync?.error ? `refusée par l'agent : ${view.sync.error}` : view.sync?.current ? "appliquée par l'agent" : "pas encore appliquée par l'agent"}
            </dd>
          </>
        )}
      </dl>
      <p className="mt-2 text-xs text-muted">L'agent planifie et lance les sauvegardes lui-même, même si le hub est arrêté.</p>
    </div>
  );
}

// The agent on one line in the window of a job (it is not edited there); its details on demand.
function AgentLine({ host, view }: { host: Host; view: HostBackupJobs }) {
  const [open, setOpen] = useState(false);
  if (open) return <AgentHeader host={host} view={view} actions={<Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Réduire</Button>} />;
  const client = view.mode === 'native' ? 'client PBS (APT)' : view.mode === 'docker' ? 'client PBS (Docker)' : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-raised/40 px-3 py-2 text-xs text-muted">
      <span className="font-medium text-zinc-100">Agent</span>
      <Badge tone={host.online ? 'ok' : 'warn'}>{host.online ? 'en ligne' : 'hors ligne'}</Badge>
      <span className={clsx(host.agentOutdated && 'text-amber-400')}>{host.agentVersion ? `v${host.agentVersion}` : 'version inconnue'}</span>
      <span className={clsx(!client && 'text-amber-400')}>{client ?? 'client PBS absent'}</span>
      <span className={clsx(view.credential ? 'font-mono' : 'text-amber-400')}>{view.credential ? view.credential.tokenId : 'aucun jeton PBS'}</span>
      <button type="button" className="ml-auto text-emerald-400 hover:underline" onClick={() => setOpen(true)}>Détails</button>
    </div>
  );
}

export type JobTab = 'content' | 'destination' | 'schedule' | 'offsite';
const JOB_TABS: { id: JobTab; label: string }[] = [
  { id: 'content', label: 'Contenu' },
  { id: 'destination', label: 'Destination' },
  { id: 'schedule', label: 'Planning' },
  { id: 'offsite', label: 'Copie déportée' },
];

function JobModal({ host, view, job, open, onClose, tab: initialTab }: { host: Host; view: HostBackupJobs; job: BackupJob | null; open: boolean; onClose: () => void; tab?: JobTab }) {
  const qc = useQueryClient();
  const toast = useToast();
  const initial: BackupJobInput = job
    ? { name: job.name, archives: job.archives, excludes: job.excludes, store: job.store, schedule: job.schedule, connectEveryDays: job.connectEveryDays, enabled: job.enabled, kind: job.kind, database: job.database }
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
  const [tab, setTab] = useState<JobTab>(initialTab ?? 'content');
  // creation: the identifier follows the name until it is typed by hand
  const [idAuto, setIdAuto] = useState(true);
  // group already on the PBS, written by something else: refused by the hub (snapshots would mix)
  const { data: pbs } = useBackups();
  const groupId = `${form.store}/Hosts/host/${form.backupId ?? ''}`;
  const taken = !job && [...(pbs?.groups ?? []), ...(pbs?.orphans ?? [])].find((g) => g.id === groupId && !g.gone && !('source' in g && g.source === 'managed'));
  const [excludes, setExcludes] = useState(initial.excludes.join('\n'));
  const excludeList = excludes.split('\n').map((e) => e.trim()).filter(Boolean);
  // group written by the job: size of its last snapshot (compared with the estimate), its copy
  const group = job ? pbs?.groups.find((g) => g.id === job.group && !g.gone) : undefined;
  const lastSize = group?.size ?? null;
  // copy to the secondary PBS: saved with the job, when changed
  const [offsiteBefore] = useState(() => offsiteForm(group?.offsite));
  const [offsite, setOffsite] = useState(offsiteBefore);
  const remote = pbs?.offsite ?? null;
  const [busy, setBusy] = useState(false);
  // identifier on the PBS, until typed by hand: the name for directories; for a database job, the host, the
  // kind and the databases (the namespace Hosts is shared by all the hosts)
  const autoId = (f: BackupJobInput) => {
    const k = f.kind ?? 'directories';
    if (k === 'directories' || !f.database) return slug(f.name);
    const what = k === 'postgres' && f.database.mode === 'cluster' ? 'cluster' : f.database.databases.join('-') || 'bases';
    return slug(`${host.name}-${k === 'postgres' ? 'pg' : 'mongo'}-${what}`).slice(0, 64).replace(/[-.]+$/, '');
  };
  const set = (patch: Partial<BackupJobInput>) => {
    const next = { ...form, ...patch };
    setForm(!job && idAuto ? { ...next, backupId: autoId(next) } : next);
  };
  const setArchive = (i: number, patch: Partial<BackupJobInput['archives'][number]>) =>
    set({ archives: form.archives.map((a, j) => (j === i ? { ...a, ...patch } : a)) });

  // nextcloud: jobs of the plugin, never edited here (BackupJobEditModal)
  const kind: FormKind = form.kind === 'nextcloud' ? 'directories' : (form.kind ?? 'directories');
  const db = kind === 'postgres' || kind === 'mongodb';
  // the kind is chosen at creation: a database job holds its dumps only
  const setKind = (k: FormKind) =>
    set(k === 'directories' ? { kind: k, database: null, archives: form.archives.length ? form.archives : [{ name: 'home', path: '/home' }] } : { kind: k, database: newDatabase(k) });

  const save = async () => {
    setBusy(true);
    const body = db ? { ...form, archives: [], excludes: [] } : { ...form, database: null, excludes: excludeList };
    if (job) delete body.kind;
    try {
      if (job) await api.updateBackupJob(job.id, body);
      else await api.createBackupJob(host.id, body);
      const o = group && offsiteInput(offsiteBefore, offsite);
      if (group && o) await api.setBackupOffsite(group.id, o);
      qc.invalidateQueries({ queryKey: ['backup-jobs', host.id] });
      // the card of the host lists the groups of the backups
      qc.invalidateQueries({ queryKey: keys.backups });
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
  // the whole setting at a glance, whatever the tab shown
  const when = form.connectEveryDays ? `à la connexion, au plus tous les ${form.connectEveryDays} j` : form.schedule;
  const copyText = !remote || !group || offsiteNotCopiable(group) ? '' : offsite.enabled ? ' · copie déportée' : ' · sans copie';
  const summary = `${KIND_LABEL[kind]} · ${form.store || '—'} › Hosts › ${(job ? job.backupId : form.backupId) || '—'} · ${when}${form.enabled ? '' : ' · désactivée'}${copyText}`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide="screen"
      title={job ? `Sauvegarde ${job.name}` : `Nouvelle sauvegarde de ${host.name}`}
      footer={
        <>
          <span className={clsx('mr-auto min-w-0 self-center truncate text-xs', taken ? 'text-amber-400' : 'text-muted')} title={summary}>
            {taken ? 'Identifiant déjà pris sur le PBS (onglet Destination)' : summary}
          </span>
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" icon={Save} loading={busy} disabled={!!taken} onClick={save}>Enregistrer</Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <AgentLine host={host} view={view} />
        {/* the copy tab: only with a secondary PBS */}
        <VerticalTabs tabs={remote ? JOB_TABS : JOB_TABS.filter((t) => t.id !== 'offsite')} value={tab} onChange={setTab} bodyClassName="pt-4 md:pt-1 md:pl-6">
          {tab === 'offsite' && <OffsiteSettingsTab g={group} remote={remote} value={offsite} onChange={setOffsite} />}
          {tab === 'content' && (
            <section className="space-y-4">
              <label className="block">
                <span className={field}>Type de sauvegarde</span>
                {job ? (
                  <div className="input cursor-default bg-raised/40 text-zinc-400" title="Fixé à la création : ses archives sont d'une autre nature">{KIND_LABEL[kind]}</div>
                ) : (
                  <select className="input" value={kind} onChange={(e) => setKind(e.target.value as FormKind)}>
                    {(Object.keys(KIND_LABEL) as FormKind[]).map((k) => (
                      <option key={k} value={k} disabled={k !== 'directories' && !view.databases}>{KIND_LABEL[k]}</option>
                    ))}
                  </select>
                )}
              </label>
              <label className="block">
                <span className={field}>Nom</span>
                <input
                  className="input"
                  value={form.name}
                  onChange={(e) => set({ name: e.target.value })}
                />
              </label>
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
                  <DirectoryEstimate host={host} view={view} archives={form.archives} excludes={excludeList} lastSize={lastSize} />
                </>
              )}
            </section>
          )}
          {tab === 'destination' && (
            <section className="space-y-4">
              <label className="block">
                <span className={clsx(field, 'flex items-center justify-between')}>
                  Identifiant sur le PBS
                  {!job && (idAuto ? (
                    <span className="font-normal text-zinc-500">{db ? 'déduit du type et des bases' : 'déduit du nom'}</span>
                  ) : (
                    <button
                      type="button"
                      className="font-normal text-emerald-400 hover:underline"
                      onClick={(e) => {
                        e.preventDefault();
                        setIdAuto(true);
                        setForm({ ...form, backupId: autoId(form) });
                      }}
                    >
                      {db ? 'déduire du type et des bases' : 'déduire du nom'}
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
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className={field}>Datastore</span>
                  <select className="input" value={form.store} onChange={(e) => set({ store: e.target.value })}>
                    {!view.datastores.includes(form.store) && <option value={form.store}>{form.store || '—'}</option>}
                    {view.datastores.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                  {view.credential?.store && view.credential.store !== '*' && form.store !== view.credential.store && (
                    <span className="mt-1 block text-xs text-amber-400">
                      Le jeton de cet hôte n'a de droits que sur {view.credential.store} › Hosts : recrée le jeton (Accès au PBS) pour l'étendre à tous les datastores.
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
            </section>
          )}
          {tab === 'schedule' && (
            <section className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-3">
                  <label className="block">
                    <span className={field}>Déclenchement</span>
                    <select className="input" value={form.connectEveryDays ? 'connect' : 'schedule'} onChange={(e) => set({ connectEveryDays: e.target.value === 'connect' ? 3 : null })}>
                      <option value="schedule">À heure fixe</option>
                      <option value="connect">À la connexion de l'agent (poste nomade)</option>
                    </select>
                  </label>
                  {form.connectEveryDays ? (
                    <label className="block">
                      <span className={field}>Au plus une fois tous les (jours)</span>
                      <input type="number" min={1} max={365} className="input" value={form.connectEveryDays} onChange={(e) => set({ connectEveryDays: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })} />
                      <span className="mt-1 block text-xs text-muted">Lancée à la connexion au hub si la dernière sauvegarde réussie date de plus de ce délai ; un échec est retenté à la connexion suivante.</span>
                    </label>
                  ) : (
                    <label className="block">
                      <span className={field}>Quand</span>
                      <input className="input font-mono text-xs" value={form.schedule} onChange={(e) => set({ schedule: e.target.value })} list="backup-presets" />
                      <datalist id="backup-presets">{PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</datalist>
                      <span className="mt-1 block text-xs text-muted">Syntaxe Proxmox : <code>03:00</code>, <code>sun 01:00</code>, <code>mon..fri 22:30</code>, <code>daily</code>.</span>
                    </label>
                  )}
                </div>
                <div>
                  <span className={field}>Fuseau horaire</span>
                  <div className="input cursor-default bg-raised/40 font-mono text-xs text-zinc-400" title="Fixé : fuseau du hub (variable TZ du compose)">
                    {job ? job.timezone : view.timezone}
                  </div>
                </div>
              </div>
              <label className="flex cursor-pointer items-center gap-3">
                <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="h-4 w-4 accent-emerald-500" />
                <span>Active (l'agent la lance {form.connectEveryDays ? 'à la connexion' : "à l'heure prévue"})</span>
              </label>
            </section>
          )}
        </VerticalTabs>
      </div>
    </Modal>
  );
}

// Creation ('new') or edition of one backup job, from the list of the backups of the host.
export function BackupJobEditModal({ host, jobId, tab, onClose }: { host: Host; jobId: string | null; tab?: JobTab; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['backup-jobs', host.id], queryFn: () => api.hostBackupJobs(host.id), enabled: !!jobId });
  if (!jobId) return null;
  const job = jobId === 'new' ? null : data?.jobs.find((j) => j.id === jobId);
  if (!data || job === undefined) {
    return (
      <Modal open onClose={onClose} title="Sauvegarde">
        {data ? <p className="text-sm text-muted">Ce job n'existe plus.</p> : <div className="flex justify-center p-4"><Spinner /></div>}
      </Modal>
    );
  }
  if (job?.plugin) {
    return (
      <Modal open onClose={onClose} title={job.name}>
        <p className="text-sm text-muted">Sauvegarde générée par le plugin Nextcloud AIO : elle se modifie ou se supprime depuis le plugin (bouton Nextcloud de la carte Sauvegardes de l'hôte).</p>
      </Modal>
    );
  }
  return <JobModal key={jobId} host={host} view={data} job={job} open onClose={onClose} tab={tab} />;
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
      <p className="text-xs text-muted">
        Le client tourne en conteneur.{' '}
        <Button size="sm" variant="ghost" icon={Package} loading={busy === 'apt'} disabled={!host.online} onClick={() => install('apt')}>Installer le client APT</Button> (il sera
        alors préféré au conteneur).
      </p>
    ) : null;
  }
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-100">
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

// Agent that runs the backups of the host: its PBS client and its token (window opened from the
// Sauvegardes card of the host page; the jobs are in the card).
export function ManagedBackupsModal({ host, open, onClose }: { host: Host; open: boolean; onClose: () => void }) {
  const { data: backups } = useBackups();
  const { canManage } = useMe();
  const { data } = useQuery({ queryKey: ['backup-jobs', host.id], queryFn: () => api.hostBackupJobs(host.id), enabled: !!backups?.enabled && open });
  const [credential, setCredential] = useState(false);
  if (!backups?.enabled || !open) return null;
  const title = `Agent de sauvegarde de ${host.name}`;
  if (!data) {
    return (
      <Modal open onClose={onClose} wide="xl" title={title}>
        <div className="flex justify-center p-4"><Spinner /></div>
      </Modal>
    );
  }
  return (
    <Modal open onClose={onClose} wide="xl" title={title}>
      <div className="space-y-3">
        <AgentHeader
          host={host}
          view={data}
          sync
          actions={canManage && <Button size="sm" variant="ghost" icon={KeyRound} onClick={() => setCredential(true)} title="Jeton du PBS de cet hôte">Accès PBS</Button>}
        />
        {data.supported && (!data.mode || (data.mode === 'docker' && data.install.includes('apt'))) && (
          <ClientInstall host={host} mode={data.mode} options={data.install} canManage={canManage} />
        )}
      </div>
      {canManage && <CredentialModal key={String(credential)} host={host} view={data} open={credential} onClose={() => setCredential(false)} />}
    </Modal>
  );
}
