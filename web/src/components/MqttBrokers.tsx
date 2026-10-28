import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Globe, Pencil, Plug, Plus, Save, Trash2 } from 'lucide-react';
import { api, type MqttBrokerInput, type MqttBrokerView } from '../lib/api';
import type { Tone } from '../lib/status';
import { stepStates } from '../lib/steps';
import { useMqttBrokers } from '../lib/queries';
import { useToast } from '../lib/toast';
import { CheckLine, DetectedRows, Step, Steps, type CheckState } from './PbsDialog';
import { field } from './ProxmoxServer';
import { Badge, Button, ConfirmModal, Modal, Panel, ResponsiveList, Spinner } from './ui';

const BROKER = /^(mqtts?|wss?):\/\/\S+$/;

const statusMeta = (b: MqttBrokerView): { label: string; tone: Tone } =>
  !b.status ? { label: 'Inactif', tone: 'neutral' }
    : b.status.state === 'connected' ? { label: 'Connecté', tone: 'ok' }
      : b.status.state === 'connecting' ? { label: 'Connexion…', tone: 'info' }
        : { label: 'Injoignable', tone: 'warn' };

interface Form {
  name: string;
  url: string;
  username: string;
}

// A broker the probes listen to, in four steps (PbsDialog.tsx): name, address, account, test. As for Home Assistant,
// saving needs a successful test; the password is never sent back by the hub.
function BrokerModal({ broker, onClose }: { broker: MqttBrokerView | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [initial] = useState<Form>(() => ({ name: broker?.name ?? '', url: broker?.url ?? '', username: broker?.username ?? '' }));
  const [form, setForm] = useState<Form>(initial);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<CheckState>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const set = (patch: Partial<Form>) => {
    setForm({ ...form, ...patch });
    setTest(null);
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || !!password || clearPassword;
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const input = (): MqttBrokerInput => ({ name: form.name.trim(), url: form.url, username: form.username, ...(clearPassword ? { password: '' } : password ? { password } : {}) });

  const runTest = async () => {
    setBusy('test');
    setTest(null);
    try {
      const r = await api.testMqttBroker({ ...input(), ...(broker ? { id: broker.id } : {}) });
      setTest(r.ok ? { level: 'ok', title: 'Connexion réussie', detail: form.url } : { level: 'error', title: 'Échec', detail: r.error ?? 'échec' });
    } catch (err) {
      setTest({ level: 'error', title: 'Échec', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    try {
      if (broker) await api.updateMqttBroker(broker.id, input());
      else await api.createMqttBroker(input());
      await qc.invalidateQueries({ queryKey: ['settings', 'mqtt-brokers'] });
      toast.success(broker ? 'Broker modifié' : 'Broker ajouté');
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const nameOk = form.name.trim().length > 0;
  const urlOk = BROKER.test(form.url);
  // the account is optional (anonymous broker): done with the address
  const [named, address, account, tested] = stepStates([nameOk, urlOk, urlOk, test?.level === 'ok']);

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        wide="screen"
        wider
        fixed
        title={broker ? `Broker MQTT · ${broker.name}` : 'Nouveau broker MQTT'}
        footer={
          <>
            <Button disabled={busy !== null} onClick={requestClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null || test?.level !== 'ok'} onClick={() => void save()}>Enregistrer</Button>
          </>
        }
      >
        <Steps fill>
          <Step n={1} title="Nom" state={named} intro="Comment le broker s'appelle dans les sondes.">
            <label className="block">
              <span className={field}>Nom</span>
              <input className="input" autoFocus maxLength={64} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="vouille, jarsay…" />
            </label>
          </Step>
          <Step n={2} title="Adresse" state={address} intro="Le broker que les sondes écoutent, distinct de celui de Home Assistant.">
            <label className="block">
              <span className={field}>Adresse</span>
              <input className="input font-mono text-xs" value={form.url} onChange={(e) => set({ url: e.target.value.trim() })} placeholder="mqtt://192.168.100.10:1883" spellCheck={false} />
              <span className="mt-1 block text-xs text-muted">mqtt://, mqtts://, ws:// ou wss://</span>
            </label>
          </Step>
          <Step n={3} title="Compte" state={account} intro="Facultatif : laisser vide pour un broker anonyme.">
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
                placeholder={broker?.hasPassword ? '••••••••' : ''}
                autoComplete="new-password"
              />
              {broker?.hasPassword && <span className="mt-1 block text-xs text-muted">Laisser vide pour garder le mot de passe enregistré</span>}
            </label>
            {broker?.hasPassword && (
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={clearPassword} onChange={(e) => (setClearPassword(e.target.checked), setTest(null))} className="accent-emerald-500" />
                Supprimer le mot de passe
              </label>
            )}
          </Step>
          <Step
            n={4}
            title="Test de connexion"
            state={tested}
            intro="Le hub se connecte au broker avec ce compte ; l'enregistrement n'est possible qu'après un test réussi."
            footer={
              <Button className="w-full" variant={tested === 'active' ? 'primary' : 'secondary'} icon={Plug} loading={busy === 'test'} disabled={busy !== null || !nameOk || !urlOk} onClick={() => void runTest()}>
                {test ? 'Tester à nouveau' : 'Tester la connexion'}
              </Button>
            }
          >
            <DetectedRows
              rows={[
                { label: 'Nom', value: form.name, empty: 'non renseigné' },
                { label: 'Broker', value: form.url, empty: 'non renseigné' },
                { label: 'Utilisateur', value: form.username, empty: 'anonyme' },
              ]}
            />
            <CheckLine label="Broker MQTT" check={test} idle={form.url || undefined} />
          </Step>
        </Steps>
      </Modal>
      <ConfirmModal open={confirmDiscard} onClose={() => setConfirmDiscard(false)} onConfirm={onClose} title="Abandonner les modifications ?" confirmLabel="Abandonner" danger>
        Les paramètres du broker modifiés ne seront pas enregistrés.
      </ConfirmModal>
    </>
  );
}

// Paramètres › Sondes: the MQTT brokers the probes of the hosts listen to.
export function MqttBrokersSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: brokers, isLoading, error } = useMqttBrokers();
  const [editing, setEditing] = useState<MqttBrokerView | 'new' | null>(null);
  const [removing, setRemoving] = useState<MqttBrokerView | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.deleteMqttBroker(removing.id);
      await qc.invalidateQueries({ queryKey: ['settings', 'mqtt-brokers'] });
      toast.success(`Broker ${removing.name} supprimé`);
      setRemoving(null);
    } catch (err) {
      toast.error((err as Error).message);
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  };

  const actions = (b: MqttBrokerView) => (
    <div className="flex shrink-0 items-center justify-end gap-1.5">
      <Button size="sm" icon={Pencil} aria-label={`Modifier ${b.name}`} title="Modifier" onClick={() => setEditing(b)} />
      <Button size="sm" variant="danger" icon={Trash2} aria-label={`Supprimer ${b.name}`} title="Supprimer" onClick={() => setRemoving(b)} />
    </div>
  );

  return (
    <Panel
      title="Brokers MQTT des sondes"
      icon={Globe}
      bodyClassName=""
      actions={<Button size="sm" icon={Plus} onClick={() => setEditing('new')}>Ajouter un broker</Button>}
    >
      <p className="border-b border-line px-4 py-3 text-xs text-muted">
        Les sondes MQTT écoutent ces brokers, distincts de celui du pont Home Assistant. Un broker injoignable met ses sondes en « inconnu » : le service n'est pas jugé.
      </p>
      {isLoading ? (
        <div className="flex justify-center p-6"><Spinner /></div>
      ) : error ? (
        <p className="p-4 text-sm text-red-400">{(error as Error).message}</p>
      ) : !brokers?.length ? (
        <p className="p-4 text-sm text-muted">Aucun broker. Ajoutez-en un pour créer des sondes MQTT (disponibilité Zigbee2MQTT, LWT ESPHome…).</p>
      ) : (
        <>
          <ResponsiveList mode="mobile">
            {brokers.map((b) => (
              <article key={b.id} className="min-w-0 space-y-2 p-4">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <span className="min-w-0 truncate font-medium text-zinc-100">{b.name}</span>
                  <Badge tone={statusMeta(b).tone}>{statusMeta(b).label}</Badge>
                </div>
                <p className="break-all font-mono text-xs text-muted">{b.url}</p>
                <div className="flex items-center justify-between gap-2 text-xs text-muted">
                  <span>{b.probes} sonde(s)</span>
                  {actions(b)}
                </div>
              </article>
            ))}
          </ResponsiveList>
          <ResponsiveList mode="desktop">
            <table className="w-full text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className="th">Nom</th>
                  <th className="th">Adresse</th>
                  <th className="th">Compte</th>
                  <th className="th">Connexion</th>
                  <th className="th">Sondes</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {brokers.map((b) => (
                  <tr key={b.id} className="hover:bg-raised/40">
                    <td className="td font-medium text-zinc-100">{b.name}</td>
                    <td className="td font-mono text-xs text-zinc-300">{b.url}</td>
                    <td className="td text-muted">{b.username || 'anonyme'}</td>
                    <td className="td">
                      <Badge tone={statusMeta(b).tone}>{statusMeta(b).label}</Badge>
                      {b.status?.error && <p className="mt-0.5 max-w-[240px] truncate text-xs text-amber-300" title={b.status.error}>{b.status.error}</p>}
                    </td>
                    <td className="td text-muted">{b.probes}</td>
                    <td className="td">{actions(b)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveList>
        </>
      )}
      {editing && <BrokerModal broker={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => void remove()} title="Supprimer le broker" confirmLabel="Supprimer" danger loading={busy}>
        Le broker <b>{removing?.name}</b> ne sera plus écouté. Un broker utilisé par des sondes ne peut pas être supprimé : supprimez ou déplacez ces sondes d'abord.
      </ConfirmModal>
    </Panel>
  );
}
