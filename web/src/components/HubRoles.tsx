import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Pencil, Plug, Plus, Radio, Save, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { api, type BrokerScheme, type Host, type HubRole, type HubRoleType, type RoleCandidate } from '../lib/api';
import { keys, useHosts, useRoles } from '../lib/queries';
import { ROLE_TYPES, roleStatus, roleTypeLabel } from '../lib/roles';
import { stepStates } from '../lib/steps';
import { useToast } from '../lib/toast';
import { CheckLine, DetectedRows, Step, Steps, type CheckState } from './PbsDialog';
import { field } from './ProxmoxServer';
import { Badge, Button, ConfirmModal, Modal, Panel, ResponsiveList, Spinner } from './ui';

// Roles of the hub (hub/src/roles.ts): what the hub can do through a host of the homelab, declared here. Without a
// role, what consumes it is off (no MQTT broker: no probe on MQTT, no Home Assistant integration).

const SCHEMES: BrokerScheme[] = ['mqtt', 'mqtts', 'ws', 'wss'];

// A host and the port of the service its agent found: what carries a role.
interface RolePick {
  hostId: string;
  port: number;
}

interface Form {
  name: string;
  scheme: BrokerScheme;
  address: string;
  username: string;
}

// What the agents found on the hosts, for a role of this type. taken: already a role (not the one being edited).
function candidatesOf(hosts: Host[], roles: HubRole[], type: HubRoleType, editing: HubRole | null) {
  const list = hosts.flatMap((h) =>
    (h.roleCandidates ?? [])
      .filter((c) => c.type === type)
      .map((c) => ({ host: h, c, taken: roles.some((r) => r.id !== editing?.id && r.type === type && r.carrier.id === h.id && r.config.port === c.port) })),
  );
  // the carrier of the role edited stays offered, even if its agent no longer reports the service
  if (editing && !list.some((x) => x.host.id === editing.carrier.id && x.c.port === editing.config.port)) {
    const host = hosts.find((h) => h.id === editing.carrier.id);
    if (host) list.unshift({ host, c: { type: editing.type, process: '', port: editing.config.port, scheme: editing.config.scheme }, taken: false });
  }
  return list;
}

// Declares a role, or edits one (choosing another host moves it, its settings kept). Four steps (PbsDialog.tsx): type,
// host, settings, test; as for the brokers before, saving needs a successful test and the password is never sent back.
// preset: the host and port to start from (banner of a host page).
export function RoleWizard({ role, preset, onClose }: { role: HubRole | null; preset?: RolePick; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: hosts = [] } = useHosts();
  const { data: roles = [] } = useRoles();
  const [type, setType] = useState<HubRoleType>(role?.type ?? 'mqtt-broker');
  const [initialPick] = useState<RolePick | null>(() => (role ? { hostId: role.carrier.id, port: role.config.port } : preset ?? null));
  const [pick, setPick] = useState<RolePick | null>(initialPick);
  const [initial] = useState<Form>(() => {
    const c = preset && hosts.find((h) => h.id === preset.hostId)?.roleCandidates?.find((x) => x.port === preset.port);
    return {
      name: role?.name ?? '',
      scheme: role?.config.scheme ?? (SCHEMES.includes(c?.scheme as BrokerScheme) ? (c!.scheme as BrokerScheme) : 'mqtt'),
      address: role?.config.address ?? '',
      username: role?.config.username ?? '',
    };
  });
  const [form, setForm] = useState<Form>(initial);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<CheckState>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // any change makes the last test void
  const set = (patch: Partial<Form>) => {
    setForm({ ...form, ...patch });
    setTest(null);
  };
  const choose = (h: Host, c: RoleCandidate) => {
    setPick({ hostId: h.id, port: c.port });
    // a new broker takes the scheme guessed by the agent
    if (!role && SCHEMES.includes(c.scheme as BrokerScheme)) setForm({ ...form, scheme: c.scheme as BrokerScheme });
    setTest(null);
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || JSON.stringify(pick) !== JSON.stringify(initialPick) || !!password || clearPassword;
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const candidates = candidatesOf(hosts, roles, type, role);
  const host = pick ? hosts.find((h) => h.id === pick.hostId) : undefined;
  const carrier = pick ? { kind: 'host' as const, id: pick.hostId } : undefined;
  const config = () => ({
    scheme: form.scheme,
    port: pick?.port ?? 0,
    ...(form.address.trim() ? { address: form.address.trim() } : {}),
    username: form.username,
    ...(clearPassword ? { password: '' } : password ? { password } : {}),
  });

  const runTest = async () => {
    setBusy('test');
    setTest(null);
    try {
      const r = await api.testRole({ type, carrier, config: config(), ...(role ? { roleId: role.id } : {}) });
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
      const moved = role && pick && (pick.hostId !== role.carrier.id || pick.port !== role.config.port);
      if (role) await api.updateRole(role.id, { ...(moved ? { carrier } : {}), name: form.name.trim(), config: config() });
      else await api.createRole({ type, carrier, name: form.name.trim(), config: config() });
      await Promise.all([qc.invalidateQueries({ queryKey: keys.roles }), qc.invalidateQueries({ queryKey: keys.mqttBrokers })]);
      toast.success(role ? `Rôle ${form.name.trim()} modifié` : `Rôle ${form.name.trim()} déclaré`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const nameOk = form.name.trim().length > 0;
  const addressOk = /^[A-Za-z0-9.:_-]*$/.test(form.address);
  const shown = `${form.scheme}://${form.address.trim() || "IP de l'hôte"}:${pick?.port ?? '?'}`;
  // the account is optional (anonymous broker)
  const [typed, carried, configured, tested] = stepStates([true, !!pick, nameOk && addressOk, test?.level === 'ok']);

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        wide="screen"
        wider
        fixed
        title={role ? `${roleTypeLabel(role.type)} · ${role.name}` : 'Déclarer un rôle'}
        footer={
          <>
            <Button disabled={busy !== null} onClick={requestClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null || test?.level !== 'ok'} onClick={() => void save()}>Enregistrer</Button>
          </>
        }
      >
        <Steps fill>
          <Step n={1} title="Type" state={typed} intro="Ce que le hub pourra faire grâce à ce rôle.">
            {ROLE_TYPES.map((t) => (
              <label key={t.id} className={clsx('block cursor-pointer rounded-md border px-3 py-2', type === t.id ? 'border-emerald-500/60 bg-emerald-500/5' : 'border-line hover:bg-raised/40', role && 'cursor-default')}>
                <input type="radio" name="role-type" className="sr-only" checked={type === t.id} disabled={!!role} onChange={() => (setType(t.id), setPick(null), setTest(null))} />
                <div className="font-medium text-zinc-100">{t.label}</div>
                <div className="text-xs text-muted">{t.hint}</div>
              </label>
            ))}
          </Step>
          <Step n={2} title="Hôte" state={carried} intro={role ? "Choisir un autre hôte déplace le rôle, ses paramètres gardés." : "Les brokers que les agents ont trouvés en écoute sur leur hôte."}>
            {!candidates.length ? (
              <p className="text-sm text-muted">Aucun broker détecté par les agents. Il faut un agent HLM sur l'hôte du broker.</p>
            ) : (
              <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
                {candidates.map(({ host: h, c, taken }) => {
                  const off = taken || !!c.local;
                  const on = pick?.hostId === h.id && pick.port === c.port;
                  return (
                    <label key={`${h.id}:${c.port}`} className={clsx('block rounded-md border px-3 py-2', on ? 'border-emerald-500/60 bg-emerald-500/5' : 'border-line', off ? 'opacity-50' : 'cursor-pointer hover:bg-raised/40')}>
                      <input type="radio" name="role-carrier" className="sr-only" checked={on} disabled={off} onChange={() => choose(h, c)} />
                      <div className="truncate font-medium text-zinc-100">{h.name}</div>
                      <div className="text-xs text-muted">
                        {c.process ? `${c.process} · ` : ''}port {c.port}
                        {taken ? ' · déjà déclaré' : c.local ? ' · en écoute locale seulement : injoignable par le hub' : ''}
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </Step>
          <Step n={3} title="Paramètres" state={configured} intro="Par défaut, l'adresse est la première IP privée de l'hôte ; le compte est facultatif (broker anonyme).">
            <label className="block">
              <span className={field}>Nom</span>
              <input className="input" maxLength={64} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="zigbee2mqtt, esphome…" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className={field}>Protocole</span>
                <select className="input" value={form.scheme} onChange={(e) => set({ scheme: e.target.value as BrokerScheme })}>
                  {SCHEMES.map((x) => <option key={x} value={x}>{x}://</option>)}
                </select>
              </label>
              <label className="block">
                <span className={field}>Port</span>
                <input className="input" value={pick?.port ?? ''} disabled title="Port détecté par l'agent" readOnly />
              </label>
            </div>
            <label className="block">
              <span className={field}>Adresse (facultatif)</span>
              <input className="input font-mono text-xs" value={form.address} onChange={(e) => set({ address: e.target.value.trim() })} placeholder="IP de l'hôte" spellCheck={false} />
            </label>
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
              <Button className="w-full" variant={tested === 'active' ? 'primary' : 'secondary'} icon={Plug} loading={busy === 'test'} disabled={busy !== null || !pick || !nameOk || !addressOk} onClick={() => void runTest()}>
                {test ? 'Tester à nouveau' : 'Tester la connexion'}
              </Button>
            }
          >
            <DetectedRows
              rows={[
                { label: 'Rôle', value: roleTypeLabel(type) },
                { label: 'Nom', value: form.name, empty: 'non renseigné' },
                { label: 'Hôte', value: host?.name, empty: 'non choisi' },
                { label: 'Broker', value: shown },
                { label: 'Utilisateur', value: form.username, empty: 'anonyme' },
              ]}
            />
            <CheckLine label={roleTypeLabel(type)} check={test} idle={shown} />
          </Step>
        </Steps>
      </Modal>
      <ConfirmModal open={confirmDiscard} onClose={() => setConfirmDiscard(false)} onConfirm={onClose} title="Abandonner les modifications ?" confirmLabel="Abandonner" danger>
        Les paramètres du rôle modifiés ne seront pas enregistrés.
      </ConfirmModal>
    </>
  );
}

// Paramètres › Rôles: every role of the hub, declared, edited and removed here.
export function RolesSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: roles, isLoading, error } = useRoles();
  const [editing, setEditing] = useState<{ role: HubRole | null } | null>(null);
  const [removing, setRemoving] = useState<HubRole | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.deleteRole(removing.id);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.roles }), qc.invalidateQueries({ queryKey: keys.mqttBrokers })]);
      toast.success(`Rôle ${removing.name} supprimé`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRemoving(null);
      setBusy(false);
    }
  };
  const actions = (r: HubRole) => (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button size="sm" icon={Pencil} aria-label={`Modifier ${r.name}`} title="Modifier" onClick={() => setEditing({ role: r })} />
      <Button size="sm" variant="danger" icon={Trash2} aria-label={`Supprimer ${r.name}`} title={r.uses.length ? `Utilisé par : ${r.uses.join(', ')}` : 'Supprimer'} disabled={r.uses.length > 0} onClick={() => setRemoving(r)} />
    </div>
  );

  return (
    <Panel title="Rôles du hub" icon={Radio} bodyClassName="" actions={<Button size="sm" icon={Plus} onClick={() => setEditing({ role: null })}>Déclarer un rôle</Button>}>
      <p className="border-b border-line px-4 py-3 text-xs text-muted">
        Ce que le hub peut faire grâce à un hôte du homelab. Un broker MQTT est écouté par les sondes MQTT et peut servir à l'intégration Home Assistant ;
        injoignable, ses sondes passent en « inconnu » : le service n'est pas jugé. Un rôle utilisé ne peut pas être supprimé, et l'hôte qui le porte non plus.
      </p>
      {isLoading ? (
        <div className="flex justify-center p-6"><Spinner /></div>
      ) : error ? (
        <p className="p-4 text-sm text-red-400">{(error as Error).message}</p>
      ) : !roles?.length ? (
        <p className="p-4 text-sm text-muted">Aucun rôle : pas de sonde MQTT ni d'intégration Home Assistant.</p>
      ) : (
        <>
          <ResponsiveList mode="mobile">
            {roles.map((r) => (
              <article key={r.id} className="min-w-0 space-y-2 p-4">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <span className="min-w-0 truncate font-medium text-zinc-100">{roleTypeLabel(r.type)} · {r.name}</span>
                  <Badge tone={roleStatus(r).tone}>{roleStatus(r).label}</Badge>
                </div>
                <p className="break-all font-mono text-xs text-muted">{r.url || 'adresse inconnue'}</p>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted"><Link className="underline" to={`/hosts/${r.carrier.id}`}>{r.carrier.name}</Link> · {r.uses.join(', ') || 'inutilisé'}</p>
                  {actions(r)}
                </div>
              </article>
            ))}
          </ResponsiveList>
          <ResponsiveList mode="desktop">
            <table className="w-full text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className="th">Rôle</th>
                  <th className="th">Hôte</th>
                  <th className="th">Adresse</th>
                  <th className="th">Compte</th>
                  <th className="th">Connexion</th>
                  <th className="th">Utilisé par</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {roles.map((r) => (
                  <tr key={r.id} className="hover:bg-raised/40">
                    <td className="td">
                      <span className="font-medium text-zinc-100">{r.name}</span>
                      <p className="text-xs text-muted">{roleTypeLabel(r.type)}</p>
                    </td>
                    <td className="td"><Link className="underline" to={`/hosts/${r.carrier.id}`}>{r.carrier.name}</Link></td>
                    <td className="td font-mono text-xs text-zinc-300">{r.url || 'inconnue'}</td>
                    <td className="td text-muted">{r.config.username || 'anonyme'}</td>
                    <td className="td">
                      <Badge tone={roleStatus(r).tone}>{roleStatus(r).label}</Badge>
                      {r.status?.error && <p className="mt-0.5 max-w-[240px] truncate text-xs text-amber-300" title={r.status.error}>{r.status.error}</p>}
                    </td>
                    <td className="td text-muted">{r.uses.join(', ') || '—'}</td>
                    <td className="td">{actions(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveList>
        </>
      )}
      {editing && <RoleWizard role={editing.role} onClose={() => setEditing(null)} />}
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => void remove()} title="Supprimer le rôle" confirmLabel="Supprimer" danger loading={busy}>
        Le rôle <b>{removing?.name}</b> est retiré du hub : le broker n'est plus écouté.
      </ConfirmModal>
    </Panel>
  );
}
