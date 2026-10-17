import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Cloud, Play, Plus, Power, Settings2 } from 'lucide-react';
import { api, type BackupGroup, type BackupOffsite, type BackupOffsiteInput, type BackupsView } from '../lib/api';
import { useMe } from '../lib/auth';
import { OFFSITE_DEFAULTS, type OffsiteForm, formatBytes, offsiteNotCopiable } from '../lib/backups';
import { dateTime, timeAgo } from '../lib/format';
import { useToast } from '../lib/toast';
import { Badge, Button } from './ui';

// Copy of a backup to the secondary PBS (hub/src/offsite.ts): pill and detail (host card, backups page),
// settings (tab of the window of a backup). Enable, disable and run are single actions: no confirmation.

type Remote = NonNullable<BackupsView['offsite']>;
type State = NonNullable<BackupOffsite['state']>;

const offsiteStateMeta: Record<State, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral'; pill: string }> = {
  ok: { label: 'à jour', tone: 'ok', pill: 'border-sky-400/45 bg-sky-400/10 text-sky-300' },
  pending: { label: 'en attente', tone: 'neutral', pill: 'border-line text-zinc-400' },
  late: { label: 'en retard', tone: 'warn', pill: 'border-amber-400/45 text-amber-300' },
  failed: { label: 'en échec', tone: 'bad', pill: 'border-red-400/45 text-red-300' },
};

// "3 h", "2 j", "12 min"
function shortAgo(t: number) {
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} j`;
}

const transferText = (n: number | null) => (n ? (n > 1 ? `${n} derniers snapshots` : 'dernier snapshot') : 'tous les snapshots');

function offsiteSummary(o: BackupOffsite) {
  return [transferText(o.transferLast), o.scheduleText, o.rateIn && `≤ ${o.rateIn}/s`].filter(Boolean).join(' · ');
}

// Actions of a copy, with their busy state; errors in a toast.
function useOffsiteActions(g: BackupGroup) {
  const toast = useToast();
  const [busy, setBusy] = useState<'run' | 'set' | null>(null);
  const set = async (o: BackupOffsiteInput) => {
    setBusy('set');
    try {
      await api.setBackupOffsite(g.id, o);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const run = async () => {
    setBusy('run');
    try {
      await api.runBackupOffsite(g.id);
      toast.success('Copie déportée lancée : son résultat arrive au prochain relevé du PBS de secours');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, set, run };
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

// What the copy is and the actions on it (content of the floating detail).
function OffsiteDetail({ g, remote, onSettings }: { g: BackupGroup; remote: Remote; onSettings?: () => void }) {
  const { canManage, canWrite } = useMe();
  const { busy, set, run } = useOffsiteActions(g);
  const o = g.offsite;
  const where = `${remote.host} › ${remote.store}`;
  if (!o?.enabled) {
    return (
      <div className="space-y-2 text-xs">
        <div><span className="font-medium text-zinc-100">Copie déportée</span> <span className="text-muted">· non activée</span></div>
        <p className="text-muted">Copier cette sauvegarde vers {where} ({transferText(OFFSITE_DEFAULTS.transferLast)}, tous les jours à {OFFSITE_DEFAULTS.schedule}).</p>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" icon={Cloud} loading={busy === 'set'} onClick={() => set({ enabled: true })}>Activer la copie</Button>
            {onSettings && <Button size="sm" icon={Settings2} onClick={onSettings}>Régler…</Button>}
          </div>
        )}
      </div>
    );
  }
  const meta = offsiteStateMeta[o.state ?? 'pending'];
  return (
    <div className="space-y-2 text-xs">
      <div><span className="font-medium text-zinc-100">Copie déportée</span> <span className="text-muted">· {where}</span></div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <span className="text-muted" title={o.lastBackup ? dateTime(o.lastBackup) : undefined}>
          {o.lastBackup ? `dernier snapshot copié ${timeAgo(o.lastBackup)}` : 'aucun snapshot copié'}
          {o.count ? ` · ${o.count} sur le PBS de secours` : ''}
        </span>
      </div>
      <div className="text-muted">
        {o.nextRun ? `Prochaine copie ${dateTime(o.nextRun)}` : 'Prochaine copie inconnue'} · {offsiteSummary(o)}
      </div>
      {o.error && <div className="text-red-400">Job de copie non appliqué : {o.error}</div>}
      {o.lastRun && !o.lastRun.ok && <div className="text-red-400" title={dateTime(o.lastRun.end)}>Dernière copie en échec {timeAgo(o.lastRun.end)} : {o.lastRun.error}</div>}
      {o.verify === 'failed' && <div className="text-red-400">Vérification de la copie en échec</div>}
      <UsageBar remote={remote} size={o.size} />
      <div className="flex flex-wrap gap-2 pt-1">
        {canWrite && <Button size="sm" icon={Play} loading={busy === 'run'} onClick={run}>Lancer maintenant</Button>}
        {canManage && onSettings && <Button size="sm" icon={Settings2} onClick={onSettings}>Régler…</Button>}
        {canManage && <Button size="sm" icon={Power} loading={busy === 'set'} onClick={() => set({ enabled: false })} title="Le job de copie est retiré du PBS de secours ; les snapshots déjà copiés y restent">Désactiver</Button>}
      </div>
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
    const w = ref.current?.offsetWidth ?? 300;
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) });
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
      className="fixed z-30 w-80 max-w-[calc(100vw-16px)] rounded-md border border-line bg-panel px-3.5 py-3 shadow-2xl shadow-black/60"
      style={pos ?? { top: -9999, left: -9999 }}
    >
      {children}
    </div>
  );
}

// Pill of the copy, next to the badges of a backup: state and age of the last copy; a click opens the
// detail. Dashed "+" when not enabled (admins), nothing when the backup cannot be copied.
export function OffsitePill({ g, remote, onSettings }: { g: BackupGroup; remote: BackupsView['offsite']; onSettings?: () => void }) {
  const { canManage } = useMe();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (!remote || offsiteNotCopiable(g)) return null;
  const o = g.offsite;
  if (!o?.enabled && !canManage) return null;
  const state = o?.enabled ? (o.state ?? 'pending') : null;
  const label = !state ? '+' : state === 'failed' ? 'échec' : state === 'pending' || !o?.lastBackup ? 'en attente' : shortAgo(o.lastBackup);
  return (
    <>
      <button
        type="button"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        title={state ? `Copie déportée : ${offsiteStateMeta[state].label}` : 'Activer la copie déportée'}
        className={clsx(
          'inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
          state ? offsiteStateMeta[state].pill : 'border-dashed border-line text-zinc-500 hover:text-zinc-300',
        )}
      >
        <Cloud className="h-3.5 w-3.5" />
        {state ? label : <Plus className="h-3 w-3" />}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <OffsiteDetail
            g={g}
            remote={remote}
            onSettings={
              onSettings &&
              (() => {
                setAnchor(null);
                onSettings();
              })
            }
          />
        </Popover>
      )}
    </>
  );
}

// Column of the backups page: the pill, what the copy does, run it now.
export function OffsiteCell({ g, remote, onSettings }: { g: BackupGroup; remote: Remote; onSettings?: () => void }) {
  const { canWrite } = useMe();
  const { busy, run } = useOffsiteActions(g);
  const why = offsiteNotCopiable(g);
  if (why) return <span className="text-xs text-zinc-500" title={why}>— non copiable</span>;
  const o = g.offsite;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <OffsitePill g={g} remote={remote} onSettings={onSettings} />
        {o?.enabled && canWrite && <Button size="sm" variant="ghost" icon={Play} loading={busy === 'run'} title="Lancer la copie maintenant" onClick={run} />}
      </div>
      {o?.enabled ? (
        <div className="text-xs text-muted">{offsiteSummary(o)}</div>
      ) : (
        <div className="text-xs text-zinc-500">non copiée</div>
      )}
      {o?.enabled && o.error && <div className="text-xs text-red-400">{o.error}</div>}
    </div>
  );
}

// Settings of the copy in the window of a backup, saved with the backup (offsiteInput).
const TRANSFER = [1, 2, 5, 10];

export function OffsiteSettingsTab({ g, remote, value, onChange }: { g: BackupGroup | undefined; remote: BackupsView['offsite']; value: OffsiteForm; onChange: (f: OffsiteForm) => void }) {
  const { canWrite } = useMe();
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
      {g.offsite?.enabled && <OffsiteStateLine g={g} canRun={canWrite} />}
      {value.enabled ? (
        <div className="grid gap-4 sm:grid-cols-3">
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
            <span className={field}>Snapshots transférés</span>
            <select className="input" value={value.transferLast ?? ''} onChange={(e) => set({ transferLast: e.target.value ? Number(e.target.value) : null })}>
              {value.transferLast && !TRANSFER.includes(value.transferLast) && <option value={value.transferLast}>Les {value.transferLast} derniers</option>}
              {TRANSFER.map((n) => <option key={n} value={n}>{n === 1 ? 'Le dernier' : `Les ${n} derniers`}</option>)}
              <option value="">Tous</option>
            </select>
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
      {g.ns && !g.offsite?.enabled && <p className="text-xs text-muted">Le namespace {g.ns} doit exister sur {remote.store} (à créer dans le PBS de secours sinon).</p>}
    </section>
  );
}

function OffsiteStateLine({ g, canRun }: { g: BackupGroup; canRun: boolean }) {
  const { busy, run } = useOffsiteActions(g);
  const o = g.offsite!;
  const meta = offsiteStateMeta[o.state ?? 'pending'];
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <span className="text-muted">
          {o.lastBackup ? `dernier snapshot copié ${timeAgo(o.lastBackup)}` : 'aucun snapshot copié'}
          {o.nextRun ? ` · prochaine copie ${dateTime(o.nextRun)}` : ''}
        </span>
        {canRun && <Button size="sm" icon={Play} loading={busy === 'run'} className="ml-auto" onClick={run}>Lancer maintenant</Button>}
      </div>
      {o.error && <div className="text-xs text-red-400">Job de copie non appliqué : {o.error}</div>}
      {o.lastRun && !o.lastRun.ok && <div className="text-xs text-red-400">Dernière copie en échec {timeAgo(o.lastRun.end)} : {o.lastRun.error}</div>}
    </div>
  );
}
