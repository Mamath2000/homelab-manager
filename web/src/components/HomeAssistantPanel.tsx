import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Check, Home, Minus, PlugZap, Radio, RefreshCw, Wand2 } from 'lucide-react';
import { api, type HaDetail, type HaSection, type HomeAssistantInput, type HomeAssistantSettings } from '../lib/api';
import { HA_LEVELS, HA_SECTIONS } from '../lib/haDetail';

type HaTab = 'mqtt' | 'discovery';
import { timeAgo } from '../lib/format';
import type { Tone } from '../lib/status';
import { useToast } from '../lib/toast';
import { SettingsFormActions } from './SettingsForm';
import { useSettingsDraft } from './settingsDraft';
import { Button, Panel, Spinner, StatusDot, Tabs } from './ui';

const stateMeta: Record<HomeAssistantSettings['status']['state'], { label: string; tone: Tone }> = {
  disabled: { label: 'Désactivée', tone: 'neutral' },
  connecting: { label: 'Connexion au broker…', tone: 'info' },
  connected: { label: 'Connectée au broker', tone: 'ok' },
  error: { label: 'Erreur', tone: 'bad' },
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export function HomeAssistantPanel() {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // poll while the page is open to follow the connection state
  const { data } = useQuery({ queryKey: ['settings', 'homeassistant'], queryFn: api.homeAssistant, refetchInterval: 5000 });
  // local draft once edited, server values until then
  const [draft, setDraft] = useState<HomeAssistantInput | null>(null);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | 'republish' | null>(null);
  const [tab, setTab] = useState<HaTab>('mqtt');

  const initial: HomeAssistantInput = {
    enabled: data?.enabled ?? false,
    broker: data?.broker ?? '',
    username: data?.username ?? '',
    topic: data?.topic ?? '',
    discoveryPrefix: data?.discoveryPrefix ?? '',
    publicUrl: data?.publicUrl ?? '',
    detail: data?.detail ?? { level: 'minimal', sections: [] },
  };
  const form: HomeAssistantInput = draft ?? initial;
  const input = (): HomeAssistantInput => ({
    ...form,
    ...(clearPassword ? { password: '' } : password ? { password } : {}),
  });
  const set = (patch: Partial<HomeAssistantInput>) => setDraft({ ...form, ...patch });
  const setDetail = (detail: HaDetail) => set({ detail });
  // entities that the level being edited would publish
  const detailKey = JSON.stringify(form.detail);
  const { data: preview } = useQuery({
    queryKey: ['settings', 'homeassistant', 'preview', detailKey],
    queryFn: () => api.previewHomeAssistant(form.detail),
    enabled: !!data,
    placeholderData: (prev) => prev,
  });
  // sections ticked in the table: those of the level, or the picked ones in custom mode
  const ticked = (id: HaSection) =>
    form.detail.level === 'custom' ? form.detail.sections.includes(id) : !!data?.presets[form.detail.level].includes(id);
  const pickLevel = (level: HaDetail['level']) => {
    if (level !== 'custom') return setDetail({ level, sections: [] });
    // custom starts from the sections of the current level
    setDetail({ level, sections: HA_SECTIONS.map((s) => s.id).filter(ticked) });
  };
  // ticking a box of the custom column switches to custom mode
  const toggleSection = (id: HaSection, on: boolean) =>
    setDetail({ level: 'custom', sections: HA_SECTIONS.map((s) => s.id).filter((s) => (s === id ? on : ticked(s))) });

  const save = async () => {
    if (!data) return false;
    setBusy('save');
    try {
      const next = await api.saveHomeAssistant(input());
      qc.setQueryData(['settings', 'homeassistant'], next);
      setDraft(null);
      setPassword('');
      setClearPassword(false);
      toast.success(next.enabled ? 'Intégration Home Assistant enregistrée' : 'Intégration Home Assistant désactivée');
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
  const discard = () => {
    setDraft(null);
    setPassword('');
    setClearPassword(false);
  };
  const dirty = !!data && (JSON.stringify(form) !== JSON.stringify(initial) || !!password || clearPassword);
  useSettingsDraft(dirty, save, discard);
  if (!data) return <Panel title="Home Assistant" icon={Home}><Spinner /></Panel>;

  const test = async () => {
    setBusy('test');
    try {
      const r = await api.testHomeAssistant(input());
      if (r.ok) toast.success('Connexion au broker réussie');
      else toast.error(`Connexion impossible : ${r.error}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const republish = async () => {
    if (dirty) {
      toast.error('Enregistre ou annule les modifications avant de republier.');
      return;
    }
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

  const st = data.status;
  const columns = [...HA_LEVELS, { id: 'custom' as const, label: 'Personnalisé', hint: 'Catégories au choix' }];
  const selected = form.detail.level;

  return (
    <Panel title="Home Assistant (MQTT)" icon={Home}>
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-line bg-raised/40 px-4 py-2.5 text-sm">
        <span className="flex items-center gap-2.5">
          <StatusDot tone={stateMeta[st.state].tone} pulse={st.state === 'connecting'} />
          <span className="font-medium text-zinc-100">{stateMeta[st.state].label}</span>
        </span>
        {st.state === 'connected' && (
          <span className="text-xs text-muted">
            {st.devices} appareil(s) publié(s){st.lastPublishAt && ` · dernière publication ${timeAgo(st.lastPublishAt)}`}
          </span>
        )}
        {st.error && <span className="text-xs text-red-300">{st.error}</span>}
      </div>

      <Tabs
        tabs={[
          { id: 'mqtt' as const, label: 'Connexion MQTT', icon: Radio },
          { id: 'discovery' as const, label: 'Autodiscovery', icon: Wand2 },
        ]}
        value={tab}
        onChange={setTab}
        actions={
          tab === 'mqtt' ? (
            <Button type="button" icon={PlugZap} loading={busy === 'test'} disabled={!form.broker || !!busy} onClick={test}>Tester la connexion</Button>
          ) : (
            <Button
              type="button"
              icon={RefreshCw}
              loading={busy === 'republish'}
              disabled={st.state !== 'connected' || dirty || !!busy}
              title="Renvoie toutes les configurations de découverte et tous les états"
              onClick={republish}
            >
              Republier la découverte
            </Button>
          )
        }
      />

      {tab === 'mqtt' && (
        <form onSubmit={(e) => { e.preventDefault(); void saveAndLeave(); }} className="space-y-4">
          <label className="flex cursor-pointer items-center gap-3">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="h-4 w-4 accent-emerald-500" />
            <span className="text-sm font-medium text-zinc-100">Publier le homelab dans Home Assistant</span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Broker MQTT" hint="mqtt://, mqtts://, ws:// ou wss://">
              <input className="input" value={form.broker} onChange={(e) => set({ broker: e.target.value })} placeholder="mqtt://192.168.1.10:1883" />
            </Field>
            <Field label="Utilisateur">
              <input className="input" value={form.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />
            </Field>
            <Field label="Mot de passe" hint={data.hasPassword ? 'Laisser vide pour garder le mot de passe enregistré' : undefined}>
              <input
                className="input"
                type="password"
                value={password}
                disabled={clearPassword}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={data.hasPassword ? '••••••••' : ''}
                autoComplete="new-password"
              />
              {data.hasPassword && (
                <label className="mt-1.5 flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} className="accent-emerald-500" />
                  Supprimer le mot de passe
                </label>
              )}
            </Field>
            <div />
            <Field label="Préfixe des topics" hint="États et commandes : préfixe/appareil/entité/state">
              <input className="input" required value={form.topic} onChange={(e) => set({ topic: e.target.value })} />
            </Field>
            <Field label="Préfixe de découverte" hint="homeassistant par défaut">
              <input className="input" required value={form.discoveryPrefix} onChange={(e) => set({ discoveryPrefix: e.target.value })} />
            </Field>
            <Field label="URL de l'interface" hint="Lien « Visiter » des appareils dans Home Assistant ; vide : URL du hub (Paramètres > Agent)">
              <input className="input" value={form.publicUrl} onChange={(e) => set({ publicUrl: e.target.value })} placeholder="https://homelab-manager.example.org" />
            </Field>
          </div>
          <p className="text-xs text-muted">Désactiver l'intégration, ou changer de préfixe, retire les appareils de Home Assistant.</p>
        </form>
      )}

      {tab === 'discovery' && (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Entités créées dans Home Assistant par la découverte automatique. Chaque hôte peut avoir son propre niveau
            (options de l'hôte, ou sélection dans la liste des hôtes) ; sans réglage, il suit le niveau choisi ici.
          </p>
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
      )}

      <SettingsFormActions
        dirty={dirty}
        saving={busy === 'save'}
        onSave={() => void saveAndLeave()}
        onCancel={() => { discard(); leave(); }}
      />
    </Panel>
  );
}
