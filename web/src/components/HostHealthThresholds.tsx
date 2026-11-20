import { useState } from 'react';
import clsx from 'clsx';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EyeOff, RotateCcw } from 'lucide-react';
import { api, type HealthSnapshot } from '../lib/api';
import { useHostHealthEditor, type HostHealthEditor } from '../lib/useHostHealthEditor';
import { useToast } from '../lib/toast';
import { Badge, Button, Modal, Spinner } from './ui';
import { THRESHOLD_ROWS } from '../lib/healthThresholds';
import { SCALES, barOf, num } from '../lib/healthScales';
import { Indicator } from './HealthIndicator';

type Alert = NonNullable<HealthSnapshot['alerts']>[number];

// Accept ("mask") or watch again the alerts of the host: a masked one no longer counts for its state.
function AlertList({ hostId, alerts, canManage }: { hostId: string; alerts: Alert[]; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const toggle = useMutation({
    mutationFn: ({ key, silenced }: { key: string; silenced: boolean }) => api.silenceHealthAlerts(hostId, [key], silenced),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['health', 'overview'] }), qc.invalidateQueries({ queryKey: ['hosts'] })]),
    onError: (err: Error) => toast.error(err.message),
  });
  if (!alerts.length) return <p className="text-sm text-muted">Aucune alerte en cours.</p>;
  return (
    <ul className="space-y-1.5">
      {[...alerts].sort((a, b) => Number(!!a.silenced) - Number(!!b.silenced) || Number(b.level === 'alert') - Number(a.level === 'alert')).map((a) => (
        <li key={a.key} className="flex items-center gap-2 rounded-md border border-line bg-raised/30 px-3 py-2 text-sm">
          <Badge tone={a.silenced ? 'neutral' : a.level === 'alert' ? 'bad' : 'warn'}>{a.silenced ? 'masquée' : a.level === 'alert' ? 'alerte' : 'warning'}</Badge>
          <span className={`min-w-0 flex-1 truncate ${a.silenced ? 'text-muted line-through' : 'text-zinc-200'}`} title={a.reason}>{a.reason}</span>
          {canManage && (
            <Button
              size="sm"
              variant="ghost"
              loading={toggle.isPending && toggle.variables?.key === a.key}
              title={a.silenced ? 'Réactiver : l\'alerte compte de nouveau pour l\'état de l\'hôte' : 'Accepter le risque : masquer cette alerte de l\'état de l\'hôte'}
              aria-label={a.silenced ? 'Réactiver l\'alerte' : 'Masquer l\'alerte'}
              aria-pressed={!!a.silenced}
              onClick={() => toggle.mutate({ key: a.key, silenced: !a.silenced })}
            >
              <EyeOff className={`h-4 w-4 ${a.silenced ? 'text-zinc-500' : 'text-amber-300'}`} />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}


// Footer in the style of the other dialogs; « Réappliquer les défauts » on the left.
export function HostHealthFooter({ editor, onClose }: { editor: HostHealthEditor; onClose: () => void }) {
  return (
    <>
      <Button type="button" variant="secondary" icon={RotateCcw} className="mr-auto" disabled={!editor.canManage || !editor.customized} loading={editor.resetting} onClick={editor.reset}>Réappliquer les défauts</Button>
      <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
      <Button type="button" variant="primary" loading={editor.saving} disabled={!editor.canManage || !!editor.invalid || !editor.current} onClick={() => void editor.save(onClose)}>Enregistrer</Button>
    </>
  );
}

// Body: alerts of the host (masking applies at once), then the thresholds of the editor: the indicators on the left, the
// selected one (sliders, switch, global default) on the right.
export function HostHealthThresholds({ editor, hostId, alerts, hide }: {
  editor: HostHealthEditor;
  hostId: string;
  alerts: Alert[];
  hide?: { disks?: boolean; smart?: boolean };
}) {
  const [selected, setSelected] = useState(0);
  const { current, isLoading, error } = editor;
  if (isLoading) return <div className="flex justify-center p-8"><Spinner /></div>;
  if (error || !current) return <p className="text-sm text-red-300">{error?.message ?? 'Seuils indisponibles'}</p>;
  const rows = THRESHOLD_ROWS.filter((r) => !(r.group && hide?.[r.group]));
  const row = rows[Math.min(selected, rows.length - 1)];
  const ref = editor.reference;
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-zinc-100">Alertes en cours</h3>
        <AlertList hostId={hostId} alerts={alerts} canManage={editor.canManage} />
      </section>
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-100">Seuils et alertes {editor.customized && <Badge tone="warn">personnalisés</Badge>}</h3>
        <p className="text-xs text-muted">Seules les valeurs qui diffèrent des réglages globaux sont propres à cet hôte ; les autres les suivent. Un interrupteur coupé désactive les alertes de l'indicateur. Prise en compte au prochain rapport de l'agent.</p>
        <div className="grid overflow-hidden rounded-lg border border-line md:grid-cols-[15rem_1fr]">
          <nav className="space-y-1 border-b border-line p-2 md:border-b-0 md:border-r" aria-label="Indicateurs">
            {rows.map((r, i) => {
              const sc = SCALES[r.warning];
              const bar = barOf(r, current.values);
              const on = r === row;
              const enabled = current.enabled[r.enabled];
              const differs = !!ref && [r.warning, r.alert, r.duration ?? r.rearm!].some((k) => current.values[k] !== ref[k]);
              return (
                <button key={r.label} type="button" onClick={() => setSelected(i)}
                  className={clsx('w-full rounded-md px-3 py-2 text-left transition', on ? 'bg-emerald-500/10 ring-1 ring-emerald-500/30' : 'hover:bg-raised/60')}>
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={clsx('flex items-center gap-1.5 truncate text-sm', on ? 'text-emerald-300' : enabled ? 'text-zinc-200' : 'text-muted')}>
                      {r.label.replace(' (load5 / CPU)', '').replace(' SMART', '')}
                      {differs && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title="Différent du défaut global" />}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted">{enabled ? `${num(current.values[r.warning], '').trim()} / ${num(current.values[r.alert], sc.unit)}` : 'désactivé'}</span>
                  </span>
                  <span className={clsx('mt-1.5 flex h-1 overflow-hidden rounded-full', !enabled && 'opacity-30')}>
                    <span className="bg-emerald-900" style={{ width: `${Math.max(0, bar.w)}%` }} />
                    <span className="bg-amber-700" style={{ width: `${Math.max(0, bar.a - bar.w)}%` }} />
                    <span className="flex-1 bg-red-800" />
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="min-w-0 p-5">
            <Indicator
              row={row}
              form={current.values}
              set={editor.setValues}
              host={{ enabled: current.enabled[row.enabled], onEnabled: (v) => editor.setEnabled(row.enabled, v), reference: ref, disabled: !editor.canManage }}
            />
          </div>
        </div>
        {editor.invalid && <p className="text-xs text-red-300">{editor.invalid} : le seuil warning doit être inférieur au seuil alerte.</p>}
      </section>
    </div>
  );
}

// Dialog opened from the health cards.
export function HostHealthModal({ open, onClose, hostId, hostName, alerts, hide, canManage }: {
  open: boolean;
  onClose: () => void;
  hostId: string;
  hostName: string;
  alerts: Alert[];
  hide?: { disks?: boolean; smart?: boolean };
  canManage: boolean;
}) {
  const editor = useHostHealthEditor(hostId, { canManage, enabled: open });
  return (
    <Modal open={open} onClose={onClose} title={`Seuils et alertes de ${hostName}`} wide="xl" scroll footer={<HostHealthFooter editor={editor} onClose={onClose} />}>
      <HostHealthThresholds editor={editor} hostId={hostId} alerts={alerts} hide={hide} />
    </Modal>
  );
}
