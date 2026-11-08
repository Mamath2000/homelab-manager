import { useState } from 'react';
import clsx from 'clsx';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Check, DatabaseBackup, HelpCircle, Lock, Search, ShieldCheck, X } from 'lucide-react';
import { api, type DbKind, type DbRestoreCheck, type DbRestoreTarget, type PbsMountSource } from '../lib/api';
import { formatBytes } from '../lib/backups';
import { dateTime } from '../lib/format';
import { stepStates } from '../lib/steps';
import { useToast } from '../lib/toast';
import { Step, Steps } from './PbsDialog';
import { Badge, Button, Modal, Spinner } from './ui';

// Restore of a database dump into a NEW database on another host (hub/src/dbRestore.ts, #210). Same flow as the
// mount of a snapshot (PbsMount.tsx): snapshot, dump, target (host and container), then the new name, the checks
// and the start. Never overwrites: a name that exists is refused. The restore is a job followed in Activité.

const snapshotDate = (t: number) => dateTime(t * 1000);
const kindLabel: Record<DbKind, string> = { mongodb: 'MongoDB', postgres: 'PostgreSQL' };
const SOURCES: PbsMountSource[] = ['main', 'offsite'];
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,47}$/;

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

const listCls = 'min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1';

function Loading({ q }: { q: { isPending: boolean; error: unknown } }) {
  if (q.error) return <p className="text-xs text-red-400">{(q.error as Error).message}</p>;
  return q.isPending ? <Spinner className="h-4 w-4" /> : null;
}

// Columns of the table of the hosts left out: one per prerequisite of a target.
type CheckKey = keyof NonNullable<DbRestoreTarget['checks']>;
const checkColumns = (kind: DbKind): { key: CheckKey; label: string; title: string }[] => [
  { key: 'online', label: 'En ligne', title: 'Agent connecté' },
  { key: 'agent', label: 'Agent', title: 'Agent à jour : il sait restaurer une base' },
  { key: 'os', label: 'OS', title: 'Système qui peut monter : Linux avec systemd (ni Windows, ni WSL, ni Home Assistant OS)' },
  { key: 'fuse', label: 'FUSE', title: '/dev/fuse présent (conteneur LXC : fonctionnalité « FUSE » de Proxmox)' },
  { key: 'pbsClient', label: 'Client PBS', title: 'proxmox-backup-client installé nativement' },
  { key: 'engine', label: kindLabel[kind], title: kind === 'mongodb' ? 'Conteneur MongoDB avec mongorestore' : 'Serveur PostgreSQL local ou conteneur PostgreSQL' },
];

// ✓ met, ✗ not met, ? unknown; the note in the tooltip
function CheckMark({ item }: { item?: { ok: boolean | null; note: string | null } }) {
  if (!item || item.ok === null)
    return (
      <span title={item?.note ?? 'inconnu'} className="inline-flex">
        <HelpCircle className="h-4 w-4 text-muted" aria-label="inconnu" />
      </span>
    );
  return item.ok ? (
    <span title={item.note ?? 'OK'} className="inline-flex">
      <Check className="h-4 w-4 text-emerald-400" aria-label="OK" />
    </span>
  ) : (
    <span title={item.note ?? 'manquant'} className="inline-flex">
      <X className="h-4 w-4 text-red-400" aria-label="manquant" />
    </span>
  );
}

export function DbRestoreDialog({ open, groupId, onClose }: { open: boolean; groupId: string | null; onClose: () => void }) {
  const toast = useToast();
  const [time, setTime] = useState<number | null>(null);
  const [archive, setArchive] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [container, setContainer] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authSource, setAuthSource] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [check, setCheck] = useState<{ key: string; r: DbRestoreCheck } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [excludedQ, setExcludedQ] = useState('');

  // the PBS that holds the backup: the main one first
  const groups = useQueries({ queries: SOURCES.map((s) => ({ queryKey: ['db-restore', s, 'groups'], queryFn: () => api.dbRestoreGroups(s), enabled: open, retry: false })) });
  const idx = groups.findIndex((q) => q.data?.some((g) => g.id === groupId));
  const source: PbsMountSource = idx >= 0 ? SOURCES[idx] : 'main';
  const group = idx >= 0 ? groups[idx].data?.find((g) => g.id === groupId) : undefined;
  const kind: DbKind = group?.kind ?? 'mongodb';

  const snaps = useQuery({ queryKey: ['db-restore', source, 'snapshots', groupId], queryFn: () => api.dbRestoreSnapshots(source, groupId!), enabled: open && !!group, staleTime: 0 });
  const targets = useQuery({ queryKey: ['db-restore', 'targets', kind], queryFn: () => api.dbRestoreTargets(kind), enabled: open && !!archive, staleTime: 0, gcTime: 0 });
  const overview = useQuery({ queryKey: ['pbs-mount'], queryFn: api.pbsMount, enabled: open });

  const snap = snaps.data?.find((s) => s.time === time);
  const arch = snap?.archives.find((a) => a.name === archive);
  // only the hosts that can receive the dump are offered; the others, with why, are one click away
  const valid = targets.data?.filter((h) => h.containers.length > 0) ?? [];
  const excluded = targets.data?.filter((h) => h.containers.length === 0) ?? [];
  // search in the window of the hosts left out: name or reason
  const eq = excludedQ.trim().toLowerCase();
  const excludedShown = eq ? excluded.filter((h) => h.name.toLowerCase().includes(eq) || (h.reason ?? '').toLowerCase().includes(eq)) : excluded;
  const host = valid.find((h) => h.id === hostId);
  const cont = host?.containers.find((c) => c.container === container);
  const target = name ?? (arch ? `${arch.database}_restore` : '');
  const nameOk = NAME_RE.test(target);
  // PostgreSQL in a container: the password is enough (the superuser of the container by default)
  const authOk = !!cont && (!cont.needsAuth || (kind === 'postgres' ? !!password : !!username && !!password));

  const input = () => ({
    kind,
    hostId: hostId!,
    container: container!,
    target,
    ...(cont?.jobId
      ? { jobId: cont.jobId }
      : kind === 'postgres'
        ? { ...(cont?.needsAuth && username ? { username } : {}), ...(cont?.needsAuth && password ? { password } : {}) }
        : username
          ? { username, password, ...(authSource ? { authSource } : {}) }
          : {}),
  });
  // a check holds for the inputs it was made with only
  const key = JSON.stringify([hostId, container, cont?.jobId, username, password, authSource, target, archive, time]);
  const checked = check?.key === key ? check.r : null;
  const active = overview.data?.active;

  const states = stepStates([time !== null, !!archive && !!arch?.supported, !!cont && authOk, !!checked?.ok]);

  const reset = () => {
    setTime(null);
    setArchive(null);
    setHostId(null);
    setContainer(null);
    setUsername('');
    setPassword('');
    setAuthSource('');
    setName(null);
    setCheck(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const verify = async () => {
    setBusy(true);
    try {
      setCheck({ key, r: await api.dbRestoreCheck({ ...input(), ...(arch?.size ? { size: arch.size } : {}) }) });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!groupId || time === null || !archive || !checked?.ok) return;
    setBusy(true);
    try {
      await api.dbRestoreStart({ ...input(), source, groupId, time, archive });
      toast.success(`Restauration de ${arch?.database} vers ${target} lancée : suivi dans Activité`);
      close();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} wide="screen" wider fixed title={`Restaurer une base ${kindLabel[kind]} dans une nouvelle base`}>
      {active && (
        <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Une sauvegarde est déjà montée sur {active.hostName} : un seul montage (ou restauration) à la fois, la démonter d’abord.
        </p>
      )}
      <Steps fill>
        <Step n={1} title="Snapshot" state={states[0]} intro={group ? <>Sauvegarde <b className="text-zinc-200">{group.label}</b>, lue à l’instant sur le {source === 'offsite' ? 'PBS de secours' : 'PBS principal'}.</> : 'Sauvegarde de base choisie dans la page Sauvegardes.'}>
          {groups.every((q) => q.isPending) ? <Spinner className="h-4 w-4" /> : !group && <p className="text-xs text-amber-300">Sauvegarde de base introuvable sur les PBS.</p>}
          {group && <Loading q={snaps} />}
          <div className={listCls}>
            {snaps.data?.map((s) => (
              <Choice key={s.time} selected={s.time === time} onClick={() => { setTime(s.time); setArchive(null); setCheck(null); }}>
                <span className="flex items-center gap-2">
                  <span className="font-medium">{snapshotDate(s.time)}</span>
                  {s.verify === 'ok' && <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-label="vérifié" />}
                  {s.verify === 'failed' && <Badge tone="bad">vérification en échec</Badge>}
                </span>
                <span className="block text-[11px] text-muted">{s.archives.length} base{s.archives.length > 1 ? 's' : ''} · {formatBytes(s.size)}</span>
              </Choice>
            ))}
            {snaps.data && !snaps.data.length && <p className="text-xs text-muted">Aucun snapshot avec un dump de base.</p>}
          </div>
        </Step>

        <Step n={2} title="Dump" state={states[1]} intro="Une archive par base sauvegardée.">
          <div className={listCls}>
            {snap?.archives.map((a) => (
              <Choice key={a.name} selected={a.name === archive} disabled={a.encrypted || !a.supported} onClick={() => { setArchive(a.name); setName(null); setCheck(null); }}>
                <span className="flex items-center gap-2 font-mono">
                  {a.database}
                  {a.encrypted && <Lock className="h-3.5 w-3.5" aria-label="chiffrée" />}
                </span>
                <span className="block text-[11px] text-muted">
                  {a.encrypted ? 'chiffrée : non montable sans sa clé' : !a.supported ? `restauration ${kindLabel[a.kind]} pas encore disponible` : formatBytes(a.size)}
                </span>
              </Choice>
            ))}
          </div>
        </Step>

        <Step n={3} title="Cible" state={states[2]} intro={kind === 'postgres' ? 'Hôtes pouvant recevoir le dump : agent à jour, montage possible et serveur PostgreSQL local ou conteneur PostgreSQL (image officielle, PostGIS ou TimescaleDB).' : 'Hôtes pouvant recevoir le dump : agent à jour, montage possible et conteneur MongoDB (mongorestore). Les identifiants du job de sauvegarde de l’hôte sont réutilisés.'}>
          {archive && <Loading q={targets} />}
          <div className={listCls}>
            {valid.map((h) => (
              <div key={h.id} className="space-y-1">
                <p className="text-xs font-medium text-zinc-200">{h.name}</p>
                {h.containers.map((c) => (
                  <Choice key={c.container || 'local'} selected={h.id === hostId && c.container === container} onClick={() => { setHostId(h.id); setContainer(c.container); setCheck(null); }}>
                    <span className="font-mono">{kind === 'postgres' && !c.container ? 'Serveur PostgreSQL local' : c.container}</span>
                    <span className="block text-[11px] text-muted">
                      {c.image}
                      {kind === 'postgres' && !c.container ? ' · authentification locale (utilisateur postgres)' : kind === 'postgres' ? (c.needsAuth ? ' · mot de passe à saisir' : ' · accès local du conteneur, sans mot de passe') : c.jobId ? ` · identifiants du job « ${c.jobName} »` : c.needsAuth ? ' · identifiants à saisir' : ' · sans authentification'}
                    </span>
                  </Choice>
                ))}
              </div>
            ))}
            {targets.data && !valid.length && <p className="text-xs text-muted">Aucune cible valide.</p>}
          </div>
          {excluded.length > 0 && (
            <button type="button" onClick={() => setShowExcluded(true)} className="self-start text-[11px] text-muted underline decoration-dotted hover:text-zinc-300">
              {excluded.length} hôte{excluded.length > 1 ? 's' : ''} écarté{excluded.length > 1 ? 's' : ''} : voir pourquoi
            </button>
          )}
          {cont && cont.needsAuth && (
            <div className="space-y-1.5 border-t border-line pt-2">
              <p className="text-[11px] text-muted">
                {kind === 'postgres' ? 'Ce PostgreSQL demande un mot de passe (utilisateur : celui du conteneur si vide).' : 'Ce MongoDB demande une authentification.'} Le mot de passe n’est jamais conservé.
              </p>
              <input className="input h-8 w-full py-1 text-xs" placeholder={kind === 'postgres' ? 'Utilisateur (POSTGRES_USER du conteneur)' : 'Utilisateur'} value={username} onChange={(e) => { setUsername(e.target.value.trim()); setCheck(null); }} autoComplete="off" spellCheck={false} />
              <input className="input h-8 w-full py-1 text-xs" type="password" placeholder="Mot de passe" value={password} onChange={(e) => { setPassword(e.target.value); setCheck(null); }} autoComplete="new-password" />
              {kind === 'mongodb' && <input className="input h-8 w-full py-1 text-xs" placeholder="authSource (admin)" value={authSource} onChange={(e) => { setAuthSource(e.target.value.trim()); setCheck(null); }} spellCheck={false} />}
            </div>
          )}
        </Step>

        <Step
          n={4}
          title="Nouvelle base"
          state={states[3]}
          intro="Nom de la nouvelle base, vérifié sur la cible : accès, nom libre, place. Rien n’est jamais écrasé."
          footer={
            <div className="flex w-full flex-col gap-2">
              <Button icon={ShieldCheck} loading={busy && !checked} disabled={!cont || !authOk || !nameOk || !arch?.supported} onClick={verify} className="w-full">
                Vérifier
              </Button>
              <Button variant="primary" icon={DatabaseBackup} loading={busy && !!checked} disabled={!!active || !checked?.ok} onClick={start} className="w-full">
                Restaurer
              </Button>
            </div>
          }
        >
          <input
            className={clsx('input h-8 w-full py-1 font-mono text-xs', !nameOk && 'border-red-500/60')}
            value={target}
            onChange={(e) => { setName(e.target.value.trim()); setCheck(null); }}
            placeholder="nom de la nouvelle base"
            spellCheck={false}
            disabled={!arch}
          />
          {!nameOk && arch && <p className="text-xs text-red-400">Nom invalide : lettres, chiffres, _ et - (48 max).</p>}
          {checked && (
            <div className="space-y-1 text-xs">
              {checked.error ? <p className="text-red-400">{checked.error}</p> : <p className="text-emerald-400">Accès OK, « {target} » est libre.</p>}
              <p className="text-muted">
                {checked.tools}
                {checked.databases.length ? ` · ${checked.databases.length} base${checked.databases.length > 1 ? 's' : ''} présente${checked.databases.length > 1 ? 's' : ''}` : ''}
                {checked.free >= 0 ? ` · ${formatBytes(checked.free)} libres` : ''}
              </p>
            </div>
          )}
        </Step>
      </Steps>
      <Modal open={showExcluded} onClose={() => { setShowExcluded(false); setExcludedQ(''); }} wide="screen" fixed title={`Hôtes écartés (${excluded.length})`}>
        <div className="flex h-full flex-col gap-3">
          <label className="relative block shrink-0">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted" />
            <input className="input pl-8" placeholder="Hôte ou raison…" value={excludedQ} onChange={(e) => setExcludedQ(e.target.value)} autoFocus />
          </label>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {excludedShown.length === 0 ? (
              <p className="text-sm text-muted">Aucun hôte pour cette recherche.</p>
            ) : (
              <table className="w-full table-fixed text-left text-sm">
                <thead className="sticky top-0 z-10 bg-panel text-[11px] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="w-[34%] py-2 pr-4 font-medium">Hôte</th>
                    {checkColumns(kind).map((col) => (
                      <th key={col.key} className="px-1 py-2 text-center font-medium" title={col.title}>
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {excludedShown.map((h) => (
                    <tr key={h.id} className="align-top">
                      <td className="py-2 pr-4">
                        <span className="block truncate font-medium text-zinc-200" title={h.name}>
                          {h.name}
                        </span>
                        {h.reason && <span className="block text-[11px] text-red-400/90">{h.reason}</span>}
                      </td>
                      {checkColumns(kind).map((col) => (
                        <td key={col.key} className="px-1 py-2 text-center">
                          <CheckMark item={h.checks?.[col.key]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Modal>
    </Modal>
  );
}
