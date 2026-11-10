import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { api, type MqttAccount, type MqttHubRole, type MqttRefused } from '../lib/api';
import { timeAgo } from '../lib/format';
import { keys } from '../lib/queries';
import { useToast } from '../lib/toast';
import { useRoles } from '../lib/queries';
import { Badge, Button, ConfirmModal, CopyField, Modal, Panel, Spinner } from './ui';

const STATE = { active: { tone: 'ok', label: 'Gestion des comptes active' }, available: { tone: 'neutral', label: 'Disponible, non activée' }, unavailable: { tone: 'warn', label: 'Indisponible' } } as const;
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('fr-FR') : '—');

// Paramètres › MQTT: the security of the MQTT brokers whose management of accounts is available or active
// (dynamic-security, run by the agent of the host), one panel per broker role.
export function MqttSecuritySettings() {
  const { data: roles = [] } = useRoles();
  const brokers = roles.filter((r): r is MqttHubRole => r.type === 'mqtt-broker' && r.security.state !== 'unavailable');
  if (!brokers.length) return <Panel title="Sécurité MQTT" icon={ShieldCheck}><p className="text-sm text-muted">Aucun broker MQTT déclaré dont la gestion des comptes soit disponible (Mosquitto 2.1 ou plus, agent à jour).</p></Panel>;
  return (
    <div className="space-y-4">
      {brokers.map((r) => (
        <BrokerSecurity key={r.id} role={r} />
      ))}
    </div>
  );
}

// One broker: state, the checks the agent makes, the activation (certificates by the CA of the hub, listener TLS, hub
// account by certificate) and its way back.
function BrokerSecurity({ role }: { role: MqttHubRole }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<'enable' | 'disable' | null>(null);
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['mqtt-security', role.id], queryFn: () => api.mqttSecurity(role.id), refetchOnWindowFocus: false });
  const v = q.data;
  const state = v?.state ?? role.security.state;
  const hubManaged = !!v?.enabledAt;
  const checks = v?.report?.checks ?? [];
  const blocked = !!v && (!!v.error || !v.report?.eligible);

  const run = async (what: 'enable' | 'disable') => {
    setBusy(true);
    try {
      if (what === 'enable') await api.enableMqttSecurity(role.id);
      else await api.disableMqttSecurity(role.id);
      toast.success(what === 'enable' ? 'Gestion des comptes activée' : 'Gestion des comptes désactivée');
      setConfirm(null);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.roles }), qc.invalidateQueries({ queryKey: keys.mqttBrokers }), qc.invalidateQueries({ queryKey: ['mqtt-security', role.id] })]);
    } catch (err) {
      toast.error((err as Error).message);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel title={`Sécurité MQTT · ${role.name}`} icon={ShieldCheck}>
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATE[state].tone}>{STATE[state].label}</Badge>
            {(v?.version ?? role.security.version) && <span className="text-xs text-muted">Mosquitto {v?.version ?? role.security.version}</span>}
            {hubManaged && <span className="text-xs text-muted">activée le {date(v!.enabledAt)} · certificat du hub valable jusqu'au {date(v!.clientNotAfter)}</span>}
          </div>

          {state === 'unavailable' && <p className="text-muted">{role.security.reason ?? 'La gestion des comptes n\'est pas disponible sur ce broker.'}</p>}
          {state === 'active' && !hubManaged && !q.isLoading && (
            <p className="text-muted">Le plugin dynamic-security est chargé mais n'a pas été activé par le hub : il reste géré en dehors de HLM.</p>
          )}
          {state === 'active' && hubManaged && (
            <p className="text-muted">
              Les comptes se gèrent depuis la fiche de l'hôte <Link className="underline" to={`/hosts/${role.carrier.id}`}>{role.carrier.name}</Link>.{' '}
              Le hub parle au broker en TLS mutuel (<code>{role.url}</code>) avec son propre certificat, sans mot de passe. Les clients anonymes restent acceptés
              (rôle <code>legacy</code>) ; un client qui se connecte avec un compte inconnu est refusé.
            </p>
          )}

          {state === 'available' && (
            <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
              <p className="font-medium text-amber-300">À savoir avant d'activer</p>
              <ul className="list-disc space-y-0.5 pl-4">
                <li>
                  <b>Les connexions avec un utilisateur inconnu seront refusées</b> : un appareil configuré avec un identifiant que le broker ne connaît pas ne se connecte plus. Les connexions
                  anonymes continuent d'être acceptées.
                </li>
                <li>Le broker est <b>redémarré</b> : tous les clients sont déconnectés quelques secondes.</li>
                <li>L'agent ajoute des fichiers (certificats, un fichier de configuration) sans modifier les vôtres ; en cas d'échec il les retire et redémarre.</li>
              </ul>
            </div>
          )}

          {(state === 'available' || state === 'active') && (
            <div>
              <p className="mb-1 text-[11px] font-medium tracking-wide text-muted uppercase">Contrôles de l'agent</p>
              {q.isLoading ? (
                <Spinner />
              ) : v?.error ? (
                <p className="text-xs text-red-400">{v.error}</p>
              ) : (
                <ul className="space-y-0.5 text-xs">
                  {checks.map((c, i) => (
                    <li key={i} className={c.level === 'error' ? 'text-red-400' : c.level === 'warn' ? 'text-amber-400' : 'text-muted'}>
                      {c.level === 'error' ? '✗' : c.level === 'warn' ? '!' : '·'} {c.detail}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {state === 'available' && (
              <Button variant="primary" icon={ShieldCheck} disabled={q.isLoading || blocked || busy} onClick={() => setConfirm('enable')}>
                Activer la gestion des comptes
              </Button>
            )}
            {state === 'active' && hubManaged && (
              <Button variant="danger" icon={ShieldOff} disabled={busy} onClick={() => setConfirm('disable')}>
                Désactiver
              </Button>
            )}
          </div>
        </div>
      </Panel>
      <ConfirmModal
        open={confirm === 'enable'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void run('enable')}
        title="Activer la gestion des comptes"
        confirmLabel="Activer et redémarrer le broker"
        danger
        loading={busy}
      >
        Le broker <b>{role.name}</b> va être redémarré et ses clients déconnectés quelques secondes. <b>Les connexions avec un utilisateur inconnu seront ensuite refusées</b> ;
        les connexions anonymes restent acceptées.
      </ConfirmModal>
      <ConfirmModal
        open={confirm === 'disable'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void run('disable')}
        title="Désactiver la gestion des comptes"
        confirmLabel="Désactiver et redémarrer le broker"
        danger
        loading={busy}
      >
        Le broker <b>{role.name}</b> va être redémarré avec sa configuration d'origine. Les comptes et rôles créés sont mis de côté sur l'hôte (pas supprimés) ; le hub
        retrouve le port d'avant, sans TLS.
      </ConfirmModal>
    </>
  );
}

// The accounts of the broker, in a dialog opened from its host: name and password, with the connection state. A password is shown once, when it is made.
export function MqttAccountsModal({ role, onClose }: { role: MqttHubRole; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['mqtt-accounts', role.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.mqttAccounts(role.id), refetchInterval: 10_000 });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{ username: string; password: string } | null>(null);
  const [changing, setChanging] = useState<MqttAccount | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [deleting, setDeleting] = useState<MqttAccount | null>(null);
  // a refused connection the account is made for: its client id, the name to give (the log has no user name)
  const [forClient, setForClient] = useState<MqttRefused | null>(null);
  const [clientUser, setClientUser] = useState('');
  const [clientPassword, setClientPassword] = useState('');

  const done = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const create = () =>
    done(async () => {
      const r = await api.createMqttAccount(role.id, username.trim(), password || undefined);
      setUsername('');
      setPassword('');
      setShown(r);
    });
  const createForClient = () =>
    done(async () => {
      const r = await api.createMqttAccount(role.id, clientUser.trim(), clientPassword || undefined, forClient!.clientId);
      setForClient(null);
      setShown(r);
    });
  const change = () =>
    done(async () => {
      const r = await api.setMqttAccountPassword(role.id, changing!.username, newPassword || undefined);
      setChanging(null);
      setNewPassword('');
      setShown(r);
    });
  const remove = () =>
    done(async () => {
      await api.deleteMqttAccount(role.id, deleting!.username);
      toast.success(`Compte ${deleting!.username} supprimé`);
      setDeleting(null);
    });

  const accounts = q.data?.accounts ?? [];
  const refused = q.data?.refused ?? [];
  return (
    <>
      <Modal open onClose={onClose} title={`Comptes MQTT · ${role.name}`} wide footer={<Button onClick={onClose}>Fermer</Button>}>
        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted">
            Un compte donne accès à tous les topics du broker. Un appareil configuré avec un identifiant qui n'est pas dans cette liste est refusé : il apparaît alors en tête de liste
            (« client refusé », avec son identifiant de client) et le bouton Créer lui fait un compte ; les connexions anonymes restent acceptées.
          </p>
          {q.isLoading ? (
            <Spinner />
          ) : q.error ? (
            <p className="text-xs text-red-400">{(q.error as Error).message}</p>
          ) : (
            <table className="w-full table-fixed text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className="th">Compte</th>
                  <th className="th w-40">Connexion</th>
                  <th className="th w-24" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {refused.map((c) => (
                  <tr key={`refused:${c.clientId}`} className="bg-red-500/5">
                    <td className="td truncate font-mono text-xs text-zinc-100" title={c.clientId}>
                      {c.clientId}
                      <span className="ml-2 font-sans text-red-300">client refusé</span>
                    </td>
                    <td className="td truncate text-xs text-muted" title={`${c.address} · dernière tentative ${new Date(c.lastAt).toLocaleString('fr-FR')}`}>
                      {c.address} · {c.count} tentative{c.count > 1 ? 's' : ''} · {timeAgo(c.lastAt)}
                    </td>
                    <td className="td">
                      <div className="flex justify-end">
                        <Button size="sm" icon={Plus} disabled={busy} onClick={() => (setClientUser(c.clientId), setClientPassword(''), setForClient(c))}>
                          Créer
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {accounts.map((a) => (
                  <tr key={a.username}>
                    <td className="td truncate font-mono text-xs text-zinc-100" title={a.username}>
                      {a.username}
                      {a.protected && <span className="ml-2 font-sans text-muted">compte du hub</span>}
                    </td>
                    <td className="td">
                      <Badge tone={a.connected ? 'ok' : 'neutral'}>{a.connected ? (a.connections > 1 ? `connecté · ${a.connections}` : 'connecté') : 'non connecté'}</Badge>
                    </td>
                    <td className="td">
                      {!a.protected && (
                        <div className="flex justify-end gap-1.5">
                          <Button size="sm" icon={KeyRound} aria-label={`Changer le mot de passe de ${a.username}`} title="Changer le mot de passe" disabled={busy} onClick={() => (setNewPassword(''), setChanging(a))} />
                          <Button size="sm" variant="danger" icon={Trash2} aria-label={`Supprimer ${a.username}`} title="Supprimer" disabled={busy} onClick={() => setDeleting(a)} />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <form
            className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Nouveau compte</span>
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={64} placeholder="esphome, zigbee2mqtt…" autoComplete="off" spellCheck={false} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Mot de passe (généré si vide)</span>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>
            <Button type="submit" variant="primary" icon={Plus} loading={busy} disabled={busy || !username.trim()}>
              Ajouter
            </Button>
          </form>
        </div>
      </Modal>

      <Modal
        open={!!forClient}
        onClose={() => setForClient(null)}
        title={`Créer un compte pour ${forClient?.clientId ?? ''}`}
        footer={
          <>
            <Button onClick={() => setForClient(null)}>Annuler</Button>
            <Button variant="primary" icon={Plus} loading={busy} disabled={busy || !clientUser.trim()} onClick={() => void createForClient()}>Créer</Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted">
            Le journal du broker donne l'identifiant du client, pas le nom d'utilisateur qu'il a essayé. Saisir le nom que l'appareil utilise (dans sa configuration
            MQTT) : il se connectera dès qu'il aura ce compte et son mot de passe.
          </p>
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Nom du compte</span>
            <input className="input" value={clientUser} onChange={(e) => setClientUser(e.target.value)} maxLength={64} autoComplete="off" spellCheck={false} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Mot de passe (généré si vide)</span>
            <input className="input" type="password" value={clientPassword} onChange={(e) => setClientPassword(e.target.value)} autoComplete="new-password" />
          </label>
        </div>
      </Modal>
      <Modal open={!!shown} onClose={() => setShown(null)} title={`Mot de passe de ${shown?.username ?? ''}`} footer={<Button onClick={() => setShown(null)}>Fermer</Button>}>
        <div className="space-y-2 text-sm">
          <p className="text-muted">À copier maintenant et à saisir dans l'appareil : il n'est affiché qu'une fois et ne peut pas être relu ensuite.</p>
          {shown && <CopyField value={shown.password} />}
        </div>
      </Modal>
      <Modal
        open={!!changing}
        onClose={() => setChanging(null)}
        title={`Changer le mot de passe de ${changing?.username ?? ''}`}
        footer={
          <>
            <Button onClick={() => setChanging(null)}>Annuler</Button>
            <Button variant="primary" loading={busy} disabled={busy} onClick={() => void change()}>Changer</Button>
          </>
        }
      >
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-muted">Nouveau mot de passe (généré si vide)</span>
          <input className="input" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
        </label>
        <p className="mt-2 text-xs text-muted">L'appareil qui utilise ce compte devra recevoir le nouveau mot de passe.</p>
      </Modal>
      <ConfirmModal open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => void remove()} title="Supprimer le compte" confirmLabel="Supprimer" danger loading={busy}>
        Le compte <b>{deleting?.username}</b> est supprimé du broker : les appareils qui l'utilisent sont refusés à leur prochaine connexion
        {deleting?.connected ? ' (il est connecté en ce moment et sera déconnecté)' : ''}.
      </ConfirmModal>
    </>
  );
}
