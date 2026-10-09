import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Home, PlugZap } from 'lucide-react';
import { api, type HomeAssistantInput, type HomeAssistantSettings } from '../lib/api';
import { timeAgo } from '../lib/format';
import type { Tone } from '../lib/status';
import { useToast } from './Toast';
import { Button, Panel, Spinner, StatusDot } from './ui';

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
  // poll while the page is open to follow the connection state
  const { data } = useQuery({ queryKey: ['settings', 'homeassistant'], queryFn: api.homeAssistant, refetchInterval: 5000 });
  const [form, setForm] = useState<HomeAssistantInput | null>(null);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);

  useEffect(() => {
    if (data && !form) {
      setForm({ enabled: data.enabled, broker: data.broker, username: data.username, topic: data.topic, discoveryPrefix: data.discoveryPrefix });
    }
  }, [data, form]);

  if (!data || !form) return <Panel title="Home Assistant" icon={Home}><Spinner /></Panel>;

  const input = (): HomeAssistantInput => ({
    ...form,
    ...(clearPassword ? { password: '' } : password ? { password } : {}),
  });
  const set = (patch: Partial<HomeAssistantInput>) => setForm({ ...form, ...patch });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('save');
    try {
      const next = await api.saveHomeAssistant(input());
      qc.setQueryData(['settings', 'homeassistant'], next);
      setPassword('');
      setClearPassword(false);
      toast.success(next.enabled ? 'Intégration Home Assistant enregistrée' : 'Intégration Home Assistant désactivée');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

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

  const st = data.status;
  return (
    <Panel title="Home Assistant (MQTT)" icon={Home} className="xl:col-span-2">
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <form onSubmit={save} className="space-y-4">
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
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={busy === 'save'}>Enregistrer</Button>
            <Button type="button" icon={PlugZap} loading={busy === 'test'} disabled={!form.broker} onClick={test}>Tester la connexion</Button>
          </div>
        </form>

        <div className="space-y-4 text-sm">
          <div className="rounded-md border border-line bg-raised/40 p-4">
            <div className="flex items-center gap-2.5">
              <StatusDot tone={stateMeta[st.state].tone} pulse={st.state === 'connecting'} />
              <span className="font-medium text-zinc-100">{stateMeta[st.state].label}</span>
            </div>
            {st.error && <p className="mt-2 text-xs text-red-300">{st.error}</p>}
            {st.state === 'connected' && (
              <p className="mt-2 text-xs text-muted">
                {st.devices} appareil(s) publié(s){st.lastPublishAt && ` · dernière publication ${timeAgo(st.lastPublishAt)}`}
              </p>
            )}
          </div>
          <div className="text-xs leading-relaxed text-muted">
            <p className="mb-2 text-zinc-300">Appareils créés dans Home Assistant (découverte automatique) :</p>
            <ul className="space-y-1.5">
              <li><span className="text-zinc-200">Homelab Manager</span> : totaux, alertes de tout le homelab, « Tout vérifier », « Tout mettre à jour ».</li>
              <li className="pl-4">└ <span className="text-zinc-200">un appareil par hôte</span> : agent connecté, alertes de ses composants, infos système.</li>
              <li className="pl-8">└ <span className="text-zinc-200">hôte · APT</span> : mise à jour installable, compteurs, redémarrage, bouton de vérification.</li>
            </ul>
            <p className="mt-2">Désactiver l'intégration retire ces appareils de Home Assistant.</p>
          </div>
        </div>
      </div>
    </Panel>
  );
}
