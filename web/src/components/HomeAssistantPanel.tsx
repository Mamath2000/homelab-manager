import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Check, Home, Minus, Pencil, Plug, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { api, type HaDetail, type HaSection, type HomeAssistantInput, type HomeAssistantSettings } from '../lib/api';
import { HA_LEVELS, HA_SECTIONS } from '../lib/haDetail';
import { timeAgo } from '../lib/format';
import type { Tone } from '../lib/status';
import { stepStates } from '../lib/steps';
import { useToast } from '../lib/toast';
import { CheckLine, DetectedRows, Step, Steps, type CheckState } from './PbsDialog';
import { field } from './ProxmoxServer';
import { SettingsFormActions } from './SettingsForm';
import { useSettingsDraft } from './settingsDraft';
import { Button, ConfirmModal, Modal, Panel, Spinner, StatusDot } from './ui';

const stateMeta: Record<HomeAssistantSettings['status']['state'], { label: string; tone: Tone }> = {
  disabled: { label: 'Désactivée', tone: 'neutral' },
  connecting: { label: 'Connexion au broker…', tone: 'info' },
  connected: { label: 'Connectée au broker', tone: 'ok' },
  error: { label: 'Erreur', tone: 'bad' },
};

const BROKER = /^(mqtts?|wss?):\/\/\S+$/;
const TOPIC = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

// Settings saved as they are, with the broker part replaced.
const inputOf = (s: HomeAssistantSettings): HomeAssistantInput => ({
  enabled: s.enabled,
  broker: s.broker,
  username: s.username,
  topic: s.topic,
  discoveryPrefix: s.discoveryPrefix,
  publicUrl: s.publicUrl,
  detail: s.detail,
});

type BrokerForm = Pick<HomeAssistantInput, 'broker' | 'username' | 'topic' | 'discoveryPrefix' | 'publicUrl'>;

// The MQTT broker the hub publishes to, in four steps (PbsDialog.tsx): address, account, topics, test.
// Saving it turns publication on; the password is never sent back by the hub.
function BrokerModal({ data, onClose }: { data: HomeAssistantSettings; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [initial] = useState<BrokerForm>(() => ({
    broker: data.broker,
    username: data.username,
    topic: data.topic || 'homelab-manager',
    discoveryPrefix: data.discoveryPrefix || 'homeassistant',
    publicUrl: data.publicUrl,
  }));
  const [form, setForm] = useState<BrokerForm>(initial);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<CheckState>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // any change makes the last test void
  const set = (patch: Partial<BrokerForm>) => {
    setForm({ ...form, ...patch });
    setTest(null);
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || !!password || clearPassword;
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const input = (): HomeAssistantInput => ({
    ...inputOf(data),
    ...form,
    enabled: true,
    ...(clearPassword ? { password: '' } : password ? { password } : {}),
  });

  const runTest = async () => {
    setBusy('test');
    setTest(null);
    try {
      const r = await api.testHomeAssistant(input());
      setTest(r.ok ? { level: 'ok', title: 'Connexion réussie', detail: form.broker } : { level: 'error', title: 'Échec', detail: r.error ?? 'échec' });
    } catch (err) {
      setTest({ level: 'error', title: 'Échec', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    try {
      const next = await api.saveHomeAssistant(input());
      qc.setQueryData(['settings', 'homeassistant'], next);
      toast.success('Broker enregistré : publication dans Home Assistant');
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const brokerOk = BROKER.test(form.broker);
  const topicsOk = TOPIC.test(form.topic) && TOPIC.test(form.discoveryPrefix);
  // the account is optional (anonymous broker): done with the address
  const [address, account, topics, tested] = stepStates([brokerOk, brokerOk, topicsOk, test?.level === 'ok']);

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        wide="screen"
        fixed
        title={data.enabled ? 'Broker MQTT' : 'Nouveau broker MQTT'}
        footer={
          <>
            <Button disabled={busy !== null} onClick={requestClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null || test?.level !== 'ok'} onClick={() => void save()}>Enregistrer</Button>
          </>
        }
      >
        <Steps fill>
          <Step n={1} title="Broker" state={address} intro="Adresse du broker MQTT auquel Home Assistant est relié (intégration MQTT).">
            <label className="block">
              <span className={field}>Adresse</span>
              <input className="input font-mono text-xs" value={form.broker} onChange={(e) => set({ broker: e.target.value.trim() })} placeholder="mqtt://192.168.1.10:1883" spellCheck={false} />
              <span className="mt-1 block text-xs text-muted">mqtt://, mqtts://, ws:// ou wss://</span>
            </label>
          </Step>
          <Step n={2} title="Compte" state={account} intro="Facultatif : laisser vide pour un broker anonyme.">
            <label className="block">
              <span className={field}>Utilisateur</span>
              <input className="input" value={form.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />
            </label>
            <label className="block">
              <span className={field}>Mot de passe</span>
              <input
                className="input"
                type="password"
                value={password}
                disabled={clearPassword}
                onChange={(e) => (setPassword(e.target.value), setTest(null))}
                placeholder={data.hasPassword ? '••••••••' : ''}
                autoComplete="new-password"
              />
              {data.hasPassword && <span className="mt-1 block text-xs text-muted">Laisser vide pour garder le mot de passe enregistré</span>}
            </label>
            {data.hasPassword && (
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={clearPassword} onChange={(e) => (setClearPassword(e.target.checked), setTest(null))} className="accent-emerald-500" />
                Supprimer le mot de passe
              </label>
            )}
          </Step>
          <Step n={3} title="Topics" state={topics} intro="Valeurs par défaut à confirmer ; en changer retire les appareils publiés sous les anciens préfixes.">
            <label className="block">
              <span className={field}>Préfixe de découverte</span>
              <input className="input font-mono text-xs" value={form.discoveryPrefix} onChange={(e) => set({ discoveryPrefix: e.target.value.trim() })} spellCheck={false} />
              <span className="mt-1 block text-xs text-muted">Celui de l'intégration MQTT de Home Assistant : homeassistant par défaut</span>
            </label>
            <label className="block">
              <span className={field}>Préfixe des topics du hub</span>
              <input className="input font-mono text-xs" value={form.topic} onChange={(e) => set({ topic: e.target.value.trim() })} spellCheck={false} />
              <span className="mt-1 block text-xs text-muted">États et commandes : préfixe/appareil/entité/state</span>
            </label>
            <label className="block">
              <span className={field}>URL de l'interface</span>
              <input className="input" value={form.publicUrl} onChange={(e) => set({ publicUrl: e.target.value })} placeholder="https://homelab-manager.example.org" />
              <span className="mt-1 block text-xs text-muted">Lien « Visiter » des appareils dans Home Assistant ; vide : URL du hub (Paramètres &gt; Agent)</span>
            </label>
            {!topicsOk && <p className="text-xs text-amber-400">Préfixe : lettres, chiffres, _ et -, niveaux séparés par /.</p>}
          </Step>
          <Step
            n={4}
            title="Test de connexion"
            state={tested}
            intro="Le hub se connecte au broker avec ce compte ; l'enregistrement n'est possible qu'après un test réussi."
            footer={
              <Button
                className="w-full"
                variant={tested === 'active' ? 'primary' : 'secondary'}
                icon={Plug}
                loading={busy === 'test'}
                disabled={busy !== null || !brokerOk || !topicsOk}
                onClick={() => void runTest()}
              >
                {test ? 'Tester à nouveau' : 'Tester la connexion'}
              </Button>
            }
          >
            <DetectedRows
              rows={[
                { label: 'Broker', value: form.broker, empty: 'non renseigné' },
                { label: 'Utilisateur', value: form.username, empty: 'anonyme' },
                { label: 'Découverte', value: `${form.discoveryPrefix}/…` },
                { label: 'États', value: `${form.topic}/…` },
              ]}
            />
            <CheckLine label="Broker MQTT" check={test} idle={form.broker || undefined} />
          </Step>
        </Steps>
      </Modal>
      <ConfirmModal open={confirmDiscard} onClose={() => setConfirmDiscard(false)} onConfirm={onClose} title="Abandonner les modifications ?" confirmLabel="Abandonner" danger>
        Les paramètres du broker modifiés ne seront pas enregistrés.
      </ConfirmModal>
    </>
  );
}

// Home Assistant through MQTT discovery: the broker link at the top (BrokerModal), what is published below it.
export function HomeAssistantPanel() {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // poll while the page is open to follow the connection state
  const { data } = useQuery({ queryKey: ['settings', 'homeassistant'], queryFn: api.homeAssistant, refetchInterval: 5000 });
  // level of detail being edited, server value until then
  const [draft, setDraft] = useState<HaDetail | null>(null);
  const [busy, setBusy] = useState<'save' | 'republish' | 'remove' | null>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);

  const initial: HaDetail = data?.detail ?? { level: 'minimal', sections: [] };
  const detail = draft ?? initial;
  // entities that the level being edited would publish
  const detailKey = JSON.stringify(detail);
  const { data: preview } = useQuery({
    queryKey: ['settings', 'homeassistant', 'preview', detailKey],
    queryFn: () => api.previewHomeAssistant(detail),
    enabled: !!data?.enabled,
    placeholderData: (prev) => prev,
  });
  // sections ticked in the table: those of the level, or the picked ones in custom mode
  const ticked = (id: HaSection) =>
    detail.level === 'custom' ? detail.sections.includes(id) : !!data?.presets[detail.level].includes(id);
  const pickLevel = (level: HaDetail['level']) => {
    if (level !== 'custom') return setDraft({ level, sections: [] });
    // custom starts from the sections of the current level
    setDraft({ level, sections: HA_SECTIONS.map((s) => s.id).filter(ticked) });
  };
  // ticking a box of the custom column switches to custom mode
  const toggleSection = (id: HaSection, on: boolean) =>
    setDraft({ level: 'custom', sections: HA_SECTIONS.map((s) => s.id).filter((s) => (s === id ? on : ticked(s))) });

  const save = async () => {
    if (!data) return false;
    setBusy('save');
    try {
      const next = await api.saveHomeAssistant({ ...inputOf(data), detail });
      qc.setQueryData(['settings', 'homeassistant'], next);
      setDraft(null);
      toast.success('Niveau de détail enregistré');
      return true;
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  // save and cancel both leave the settings screen, back to where the user came from (home when opened directly)
  const leave = () => {
    if (window.history.state?.idx > 0) navigate(-1);
    else navigate('/');
  };
  const saveAndLeave = async () => {
    if (await save()) leave();
  };
  const discard = () => setDraft(null);
  const dirty = !!data && JSON.stringify(detail) !== JSON.stringify(initial);
  useSettingsDraft(dirty, save, discard);
  if (!data) return <Panel title="Home Assistant" icon={Home}><Spinner /></Panel>;

  const republish = async () => {
    setBusy('republish');
    try {
      await api.republishHomeAssistant();
      toast.success('Découverte et états republiés');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  // the broker is forgotten and publication stops: the bridge removes the devices from Home Assistant
  const remove = async () => {
    setBusy('remove');
    try {
      const next = await api.saveHomeAssistant({ ...inputOf(data), enabled: false, broker: '', username: '', password: '' });
      qc.setQueryData(['settings', 'homeassistant'], next);
      setDraft(null);
      setRemoving(false);
      toast.success('Broker retiré : appareils supprimés de Home Assistant');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const st = data.status;
  const columns = [...HA_LEVELS, { id: 'custom' as const, label: 'Personnalisé', hint: 'Catégories au choix' }];
  const selected = detail.level;
  const modal = editing && <BrokerModal data={data} onClose={() => setEditing(false)} />;

  if (!data.enabled) {
    return (
      <Panel title="Home Assistant (MQTT)" icon={Home} actions={<Button size="sm" icon={Plus} onClick={() => setEditing(true)}>Ajouter un broker</Button>}>
        <div className="space-y-2 text-sm text-muted">
          <p>
            Le hub peut publier le homelab dans Home Assistant par un broker MQTT, avec la découverte automatique de l'intégration MQTT : aucune
            configuration à écrire côté Home Assistant.
          </p>
          <p>
            Il y crée un appareil par hôte (connectivité, alertes, problème) et un appareil <b className="text-zinc-300">Homelab Manager</b> (alertes du
            homelab, top 5 CPU / mémoire / disque). Le niveau de détail — compteurs, APT, Docker, onduleur, sauvegardes, actions, diagnostics — se règle
            ensuite ici, pour tout le homelab ou hôte par hôte.
          </p>
          <p>Aucun broker n'est défini : rien n'est publié.</p>
        </div>
        {modal}
      </Panel>
    );
  }

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
          title={dirty ? 'Enregistrer ou annuler le niveau de détail avant de republier' : 'Renvoie toutes les configurations de découverte et tous les états'}
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
            <span className="font-mono text-xs text-zinc-300">{data.broker}</span>
            <span className="text-xs text-muted">{data.username ? `compte ${data.username}` : 'anonyme'}</span>
          </div>
          <p className="text-xs text-muted">
            Découverte <code>{data.discoveryPrefix}/…</code> · états <code>{data.topic}/…</code>
            {st.state === 'connected' && <> · {st.devices} appareil(s) publié(s){st.lastPublishAt && `, dernière publication ${timeAgo(st.lastPublishAt)}`}</>}
          </p>
          {st.error && <p className="text-xs text-red-300">{st.error}</p>}
        </div>
        <Button size="sm" variant="ghost" icon={Pencil} title="Modifier le broker" onClick={() => setEditing(true)} />
        <Button size="sm" variant="ghost" icon={Trash2} title="Retirer le broker" onClick={() => setRemoving(true)} />
      </div>

      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium text-zinc-100">Paramètres de publication</h3>
          <p className="mt-1 text-sm text-muted">
            Entités créées dans Home Assistant par la découverte automatique. Chaque hôte peut avoir son propre niveau
            (options de l'hôte, ou sélection dans la liste des hôtes) ; sans réglage, il suit le niveau choisi ici.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-zinc-100">Niveau global</span>
          <div role="radiogroup" aria-label="Niveau global de publication" className="inline-flex overflow-hidden rounded-md border border-line">
            {columns.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={selected === c.id}
                title={c.hint}
                onClick={() => pickLevel(c.id)}
                className={`px-3 py-1.5 text-sm transition ${selected === c.id ? 'bg-emerald-500/15 font-medium text-emerald-300' : 'text-zinc-400 hover:bg-raised/60 hover:text-zinc-100'}`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <span className="text-xs text-muted">Appliqué aux hôtes sans niveau propre.</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className="px-3 py-2 text-left text-xs font-medium text-muted">Catégorie</th>
                {columns.map((c) => (
                  <th key={c.id} className={`px-3 py-2 text-center ${selected === c.id ? 'bg-emerald-500/5' : ''}`}>
                    <label className="flex cursor-pointer flex-col items-center gap-1" title={c.hint}>
                      <input type="radio" name="ha-level" className="accent-emerald-500" checked={selected === c.id} onChange={() => pickLevel(c.id)} />
                      <span className={`text-xs font-medium ${selected === c.id ? 'text-emerald-300' : 'text-zinc-300'}`}>{c.label}</span>
                    </label>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-line/60">
                <td className="px-3 py-2">
                  <span className="block text-zinc-200">Alertes et connectivité des hôtes</span>
                  <span className="block text-xs text-muted">Toujours publiées, sauf pour un hôte réglé sur « Aucun »</span>
                </td>
                {columns.map((c) => (
                  <td key={c.id} className={`px-3 py-2 text-center ${selected === c.id ? 'bg-emerald-500/5' : ''}`}><Check className="mx-auto h-4 w-4 text-zinc-500" /></td>
                ))}
              </tr>
              {HA_SECTIONS.map((sec) => (
                <tr key={sec.id} className="border-b border-line/60">
                  <td className="px-3 py-2">
                    <span className="block text-zinc-200">{sec.label}</span>
                    <span className="block text-xs text-muted">{sec.hint}</span>
                  </td>
                  {columns.map((c) => (
                    <td key={c.id} className={`px-3 py-2 text-center ${selected === c.id ? 'bg-emerald-500/5' : ''}`}>
                      {c.id === 'custom' ? (
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-emerald-500"
                          aria-label={`${sec.label} (personnalisé)`}
                          checked={ticked(sec.id)}
                          onChange={(e) => toggleSection(sec.id, e.target.checked)}
                        />
                      ) : data.presets[c.id].includes(sec.id) ? (
                        <Check className="mx-auto h-4 w-4 text-emerald-400" />
                      ) : (
                        <Minus className="mx-auto h-4 w-4 text-zinc-600" />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {preview && (
          <p className="text-xs text-muted">
            Avec ce niveau et les niveaux propres à chaque hôte : <span className="text-zinc-200">{preview.entities} entité(s)</span> sur{' '}
            <span className="text-zinc-200">{preview.devices} appareil(s)</span>.
          </p>
        )}
      </div>

      <SettingsFormActions
        dirty={dirty}
        saving={busy === 'save'}
        onSave={() => void saveAndLeave()}
        onCancel={() => { discard(); leave(); }}
      />
      {modal}
      <ConfirmModal open={removing} onClose={() => setRemoving(false)} onConfirm={remove} title="Retirer le broker" confirmLabel="Retirer" danger loading={busy === 'remove'}>
        Le hub cesse de publier : les appareils du homelab sont retirés de Home Assistant (<code>{data.broker}</code>). Le niveau de détail est conservé
        pour un prochain broker.
      </ConfirmModal>
    </Panel>
  );
}
