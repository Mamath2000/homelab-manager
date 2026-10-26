import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EyeOff, RotateCcw } from 'lucide-react';
import { api, type HealthSnapshot } from '../lib/api';
import { useHostHealthEditor, type HostHealthEditor } from '../lib/useHostHealthEditor';
import { useToast } from '../lib/toast';
import { Badge, Button, Modal, Spinner } from './ui';
import { ThresholdFields } from './HealthThresholdsForm';

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

// Body: alerts of the host (masking applies at once), then the thresholds of the editor.
export function HostHealthThresholds({ editor, hostId, alerts, hide }: {
  editor: HostHealthEditor;
  hostId: string;
  alerts: Alert[];
  hide?: { disks?: boolean; smart?: boolean };
}) {
  const { current, isLoading, error } = editor;
  if (isLoading) return <div className="flex justify-center p-8"><Spinner /></div>;
  if (error || !current) return <p className="text-sm text-red-300">{error?.message ?? 'Seuils indisponibles'}</p>;
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-zinc-100">Alertes en cours</h3>
        <AlertList hostId={hostId} alerts={alerts} canManage={editor.canManage} />
      </section>
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-100">Seuils et alertes {editor.customized && <Badge tone="warn">personnalisés</Badge>}</h3>
        <p className="text-xs text-muted">Seules les valeurs qui diffèrent des réglages globaux sont propres à cet hôte ; les autres les suivent. Un interrupteur coupé désactive les alertes de l'indicateur. Prise en compte au prochain rapport de l'agent.</p>
        <ThresholdFields
          form={current.values}
          onChange={editor.setValues}
          enabled={current.enabled}
          onEnabledChange={editor.setEnabled}
          reference={editor.reference}
          hide={hide}
          disabled={!editor.canManage}
        />
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
