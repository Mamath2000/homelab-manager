import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Globe, Pencil, Plug, Plus, Radio, Save, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { api, type BrokerScheme, type Host, type HostRole, type HostRoleInput, type RoleCandidate } from '../lib/api';
import { useMe } from '../lib/auth';
import type { Tone } from '../lib/status';
import { stepStates } from '../lib/steps';
import { useMqttBrokers } from '../lib/queries';
import { useToast } from '../lib/toast';
import { CheckLine, DetectedRows, Step, Steps, type CheckState } from './PbsDialog';
import { field } from './ProxmoxServer';
import { Badge, Button, ConfirmModal, Modal, Panel, ResponsiveList, Spinner } from './ui';

const SCHEMES: BrokerScheme[] = ['mqtt', 'mqtts', 'ws', 'wss'];

const statusMeta = (b: { status: HostRole['status']; url: string }): { label: string; tone: Tone } =>
  !b.url ? { label: 'Adresse inconnue', tone: 'warn' }
    : !b.status ? { label: 'Inactif', tone: 'neutral' }
      : b.status.state === 'connected' ? { label: 'Connecté', tone: 'ok' }
        : b.status.state === 'connecting' ? { label: 'Connexion…', tone: 'info' }
          : { label: 'Injoignable', tone: 'warn' };

interface Form {
  name: string;
  scheme: BrokerScheme;
  port: string;
  address: string;
  username: string;
}

// A broker role of a host, from a service its agent found, from an existing role, or typed. Four steps (PbsDialog.tsx):
// name, address, account, test. As for Home Assistant, saving needs a successful test; the password is never sent back.
function BrokerModal({ host, role, candidate, onClose }: { host: Host; role: HostRole | null; candidate: RoleCandidate | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [initial] = useState<Form>(() => ({
    name: role?.name ?? '',
    scheme: role?.scheme ?? (SCHEMES.includes(candidate?.scheme as BrokerScheme) ? (candidate!.scheme as BrokerScheme) : 'mqtt'),
    port: String(role?.port ?? candidate?.port ?? 1883),
    address: role?.address ?? '',
    username: role?.username ?? '',
  }));
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
  // a role from a candidate starts unsaved: leaving it is not a loss
  const dirty = !!role && (JSON.stringify(form) !== JSON.stringify(initial) || !!password || clearPassword);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const port = Number(form.port);
  const input = (): HostRoleInput => ({
    name: form.name.trim(),
    scheme: form.scheme,
    port,
    ...(form.address.trim() ? { address: form.address.trim() } : {}),
    username: form.username,
    ...(clearPassword ? { password: '' } : password ? { password } : {}),
  });

  const runTest = async () => {
    setBusy('test');
    setTest(null);
    try {
      const r = await api.testHostRole(host.id, { ...input(), ...(role ? { roleId: role.id } : {}) });
      setTest(r.ok ? { level: 'ok', title: 'Connexion réussie', detail: shown } : { level: 'error', title: 'Échec', detail: r.error ?? 'échec' });
    } catch (err) {
      setTest({ level: 'error', title: 'Échec', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    try {
      if (role) await api.updateHostRole(host.id, role.id, input());
      else await api.createHostRole(host.id, input());
      await qc.invalidateQueries({ queryKey: ['settings', 'mqtt-brokers'] });
      toast.success(role ? 'Broker modifié' : 'Broker ajouté');
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const nameOk = form.name.trim().length > 0;
  const portOk = Number.isInteger(port) && port >= 1 && port <= 65535;
  const addressOk = /^[A-Za-z0-9.:_-]*$/.test(form.address);
  const shown = `${form.scheme}://${form.address.trim() || "IP de l'hôte"}:${form.port}`;
  // the account is optional (anonymous broker): done with the address
  const [named, address, account, tested] = stepStates([nameOk, portOk && addressOk, portOk && addressOk, test?.level === 'ok']);

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        wide="screen"
        wider
        fixed
        title={role ? `Broker MQTT · ${role.name}` : `Broker MQTT sur ${host.name}`}
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
              <input className="input" autoFocus maxLength={64} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="zigbee2mqtt, esphome…" />
            </label>
          </Step>
          <Step n={2} title="Adresse" state={address} intro="Le broker que les sondes écoutent, distinct de celui de Home Assistant. Par défaut, l'adresse est la première IP privée de l'hôte.">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className={field}>Protocole</span>
                <select className="input" value={form.scheme} onChange={(e) => set({ scheme: e.target.value as BrokerScheme })}>
                  {SCHEMES.map((x) => <option key={x} value={x}>{x}://</option>)}
                </select>
              </label>
              <label className="block">
                <span className={field}>Port</span>
                <input className="input" inputMode="numeric" value={form.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })} />
              </label>
            </div>
            <label className="block">
              <span className={field}>Adresse (facultatif)</span>
              <input className="input font-mono text-xs" value={form.address} onChange={(e) => set({ address: e.target.value.trim() })} placeholder="IP de l'hôte" spellCheck={false} />
              <span className="mt-1 block text-xs text-muted">À renseigner si l'IP choisie par défaut n'est pas la bonne, ou pour un nom DNS.</span>
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
                placeholder={role?.hasPassword ? '••••••••' : ''}
                autoComplete="new-password"
              />
              {role?.hasPassword && <span className="mt-1 block text-xs text-muted">Laisser vide pour garder le mot de passe enregistré</span>}
            </label>
            {role?.hasPassword && (
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
              <Button className="w-full" variant={tested === 'active' ? 'primary' : 'secondary'} icon={Plug} loading={busy === 'test'} disabled={busy !== null || !nameOk || !portOk || !addressOk} onClick={() => void runTest()}>
                {test ? 'Tester à nouveau' : 'Tester la connexion'}
              </Button>
            }
          >
            <DetectedRows
              rows={[
                { label: 'Nom', value: form.name, empty: 'non renseigné' },
                { label: 'Hôte', value: host.name, empty: '' },
                { label: 'Broker', value: shown, empty: 'non renseigné' },
                { label: 'Utilisateur', value: form.username, empty: 'anonyme' },
              ]}
            />
            <CheckLine label="Broker MQTT" check={test} idle={shown} />
          </Step>
        </Steps>
      </Modal>
      <ConfirmModal open={confirmDiscard} onClose={() => setConfirmDiscard(false)} onConfirm={onClose} title="Abandonner les modifications ?" confirmLabel="Abandonner" danger>
        Les paramètres du broker modifiés ne seront pas enregistrés.
      </ConfirmModal>
    </>
  );
}

// Fiche hôte: what this host is for. The brokers found by its agent are offered; an admin activates them or adds one.
export function HostRolesPanel({ host }: { host: Host }) {
  const { canManage } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<{ role: HostRole | null; candidate: RoleCandidate | null } | null>(null);
  const [removing, setRemoving] = useState<HostRole | null>(null);
  const [busy, setBusy] = useState(false);
  // already activated: a role on the same port
  const offered = (host.roleCandidates ?? []).filter((c) => !host.roles.some((r) => r.port === c.port));
  if (!host.roles.length && !(canManage && (offered.length || host.roleCandidates))) return null;

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.deleteHostRole(host.id, removing.id);
      await qc.invalidateQueries({ queryKey: ['settings', 'mqtt-brokers'] });
      toast.success(`Broker ${removing.name} supprimé`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRemoving(null);
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Rôles"
      icon={Radio}
      bodyClassName=""
      actions={canManage && <Button size="sm" icon={Plus} onClick={() => setEditing({ role: null, candidate: null })}>Broker MQTT</Button>}
    >
      <ul className="divide-y divide-line">
        {host.roles.map((r) => (
          <li key={r.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-zinc-100">Broker MQTT · {r.name}</p>
              <p className="break-all font-mono text-xs text-muted">{r.url || `${r.scheme}://?:${r.port}`}</p>
              {r.status?.error && <p className="mt-0.5 truncate text-xs text-amber-300" title={r.status.error}>{r.status.error}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge tone={statusMeta(r).tone}>{statusMeta(r).label}</Badge>
              {canManage && (
                <>
                  <Button size="sm" icon={Pencil} aria-label={`Modifier ${r.name}`} title="Modifier" onClick={() => setEditing({ role: r, candidate: null })} />
                  <Button size="sm" variant="danger" icon={Trash2} aria-label={`Supprimer ${r.name}`} title="Supprimer" onClick={() => setRemoving(r)} />
                </>
              )}
            </div>
          </li>
        ))}
        {canManage &&
          offered.map((c) => (
            <li key={`${c.process}:${c.port}`} className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-zinc-200">Broker MQTT détecté · {c.process}</p>
                <p className="text-xs text-muted">
                  port {c.port}
                  {c.local ? ' · écoute en local seulement : injoignable par le hub' : ''}
                </p>
              </div>
              <Button size="sm" icon={Plus} onClick={() => setEditing({ role: null, candidate: c })}>Activer</Button>
            </li>
          ))}
        {canManage && !host.roles.length && !offered.length && <li className="px-4 py-3 text-sm text-muted">Aucun broker détecté sur cet hôte.</li>}
      </ul>
      {editing && <BrokerModal host={host} role={editing.role} candidate={editing.candidate} onClose={() => setEditing(null)} />}
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => void remove()} title="Supprimer le broker" confirmLabel="Supprimer" danger loading={busy}>
        Le broker <b>{removing?.name}</b> ne sera plus écouté. Un broker utilisé par des sondes ne peut pas être supprimé : supprimez ou déplacez ces sondes d'abord.
      </ConfirmModal>
    </Panel>
  );
}

// Paramètres › Sondes: overview of the MQTT brokers the probes listen to. They are declared on the host that runs them.
export function MqttBrokersSettings() {
  const { data: brokers, isLoading, error } = useMqttBrokers();
  return (
    <Panel title="Brokers MQTT des sondes" icon={Globe} bodyClassName="">
      <p className="border-b border-line px-4 py-3 text-xs text-muted">
        Un broker se déclare sur la fiche de l'hôte qui l'héberge (panneau Rôles) : son agent signale les brokers qu'il détecte. Un broker injoignable met ses sondes en « inconnu » : le service n'est pas jugé.
      </p>
      {isLoading ? (
        <div className="flex justify-center p-6"><Spinner /></div>
      ) : error ? (
        <p className="p-4 text-sm text-red-400">{(error as Error).message}</p>
      ) : !brokers?.length ? (
        <p className="p-4 text-sm text-muted">Aucun broker. Ouvrez la fiche d'un hôte pour activer celui que son agent a détecté.</p>
      ) : (
        <>
          <ResponsiveList mode="mobile">
            {brokers.map((b) => (
              <article key={b.id} className="min-w-0 space-y-2 p-4">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <span className="min-w-0 truncate font-medium text-zinc-100">{b.name}</span>
                  <Badge tone={statusMeta(b).tone}>{statusMeta(b).label}</Badge>
                </div>
                <p className="break-all font-mono text-xs text-muted">{b.url || 'adresse inconnue'}</p>
                <p className="text-xs text-muted"><Link className="underline" to={`/hosts/${b.hostId}`}>{b.hostName}</Link> · {b.probes} sonde(s)</p>
              </article>
            ))}
          </ResponsiveList>
          <ResponsiveList mode="desktop">
            <table className="w-full text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className="th">Nom</th>
                  <th className="th">Hôte</th>
                  <th className="th">Adresse</th>
                  <th className="th">Compte</th>
                  <th className="th">Connexion</th>
                  <th className="th">Sondes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {brokers.map((b) => (
                  <tr key={b.id} className="hover:bg-raised/40">
                    <td className="td font-medium text-zinc-100">{b.name}</td>
                    <td className="td"><Link className="underline" to={`/hosts/${b.hostId}`}>{b.hostName}</Link></td>
                    <td className="td font-mono text-xs text-zinc-300">{b.url || 'inconnue'}</td>
                    <td className="td text-muted">{b.username || 'anonyme'}</td>
                    <td className="td">
                      <Badge tone={statusMeta(b).tone}>{statusMeta(b).label}</Badge>
                      {b.status?.error && <p className="mt-0.5 max-w-[240px] truncate text-xs text-amber-300" title={b.status.error}>{b.status.error}</p>}
                    </td>
                    <td className="td text-muted">{b.probes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveList>
        </>
      )}
    </Panel>
  );
}
