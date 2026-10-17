import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { Cloud, Loader2, Play, RefreshCw } from 'lucide-react';
import { api, type BackupGroup, type BackupOffsite, type BackupsView } from '../lib/api';
import { useMe } from '../lib/auth';
import {
  OFFSITE_DEFAULTS,
  type OffsiteForm,
  backupKind,
  databaseJobText,
  formatBytes,
  hoursLabel,
  offsiteNotCopiable,
  rhythmLabel,
  scheduleLabel,
  thresholdSourceLabel,
} from '../lib/backups';
import { dateTime, timeAgo } from '../lib/format';
import { useToast } from '../lib/toast';
import { Badge, Button, CopyField } from './ui';

// Detail of a backup and of its copy to the secondary PBS (hub/src/offsite.ts): pill of every backup
// (host card, backups page), state of the copy in the table, settings in the tab of the window of a
// backup. A copy run here is followed as a job (console of the host page, Activité).

type Remote = NonNullable<BackupsView['offsite']>;
type State = NonNullable<BackupOffsite['state']> | 'running';

const stateMeta: Record<State, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral'; cloud: string }> = {
  ok: { label: 'à jour', tone: 'ok', cloud: 'text-sky-400' },
  pending: { label: 'jamais copiée', tone: 'neutral', cloud: 'text-zinc-500' },
  late: { label: 'en retard', tone: 'warn', cloud: 'text-amber-400' },
  failed: { label: 'en échec', tone: 'bad', cloud: 'text-red-400' },
  running: { label: 'copie en cours', tone: 'neutral', cloud: 'animate-pulse text-sky-300' },
};

const copyState = (o: BackupOffsite): State => (o.running ? 'running' : (o.state ?? 'pending'));

// Runs the copy now: its job opens in the console of the page (onStarted), or is announced.
function useRunCopy(g: BackupGroup, onStarted?: (jobId: string) => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.runBackupOffsite(g.id);
      if (onStarted && r.jobId) onStarted(r.jobId);
      else toast.success('Copie déportée lancée : suivie dans Activité');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

function UsageBar({ remote, size }: { remote: Remote; size?: number | null }) {
  const u = remote.usage;
  if (!u) return null;
  const pct = u.total ? Math.round((u.used / u.total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-raised">
        <div className={clsx('h-full rounded-full', pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-400' : 'bg-sky-400')} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-xs text-muted">
        {remote.store} : {formatBytes(u.used)} utilisés, {formatBytes(u.avail)} libres{size != null && ` · dernier snapshot copié : ${formatBytes(size)}`}
      </div>
    </div>
  );
}

// Whether the group can be copied now (namespace on the secondary...), asked as soon as the copy is about
// to be enabled.
function useOffsiteCheck(g: BackupGroup, enabled: boolean) {
  return useQuery({ queryKey: ['offsite-check', g.id], queryFn: () => api.checkBackupOffsite(g.id), enabled, staleTime: 0, gcTime: 0 });
}

function OffsiteCheckMessage({ check }: { check: ReturnType<typeof useOffsiteCheck> }) {
  if (check.isPending) return <p className="text-xs text-muted">Vérification du PBS de secours…</p>;
  if (check.error) return <p className="text-xs text-red-400">Vérification impossible : {(check.error as Error).message}</p>;
  const c = check.data;
  if (c.ok) return <p className="text-xs text-emerald-400">Copiable : le PBS de secours est prêt pour cette sauvegarde.</p>;
  const retry = (
    <Button size="sm" icon={RefreshCw} loading={check.isFetching} onClick={() => check.refetch()}>
      Revérifier
    </Button>
  );
  if (!c.namespace) {
    return (
      <div className="flex items-center gap-2 text-xs text-red-400">
        <span className="flex-1">Non copiable : {c.error}</span>
        {retry}
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-100">
      <p>
        Non copiable pour l’instant : le namespace <span className="font-mono">{c.namespace.ns}</span> n’existe pas sur le datastore{' '}
        <span className="font-mono">{c.namespace.store}</span> du PBS de secours, et le jeton du hub ne peut pas le créer. À lancer dans un shell du PBS de secours, puis
        revérifier :
      </p>
      <CopyField value={c.namespace.commands.join('\n')} multiline={c.namespace.commands.length > 1} />
      {retry}
    </div>
  );
}

// Copy not enabled: enabled from here with the default hour, once the secondary is ready for it.
function OffsiteEnable({ g }: { g: BackupGroup }) {
  const toast = useToast();
  const check = useOffsiteCheck(g, true);
  const [busy, setBusy] = useState(false);
  const enable = async () => {
    setBusy(true);
    try {
      await api.setBackupOffsite(g.id, { enabled: true });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <OffsiteCheckMessage check={check} />
      <Button size="sm" variant="primary" icon={Cloud} loading={busy} disabled={!check.data?.ok} onClick={enable}>
        Activer la copie (tous les jours à {OFFSITE_DEFAULTS.schedule})
      </Button>
    </div>
  );
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 text-zinc-300">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const section = 'text-[11px] font-semibold uppercase tracking-wide text-zinc-400';

// The backup (where, last, schedule, delay before an alert) and its copy (state, last and next copy, room,
// run it now).
function BackupDetail({ g, remote, onStarted }: { g: BackupGroup; remote: BackupsView['offsite']; onStarted?: (jobId: string) => void }) {
  const { canManage, canWrite } = useMe();
  const { busy, run } = useRunCopy(g, onStarted);
  const rhythm = rhythmLabel(g.interval);
  const schedule = g.pve ? `Proxmox ${g.pve.cluster} · ${scheduleLabel(g)}` : g.managed || g.ha ? scheduleLabel(g) : rhythm ? `rythme ${rhythm} (appris)` : 'rythme inconnu';
  const why = offsiteNotCopiable(g);
  const o = g.offsite;
  const state = o?.enabled ? copyState(o) : null;
  return (
    <div className="space-y-3 text-xs">
      <div className="space-y-1.5">
        <div className={section}>Sauvegarde</div>
        <Rows
          rows={[
            ['Type', `${backupKind(g).label} · ${g.store}${g.ns ? ` › ${g.ns}` : ''}`],
            [
              'Dernière',
              <>
                <span title={dateTime(g.lastBackup)}>{g.lastBackup ? timeAgo(g.lastBackup) : 'jamais'}</span> · {formatBytes(g.size)} · {g.count} snapshot{g.count > 1 ? 's' : ''}
                {g.verify === 'ok' && <span className="text-emerald-400"> · vérifiée</span>}
                {g.verify === 'failed' && <span className="text-red-400"> · vérification en échec</span>}
              </>,
            ],
            ['Planification', schedule],
            ['Alerte', g.threshold === null ? 'aucun rythme connu : pas de retard signalé' : `en retard après ${hoursLabel(g.threshold)} (${thresholdSourceLabel[g.thresholdSource]})`],
            ...(g.managed && databaseJobText(g.managed) ? ([['Bases', databaseJobText(g.managed)]] as [string, ReactNode][]) : []),
          ]}
        />
      </div>
      {remote && (
        <div className="space-y-1.5 border-t border-line pt-2.5">
          <div className="flex items-center gap-2">
            <span className={section}>Copie déportée</span>
            <span className="text-muted">{remote.host} › {remote.store}</span>
            {state && canWrite && (
              <Button
                size="sm"
                variant="ghost"
                icon={state === 'running' ? Loader2 : Play}
                className={clsx('ml-auto h-6 px-1.5', state === 'running' && '[&>svg]:animate-spin')}
                loading={busy}
                disabled={state === 'running'}
                title={state === 'running' ? 'Copie en cours (suivie dans Activité)' : 'Lancer la copie maintenant'}
                onClick={run}
              />
            )}
          </div>
          {why ? (
            <p className="text-muted">Non copiable : {why}.</p>
          ) : !o?.enabled ? (
            <>
              <p className="text-muted">Non activée.</p>
              {canManage && <OffsiteEnable g={g} />}
            </>
          ) : (
            <>
              <Rows
                rows={[
                  ['État', <Badge key="s" tone={stateMeta[state!].tone}>{stateMeta[state!].label}</Badge>],
                  ['Dernière', <span key="l" title={o.lastBackup ? dateTime(o.lastBackup) : undefined}>{o.lastBackup ? `snapshot copié ${timeAgo(o.lastBackup)}` : 'aucun snapshot copié'}</span>],
                  ['Prochaine', `${o.nextRun ? dateTime(o.nextRun) : 'inconnue'} · ${o.scheduleText}${o.rateIn ? ` · ≤ ${o.rateIn}/s` : ''}`],
                ]}
              />
              {o.error && <div className="text-red-400">Job de copie non appliqué : {o.error}</div>}
              {o.lastRun && !o.lastRun.ok && <div className="text-red-400" title={dateTime(o.lastRun.end)}>Dernière copie en échec {timeAgo(o.lastRun.end)} : {o.lastRun.error}</div>}
              {o.verify === 'failed' && <div className="text-red-400">Vérification de la copie en échec</div>}
              <UsageBar remote={remote} size={o.size} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Floating window anchored under its button (fixed: not cut by a scrolling table); closed by a click
// outside, Escape, a scroll or a resize.
function Popover({ anchor, onClose, children }: { anchor: HTMLElement; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = ref.current?.offsetWidth ?? 360;
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) });
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);
  return (
    <div
      ref={ref}
      className="fixed z-30 w-96 max-w-[calc(100vw-16px)] rounded-md border border-line bg-panel px-3.5 py-3 shadow-2xl shadow-black/60"
      style={pos ?? { top: -9999, left: -9999 }}
    >
      {children}
    </div>
  );
}

// "détail" pill of every backup, next to its badges: a click opens the detail of the backup and of its
// copy; the cloud gives the state of the copy when there is one (pulsing while it runs).
export function DetailPill({ g, remote, onStarted }: { g: BackupGroup; remote: BackupsView['offsite']; onStarted?: (jobId: string) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const o = g.offsite;
  const state = remote && o?.enabled && !offsiteNotCopiable(g) ? copyState(o) : null;
  return (
    <>
      <button
        type="button"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        title={state ? `Détail · copie déportée : ${stateMeta[state].label}` : 'Détail de la sauvegarde'}
        className={clsx(
          'inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
          anchor ? 'border-zinc-500 text-zinc-100' : 'border-line text-zinc-400 hover:text-zinc-200',
        )}
      >
        détail
        {state && <Cloud className={clsx('h-3.5 w-3.5', stateMeta[state].cloud)} />}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <BackupDetail g={g} remote={remote} onStarted={onStarted} />
        </Popover>
      )}
    </>
  );
}

// Column of the backups page: state of the copy and its last one (the detail and the run: the pill).
export function OffsiteCell({ g }: { g: BackupGroup }) {
  const why = offsiteNotCopiable(g);
  if (why) return <span className="text-xs text-zinc-500" title={why}>— non copiable</span>;
  const o = g.offsite;
  if (!o?.enabled) return <span className="text-xs text-zinc-500">non copiée</span>;
  const state = copyState(o);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={stateMeta[state].tone}>
          {state === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
          {stateMeta[state].label}
        </Badge>
        {o.lastBackup && state !== 'running' && <span className="text-xs text-muted" title={dateTime(o.lastBackup)}>{timeAgo(o.lastBackup)}</span>}
      </div>
      {o.error && <div className="text-xs text-red-400">{o.error}</div>}
    </div>
  );
}

// Settings of the copy in the window of a backup, saved with the backup (offsiteInput): enabled, hour,
// limit of rate. One snapshot per run, the last one (hub TRANSFER_LAST).
export function OffsiteSettingsTab({ g, remote, value, onChange }: { g: BackupGroup | undefined; remote: BackupsView['offsite']; value: OffsiteForm; onChange: (f: OffsiteForm) => void }) {
  const field = 'mb-1.5 block text-xs font-medium text-muted';
  if (!remote) return <p className="text-sm text-muted">PBS de secours non configuré ou désactivé (Paramètres › Sauvegardes).</p>;
  const why = !g ? 'sauvegarde pas encore écrite sur le PBS' : offsiteNotCopiable(g);
  if (why || !g) return <p className="text-sm text-muted">Copie impossible pour l’instant : {why}. Elle se règle une fois la première sauvegarde faite.</p>;
  const set = (patch: Partial<OffsiteForm>) => onChange({ ...value, ...patch });
  return (
    <section className="space-y-4">
      <label className="flex cursor-pointer items-center gap-3">
        <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="h-4 w-4 accent-emerald-500" />
        <span>
          <span className="font-medium text-zinc-100">Copier vers le PBS de secours</span> <span className="text-muted">{remote.host} › {remote.store}</span>
        </span>
      </label>
      <p className="-mt-2 text-xs text-muted">À chaque copie, la dernière sauvegarde est envoyée ; le PBS de secours garde les siennes selon sa propre rétention.</p>
      {g.offsite?.enabled && <OffsiteStateLine o={g.offsite} />}
      {/* enabled here, not saved yet: can it be copied (namespace on the secondary...) */}
      {value.enabled && !g.offsite?.enabled && <OffsiteTabCheck g={g} />}
      {value.enabled ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={field}>Heure de la copie</span>
            <input className="input font-mono text-xs" value={value.schedule} onChange={(e) => set({ schedule: e.target.value })} list="offsite-presets" />
            <datalist id="offsite-presets">
              <option value="06:00">Tous les jours à 06:00</option>
              <option value="12:00">Tous les jours à 12:00</option>
              <option value="sun 08:00">Le dimanche à 08:00</option>
            </datalist>
            <span className="mt-1 block text-xs text-muted">Syntaxe Proxmox, fuseau du PBS de secours.</span>
          </label>
          <label className="block">
            <span className={field}>Limite de débit</span>
            <input className="input font-mono text-xs" value={value.rateIn} onChange={(e) => set({ rateIn: e.target.value })} placeholder="sans limite" />
            <span className="mt-1 block text-xs text-muted">ex. 10MiB ; vide : plafond global du PBS.</span>
          </label>
        </div>
      ) : (
        g.offsite?.enabled && <p className="text-xs text-muted">Désactivée à l’enregistrement : le job de copie est retiré du PBS de secours, les snapshots déjà copiés y restent.</p>
      )}
      <div>
        <span className={field}>Place sur le PBS de secours</span>
        <UsageBar remote={remote} size={g.offsite?.size} />
      </div>
    </section>
  );
}

function OffsiteTabCheck({ g }: { g: BackupGroup }) {
  return <OffsiteCheckMessage check={useOffsiteCheck(g, true)} />;
}

function OffsiteStateLine({ o }: { o: BackupOffsite }) {
  const state = copyState(o);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={stateMeta[state].tone}>{stateMeta[state].label}</Badge>
        <span className="text-muted">
          {o.lastBackup ? `dernier snapshot copié ${timeAgo(o.lastBackup)}` : 'aucun snapshot copié'}
          {o.nextRun ? ` · prochaine copie ${dateTime(o.nextRun)}` : ''}
        </span>
      </div>
      {o.error && <div className="text-xs text-red-400">Job de copie non appliqué : {o.error}</div>}
      {o.lastRun && !o.lastRun.ok && <div className="text-xs text-red-400">Dernière copie en échec {timeAgo(o.lastRun.end)} : {o.lastRun.error}</div>}
    </div>
  );
}
