import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Home, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { api, type HaDetail, type HomeAssistantInput, type HomeAssistantSettings, type MqttHubRole } from '../lib/api';
import { HA_LEVELS, HA_SECTIONS, haQueryKey } from '../lib/haDetail';
import { timeAgo } from '../lib/format';
import type { Tone } from '../lib/status';
import { useRoles, useSites } from '../lib/queries';
import { useToast } from '../lib/toast';
import { HaDetailTable } from './HaDetailTable';
import { SettingsFormActions } from './SettingsForm';
import { useSettingsDraft } from './settingsDraft';
import { Badge, Button, Panel, Spinner, StatusDot } from './ui';

const stateMeta: Record<HomeAssistantSettings['status']['state'], { label: string; tone: Tone }> = {
  disabled: { label: 'Arrêtée', tone: 'neutral' },
  connecting: { label: 'Connexion au broker…', tone: 'info' },
  connected: { label: 'Connectée au broker', tone: 'ok' },
  error: { label: 'Erreur', tone: 'bad' },
};

// The role saved as it is, with what is edited replaced.
const inputOf = (s: HomeAssistantSettings): HomeAssistantInput => ({
  name: s.name,
  brokerId: s.brokerId,
  mode: s.mode,
  ...(s.siteId ? { siteId: s.siteId } : {}),
  topic: s.topic,
  discoveryPrefix: s.discoveryPrefix,
  publicUrl: s.publicUrl,
  detail: s.detail,
  groupBySite: s.groupBySite,
});

// What a home-assistant role publishes over MQTT discovery (homelab#361): its link at the top (broker, scope, prefixes;
// the pencil opens the window of the role, onEdit), the level of detail below, and the grouping by site in full mode.
// onLeave: in a window, closes it (else the save and cancel buttons go back to the page before).
export function HomeAssistantPanel({ roleId, onLeave, onEdit, onRemove }: { roleId: string; onLeave?: () => void; onEdit?: () => void; onRemove?: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  // poll while the window is open to follow the connection state
  const { data } = useQuery({ queryKey: haQueryKey(roleId), queryFn: () => api.homeAssistant(roleId), refetchInterval: 5000 });
  const { data: roles } = useRoles();
  const { data: sites = [] } = useSites();
  const broker = roles?.find((r): r is MqttHubRole => r.type === 'mqtt-broker' && r.id === data?.brokerId);
  // level of detail being edited, server value until then
  const [draft, setDraft] = useState<HaDetail | null>(null);
  const [groupDraft, setGroupDraft] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<'save' | 'republish' | null>(null);

  const initial: HaDetail = data?.detail ?? { level: 'minimal', sections: [] };
  const detail = draft ?? initial;
  const full = data?.mode !== 'site';
  const groupBySite = full && (groupDraft ?? data?.groupBySite ?? false);
  // entities that the level being edited would publish
  const { data: preview } = useQuery({
    queryKey: [...haQueryKey(roleId), 'preview', JSON.stringify([detail, groupBySite])],
    queryFn: () => api.previewHomeAssistant(roleId, { detail, groupBySite }),
    enabled: !!data,
    placeholderData: (prev) => prev,
  });

  const save = async () => {
    if (!data) return false;
    setBusy('save');
    try {
      const next = await api.saveHomeAssistant(roleId, { ...inputOf(data), detail, groupBySite });
      qc.setQueryData(haQueryKey(roleId), next);
      setDraft(null);
      setGroupDraft(null);
      toast.success('Paramètres de publication enregistrés');
      return true;
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const leave = () => onLeave?.();
  const saveAndLeave = async () => {
    if (await save()) leave();
  };
  const discard = () => { setDraft(null); setGroupDraft(null); };
  const dirty = !!data && (JSON.stringify(detail) !== JSON.stringify(initial) || groupBySite !== (full && data.groupBySite));
  useSettingsDraft(dirty, save, discard);
  if (!data) return <Panel title="Home Assistant" icon={Home}><Spinner /></Panel>;

  const republish = async () => {
    setBusy('republish');
    try {
      await api.republishHomeAssistant(roleId);
      toast.success('Découverte et états republiés');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const st = data.status;
  const siteName = data.siteId ? sites.find((s) => s.id === data.siteId)?.name ?? data.siteId : null;

  return (
    <Panel
      title="Home Assistant (MQTT)"
      icon={Home}
      actions={
        <Button
          size="sm"
          icon={RefreshCw}
          loading={busy === 'republish'}
          disabled={st.state !== 'connected' || dirty || !!busy}
          title={dirty ? 'Enregistrer ou annuler le niveau de détail avant de republier' : `Supprime tout ce que le hub a publié dans la découverte (${data.discoveryPrefix}/device/homelab/#), puis renvoie configurations et états`}
          onClick={() => void republish()}
        >
          Republier la découverte
        </Button>
      }
    >
      <div className="mb-6 flex items-center gap-3 rounded-md border border-line bg-raised/40 px-4 py-3 text-sm">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusDot tone={stateMeta[st.state].tone} pulse={st.state === 'connecting'} />
            <span className="font-medium text-zinc-100">{stateMeta[st.state].label}</span>
            {broker ? (
              <>
                <span className="text-zinc-200">{broker.name}</span>
                <span className="font-mono text-xs text-zinc-300">{broker.url || 'adresse inconnue'}</span>
                <span className="text-xs text-muted">{broker.config.username ? `compte ${broker.config.username}` : 'anonyme'}</span>
                {broker.anonymous && <Badge tone="bad">connexions anonymes acceptées</Badge>}
              </>
            ) : (
              <span className="text-xs text-amber-300">broker {data.brokerId} introuvable</span>
            )}
            <Badge tone="info">{siteName ? `Site ${siteName}` : 'Tout le homelab'}</Badge>
          </div>
          <p className="text-xs text-muted">
            Découverte <code>{data.discoveryPrefix}/…</code> · états <code>{data.topic}/…</code>
            {st.state === 'connected' && <> · {st.devices} appareil(s) publié(s){st.lastPublishAt && `, dernière publication ${timeAgo(st.lastPublishAt)}`}</>}
          </p>
          {st.error && <p className="text-xs text-red-300">{st.error}</p>}
        </div>
        {onEdit && <Button size="sm" variant="ghost" icon={Pencil} title="Modifier le rôle (broker, périmètre, topics)" onClick={onEdit} />}
        {onRemove && <Button size="sm" variant="ghost" icon={Trash2} title="Supprimer le rôle" onClick={onRemove} />}
      </div>

      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium text-zinc-100">Paramètres de publication</h3>
          <p className="mt-1 text-sm text-muted">
            Entités créées dans ce Home Assistant par la découverte automatique, pour {siteName ? <>les hôtes et équipements du site <b className="text-zinc-300">{siteName}</b></> : 'tout le homelab'}.
          </p>
        </div>
        <HaDetailTable
          title="Niveau de détail"
          columns={HA_LEVELS.map((l) => ({ ...l, sections: data.presets[l.id] }))}
          rows={HA_SECTIONS.map((x) => x.id)}
          value={detail.level}
          custom={detail.sections}
          onChange={(id, sections) => setDraft(id === 'custom' ? { level: 'custom', sections } : { level: id as HaDetail['level'], sections: [] })}
        >
          {preview && (
            <p className="text-xs text-muted">
              Avec ce niveau : <span className="text-zinc-200">{preview.entities} entité(s)</span> sur <span className="text-zinc-200">{preview.devices} appareil(s)</span>.
            </p>
          )}
        </HaDetailTable>
        {(detail.level === 'custom' ? detail.sections : data.presets[detail.level] ?? []).includes('actions') && (
          <div className={clsx('rounded-md border px-4 py-3 text-xs', broker?.anonymous ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-amber-500/30 bg-amber-500/5 text-amber-300')}>
            {broker?.anonymous ? (
              <p>
                <b>Le broker accepte les connexions anonymes</b> : n'importe qui sur le réseau peut lancer les mises à jour des hôtes publiées en actions. Désactiver
                l'accès anonyme du broker (<code>allow_anonymous false</code>) ou retirer les actions.
              </p>
            ) : (
              <p>
                Actions publiées : tout client autorisé à écrire sur <code>{data.topic}/+/+/set</code> peut lancer les mises à jour des hôtes {siteName ? `du site ${siteName}` : ''} (paquets,
                images, agent), sans compte sur le hub. Seules les mises à jour sont exposées, jamais un redémarrage ni un arrêt. Réserver l'écriture sur ces topics au
                compte de Home Assistant (ACL du broker, voir la documentation).
              </p>
            )}
          </div>
        )}
        {full && (
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-emerald-500" checked={groupBySite} onChange={(e) => setGroupDraft(e.target.checked)} />
            <span>
              <span className="block text-zinc-200">Regrouper les entités par site</span>
              <span className="block text-xs text-muted">
                Un appareil par site entre Homelab Manager et ses hôtes / équipements (alertes remontées). Hôtes et équipements sans site restent sous Homelab Manager.
              </span>
            </span>
          </label>
        )}
      </div>

      <SettingsFormActions dirty={dirty} saving={busy === 'save'} onSave={() => void saveAndLeave()} onCancel={() => { discard(); leave(); }} />
    </Panel>
  );
}
