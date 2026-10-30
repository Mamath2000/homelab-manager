import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Pencil, Plug, Plus, Radio, Save, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { api, type BrokerScheme, type Equipment, type Host, type HubRole, type HubRoleType, type MqttHubRole, type OmadaHubRole, type PveHubRole, type RoleCandidate } from '../lib/api';
import { keys, useEquipments, useHosts, useRoles } from '../lib/queries';
import { ROLE_TYPES, SINGLE_ROLES, lanAddress, roleStatus, roleTypeLabel } from '../lib/roles';
import { stepStates } from '../lib/steps';
import { useToast } from '../lib/toast';
import { CheckLine, DetectedRows, Step, Steps, type CheckState } from './PbsDialog';
import { field } from './ProxmoxServer';
import { PbsModal } from './BackupSettings';
import { RemoteModal } from './OffsiteSettings';
import { PbsDisconnectModal } from './PbsDisconnect';
import { ClusterModal } from './PveSettings';
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

// The brokers the agents found on the hosts. taken: already a role (not the one being edited).
function candidatesOf(hosts: Host[], roles: HubRole[], editing: MqttHubRole | null) {
  const list = hosts.flatMap((h) =>
    (h.roleCandidates ?? [])
      .filter((c) => c.type === 'mqtt-broker')
      .map((c) => ({ host: h, c, taken: roles.some((r) => r.id !== editing?.id && r.type === 'mqtt-broker' && r.carrier.id === h.id && r.config.port === c.port) })),
  );
  // the carrier of the role edited stays offered, even if its agent no longer reports the service
  if (editing && !list.some((x) => x.host.id === editing.carrier.id && x.c.port === editing.config.port)) {
    const host = hosts.find((h) => h.id === editing.carrier.id);
    if (host) list.unshift({ host, c: { type: editing.type, process: '', port: editing.config.port, scheme: editing.config.scheme }, taken: false });
  }
  return list;
}

// Declares an MQTT broker role, or edits one (choosing another host moves it, its settings kept). Four steps
// (PbsDialog.tsx): host, broker, account, test; saving needs a successful test and the password is never sent back.
// preset: the host and port to start from (banner of a host page).
export function BrokerWizard({ role, preset, onClose }: { role: MqttHubRole | null; preset?: RolePick; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: hosts = [] } = useHosts();
  const { data: roles = [] } = useRoles();
  const type = 'mqtt-broker' as const;
  const [initialPick] = useState<RolePick | null>(() => (role ? { hostId: role.carrier.id, port: role.config.port } : preset ?? null));
  const [pick, setPick] = useState<RolePick | null>(initialPick);
  const [initial] = useState<Form>(() => {
    const c = preset && hosts.find((h) => h.id === preset.hostId)?.roleCandidates?.find((x) => x.type === 'mqtt-broker' && x.port === preset.port);
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

  const candidates = candidatesOf(hosts, roles, role);
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
  // the account is optional (anonymous broker): done with the broker
  const [carried, configured, account, tested] = stepStates([!!pick, nameOk && addressOk, nameOk && addressOk, test?.level === 'ok']);

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        dismissable={false}
        wide="screen"
        wider
        fixed
        title={role ? `Broker MQTT · ${role.name}` : 'Nouveau rôle Broker MQTT'}
        footer={
          <>
            <Button disabled={busy !== null} onClick={requestClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null || test?.level !== 'ok'} onClick={() => void save()}>Enregistrer</Button>
          </>
        }
      >
        <Steps fill>
          <Step n={1} title="Hôte" state={carried} intro={role ? "Choisir un autre hôte déplace le rôle, ses paramètres gardés." : "Les brokers que les agents ont trouvés en écoute sur leur hôte."}>
            {!candidates.length ? (
              <p className="text-sm text-muted">Aucun broker détecté par les agents. Il faut un agent HLM sur l'hôte du broker.</p>
            ) : (
              <div className="relative min-h-0 flex-1 space-y-1.5 overflow-y-auto">
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
          <Step n={2} title="Broker" state={configured} intro="Comment le broker s'appelle dans les sondes, et où le joindre : par défaut, la première IP privée de l'hôte.">
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
                placeholder={role?.hasSecret ? '••••••••' : ''}
                autoComplete="new-password"
              />
              {role?.hasSecret && <span className="mt-1 block text-xs text-muted">Laisser vide pour garder le mot de passe enregistré</span>}
            </label>
            {role?.hasSecret && (
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
                { label: 'Nom', value: form.name, empty: 'non renseigné' },
                { label: 'Hôte', value: host?.name, empty: 'non choisi' },
                { label: 'Broker', value: shown },
                { label: 'Utilisateur', value: form.username, empty: 'anonyme' },
              ]}
            />
            <CheckLine label="Broker MQTT" check={test} idle={shown} />
          </Step>
        </Steps>
      </Modal>
      <ConfirmModal open={confirmDiscard} onClose={() => setConfirmDiscard(false)} onConfirm={onClose} title="Abandonner les modifications ?" confirmLabel="Abandonner" danger>
        Les paramètres du rôle modifiés ne seront pas enregistrés.
      </ConfirmModal>
    </>
  );
}

interface OmadaForm {
  name: string;
  address: string;
  port: string;
  fingerprint: string;
  clientId: string;
}

type OmadaCarrier = { kind: 'host' | 'equipment'; id: string };

const OMADA_PORT = 8043;
const ADDRESS_RE = /^[A-Za-z0-9.\-:_[\]]+$/;
const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const normalizeFingerprint = (f: string) => {
  const hex = f.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex.length === 64 ? hex.match(/../g)!.join(':') : f.trim().toUpperCase();
};
const portValid = (p: string) => /^\d{1,5}$/.test(p) && +p >= 1 && +p <= 65535;
const omadaUrl = (f: Pick<OmadaForm, 'address' | 'port'>) => `https://${f.address.includes(':') && !f.address.startsWith('[') ? `[${f.address}]` : f.address}:${f.port}`;

// address and port of the URL of a role stored
function splitUrl(url: string) {
  try {
    const u = new URL(url);
    return { address: u.hostname, port: u.port || '443' };
  } catch {
    return { address: '', port: String(OMADA_PORT) };
  }
}

// One line of the choice of the carrier: a radio (inside the scrolling list, which is `relative`: the hidden input
// must not extend the window) and what the carrier is.
function CarrierRow({ on, onPick, title, children }: { on: boolean; onPick: () => void; title: string; children: React.ReactNode }) {
  return (
    <label className={clsx('block cursor-pointer rounded-md border px-3 py-2 hover:bg-raised/40', on ? 'border-emerald-500/60 bg-emerald-500/5' : 'border-line')}>
      <input type="radio" name="role-carrier" className="sr-only" checked={on} onChange={onPick} />
      <div className="truncate font-medium text-zinc-100">{title}</div>
      <div className="text-xs text-muted">{children}</div>
    </label>
  );
}

const listHead = 'px-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted';

// Declares an Omada controller role, or edits one (choosing another carrier moves it, its settings kept). Four steps like
// the broker: carrier, controller, application, test. The carrier is a host (the ones whose agent found a controller
// first, the others still chosen by hand; the agent tells a controller by its fixed service ports) or an equipment with an IP. Its
// address comes with it, the port is proposed (8043) and can be changed; the API is checked before any account is typed.
// Saving needs a successful test and the client secret is never sent back. A self-signed certificate is pinned by its
// fingerprint: the checks offer the one the controller presents when it was refused.
export function OmadaWizard({ role, onClose }: { role: OmadaHubRole | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: hosts = [] } = useHosts();
  const { data: equipments = [] } = useEquipments();
  const type = 'omada-controller' as const;
  const [initialCarrier] = useState<OmadaCarrier | null>(() => (role ? { kind: role.carrier.kind, id: role.carrier.id } : null));
  const [carrier, setCarrier] = useState<OmadaCarrier | null>(initialCarrier);
  const [initial] = useState<OmadaForm>(() => ({ name: role?.name ?? '', ...(role ? splitUrl(role.config.url) : { address: '', port: String(OMADA_PORT) }), fingerprint: role?.config.fingerprint ?? '', clientId: role?.config.clientId ?? '' }));
  const [form, setForm] = useState<OmadaForm>(initial);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'read' | 'probe' | null>(null);
  const [test, setTest] = useState<CheckState>(null);
  // what the controller answers without an account (end of step 2)
  const [probe, setProbe] = useState<CheckState>(null);
  // fingerprint the controller presents, offered when its certificate was refused
  const [presented, setPresented] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // any change makes the last checks void
  const reset = () => {
    setTest(null);
    setProbe(null);
    setPresented(null);
    setReadError(null);
  };
  const set = (patch: Partial<OmadaForm>) => {
    setForm({ ...form, ...patch });
    reset();
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || carrier?.id !== initialCarrier?.id || !!secret;
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  // the carriers offered: the hosts whose agent found a controller, the equipments with an IP, then the other hosts
  const detected = hosts.flatMap((h) => (h.roleCandidates ?? []).filter((c) => c.type === 'omada-controller' && !c.local).map((c) => ({ host: h, c })));
  const detectedIds = new Set(detected.map((d) => d.host.id));
  const others = hosts.filter((h) => !detectedIds.has(h.id));
  const boxes = equipments.filter((e) => e.ip);
  const pickHost = (h: Host, port: number) => {
    setCarrier({ kind: 'host', id: h.id });
    setForm({ ...form, address: lanAddress(h.info?.ips), port: String(port) });
    reset();
  };
  const pickEquipment = (e: Equipment) => {
    setCarrier({ kind: 'equipment', id: e.id });
    setForm({ ...form, address: e.ip ?? '', port: String(OMADA_PORT) });
    reset();
  };

  const carrierName = carrier?.kind === 'equipment' ? equipments.find((e) => e.id === carrier.id)?.name : hosts.find((h) => h.id === carrier?.id)?.name;
  const ips = carrier?.kind === 'equipment' ? (equipments.find((e) => e.id === carrier.id)?.ip ? [equipments.find((e) => e.id === carrier.id)!.ip!] : []) : (hosts.find((h) => h.id === carrier?.id)?.info?.ips ?? []);
  const addresses = [...new Set([...ips.map((ip) => ip.replace(/\/\d+$/, '')).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)), ...(form.address ? [form.address] : [])])];
  const url = omadaUrl(form);
  const config = () => ({ url, fingerprint: form.fingerprint.trim(), clientId: form.clientId.trim(), ...(secret ? { clientSecret: secret } : {}) });

  const runProbe = async () => {
    setBusy('probe');
    setProbe(null);
    setPresented(null);
    try {
      const r = await api.roleProbe(url, form.fingerprint.trim());
      setProbe(r.ok ? { level: 'ok', title: 'Le contrôleur répond', detail: r.detail ?? url } : { level: 'error', title: 'Échec', detail: r.error ?? 'échec' });
      setPresented(r.ok ? null : r.fingerprint ?? null);
    } catch (err) {
      setProbe({ level: 'error', title: 'Échec', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  // reads the certificate the controller presents: shown to the admin, pinned only on their click
  const readFingerprint = async () => {
    setBusy('read');
    setPresented(null);
    setReadError(null);
    try {
      setPresented((await api.roleFingerprint(url)).fingerprint);
    } catch (err) {
      setReadError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const runTest = async () => {
    setBusy('test');
    setTest(null);
    setPresented(null);
    try {
      const r = await api.testRole({ type, carrier: carrier!, config: config(), ...(role ? { roleId: role.id } : {}) });
      setTest(r.ok ? { level: 'ok', title: 'Connexion réussie', detail: r.detail ?? url } : { level: 'error', title: 'Échec', detail: r.error ?? 'échec' });
      setPresented(r.ok ? null : r.fingerprint ?? null);
    } catch (err) {
      setTest({ level: 'error', title: 'Échec', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    try {
      const moved = role && (carrier!.id !== role.carrier.id || carrier!.kind !== role.carrier.kind);
      if (role) await api.updateRole(role.id, { ...(moved ? { carrier: carrier! } : {}), name: form.name.trim(), config: config() });
      else await api.createRole({ type, carrier: carrier!, name: form.name.trim(), config: config() });
      await qc.invalidateQueries({ queryKey: keys.roles });
      toast.success(role ? `Rôle ${form.name.trim()} modifié` : `Rôle ${form.name.trim()} déclaré`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const nameOk = form.name.trim().length > 0;
  const addressOk = ADDRESS_RE.test(form.address.trim());
  const portOk = portValid(form.port);
  const fingerprintOk = !form.fingerprint.trim() || FINGERPRINT_RE.test(normalizeFingerprint(form.fingerprint));
  const controllerOk = nameOk && addressOk && portOk && fingerprintOk;
  const appOk = form.clientId.trim().length > 0 && (!!secret || !!role?.hasSecret);
  const [carried, configured, application, tested] = stepStates([!!carrier, controllerOk, appOk, test?.level === 'ok']);

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        dismissable={false}
        wide="screen"
        wider
        fixed
        title={role ? `Contrôleur Omada · ${role.name}` : 'Nouveau rôle Contrôleur Omada'}
        footer={
          <>
            <Button disabled={busy !== null} onClick={requestClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null || test?.level !== 'ok'} onClick={() => void save()}>Enregistrer</Button>
          </>
        }
      >
        <Steps fill>
          <Step n={1} title="Porteur" state={carried} intro={role ? "Choisir un autre porteur déplace le rôle, ses paramètres gardés." : "Où tourne le contrôleur : un hôte dont l'agent l'a trouvé, un équipement, ou un autre hôte (contrôleur sur un autre port)."}>
            {!hosts.length && !boxes.length ? (
              <p className="text-sm text-muted">Aucun hôte ni équipement.</p>
            ) : (
              <div className="relative min-h-0 flex-1 space-y-1.5 overflow-y-auto">
                {detected.length > 0 && <div className={listHead}>Détectés par les agents</div>}
                {detected.map(({ host: h, c }) => (
                  <CarrierRow key={`${h.id}:${c.port}`} on={carrier?.kind === 'host' && carrier.id === h.id && form.port === String(c.port)} onPick={() => pickHost(h, c.port)} title={h.name}>
                    {c.process ? `${c.process} · ` : ''}port {c.port} · {h.info?.ips?.join(', ') || 'adresse inconnue'}
                  </CarrierRow>
                ))}
                {boxes.length > 0 && <div className={listHead}>Équipements</div>}
                {boxes.map((e) => (
                  <CarrierRow key={e.id} on={carrier?.kind === 'equipment' && carrier.id === e.id} onPick={() => pickEquipment(e)} title={e.name}>
                    {e.ip}
                  </CarrierRow>
                ))}
                {others.length > 0 && <div className={listHead}>Autres hôtes</div>}
                {others.map((h) => (
                  <CarrierRow key={h.id} on={carrier?.kind === 'host' && carrier.id === h.id && !detectedIds.has(h.id)} onPick={() => pickHost(h, OMADA_PORT)} title={h.name}>
                    {h.info?.ips?.join(', ') || 'adresse inconnue'}
                  </CarrierRow>
                ))}
              </div>
            )}
          </Step>
          <Step
            n={2}
            title="Contrôleur"
            state={configured}
            intro="Son adresse vient du porteur ; le port est celui par défaut (8043), à changer s'il a été modifié (docker, équipement)."
            footer={
              <Button className="w-full" variant={configured === 'active' ? 'primary' : 'secondary'} icon={Plug} loading={busy === 'probe'} disabled={busy !== null || !!presented || !carrier || !addressOk || !portOk || !fingerprintOk} onClick={() => void runProbe()}>
                {probe ? 'Vérifier à nouveau' : "Vérifier que l'API répond"}
              </Button>
            }
          >
            <label className="block">
              <span className={field}>Nom</span>
              <input className="input" maxLength={64} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Omada Vouillé…" />
            </label>
            <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
              <label className="block">
                <span className={field}>Adresse</span>
                {addresses.length > 1 ? (
                  <select className="input font-mono text-xs" value={form.address} onChange={(e) => set({ address: e.target.value })}>
                    {addresses.map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                ) : (
                  <div className="input truncate font-mono text-xs text-muted">{form.address || (carrier ? 'adresse inconnue' : '—')}</div>
                )}
              </label>
              <label className="block">
                <span className={field}>Port</span>
                <input className="input font-mono text-xs" inputMode="numeric" value={form.port} onChange={(e) => set({ port: e.target.value.trim() })} />
              </label>
            </div>
            {carrier && !addressOk && <span className="block text-xs text-amber-300">Le porteur n'a pas d'adresse connue</span>}
            {!portOk && <span className="block text-xs text-amber-300">Port invalide (1 à 65535)</span>}
            {presented ? (
              <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
                <p className="text-amber-300">Certificat présenté par le contrôleur : à comparer à celui qu'il affiche.</p>
                <p className="font-mono break-all text-zinc-200">{presented}</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => set({ fingerprint: presented })}>Épingler l'empreinte</Button>
                  <Button size="sm" onClick={() => setPresented(null)}>Retour</Button>
                </div>
              </div>
            ) : (
              <>
                {form.fingerprint ? (
                  <div className="space-y-1">
                    <span className={field}>Empreinte épinglée</span>
                    <p className={clsx('font-mono break-all text-xs', fingerprintOk ? 'text-zinc-200' : 'text-amber-300')}>{form.fingerprint}</p>
                    <Button size="sm" onClick={() => set({ fingerprint: '' })}>Changer</Button>
                  </div>
                ) : (
                  <Button size="sm" variant="secondary" icon={Plug} loading={busy === 'read'} disabled={busy !== null || !addressOk || !portOk} onClick={() => void readFingerprint()}>
                    Lire l'empreinte du contrôleur
                  </Button>
                )}
                {readError && <p className="text-xs text-amber-300">{readError}</p>}
                <CheckLine label="API du contrôleur" check={probe} idle={addressOk && portOk ? url : undefined} />
              </>
            )}
          </Step>
          <Step n={3} title="Application" state={application} intro="Une application de l'Open API du contrôleur, en mode client (Client Credentials), avec accès aux sites à lire.">
            <label className="block">
              <span className={field}>Client ID</span>
              <input className="input font-mono text-xs" value={form.clientId} onChange={(e) => set({ clientId: e.target.value })} autoComplete="off" spellCheck={false} />
            </label>
            <label className="block">
              <span className={field}>Client secret</span>
              <input
                className="input"
                type="password"
                value={secret}
                onChange={(e) => (setSecret(e.target.value), setTest(null), setPresented(null))}
                placeholder={role?.hasSecret ? '••••••••' : ''}
                autoComplete="new-password"
              />
              {role?.hasSecret && <span className="mt-1 block text-xs text-muted">Laisser vide pour garder le secret enregistré</span>}
            </label>
          </Step>
          <Step
            n={4}
            title="Test de connexion"
            state={tested}
            intro="Le hub demande un jeton au contrôleur avec cette application, puis la liste de ses sites ; l'enregistrement n'est possible qu'après un test réussi."
            footer={
              <Button className="w-full" variant={tested === 'active' ? 'primary' : 'secondary'} icon={Plug} loading={busy === 'test'} disabled={busy !== null || !carrier || !controllerOk || !appOk} onClick={() => void runTest()}>
                {test ? 'Tester à nouveau' : 'Tester la connexion'}
              </Button>
            }
          >
            <DetectedRows
              rows={[
                { label: 'Nom', value: form.name, empty: 'non renseigné' },
                { label: 'Porteur', value: carrierName, empty: 'non choisi' },
                { label: 'Open API', value: addressOk && portOk ? url : '', empty: 'non renseignée' },
                { label: 'Empreinte', value: form.fingerprint && fingerprintOk ? normalizeFingerprint(form.fingerprint) : '', empty: 'aucune (autorités système)' },
                { label: 'Client ID', value: form.clientId, empty: 'non renseigné' },
              ]}
            />
            <CheckLine label="Contrôleur Omada" check={test} idle={addressOk && portOk ? url : undefined} />
          </Step>
        </Steps>
      </Modal>
      <ConfirmModal open={confirmDiscard} onClose={() => setConfirmDiscard(false)} onConfirm={onClose} title="Abandonner les modifications ?" confirmLabel="Abandonner" danger>
        Les paramètres du rôle modifiés ne seront pas enregistrés.
      </ConfirmModal>
    </>
  );
}

// Why a role of this type cannot be declared now (null: it can).
function notNow(t: HubRoleType, roles: HubRole[]) {
  if (SINGLE_ROLES.includes(t) && roles.some((r) => r.type === t)) return 'déjà déclaré : un seul dans le homelab';
  if (t === 'pbs-offsite' && !roles.some((r) => r.type === 'pbs-primary')) return 'déclarer d’abord le PBS principal';
  return null;
}

// What is declared: the type first, then the window of that type.
function TypePicker({ roles, onPick, onClose }: { roles: HubRole[]; onPick: (t: HubRoleType) => void; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Déclarer un rôle">
      <div className="space-y-2">
        {ROLE_TYPES.map((t) => {
          const why = notNow(t.id, roles);
          return (
            <button key={t.id} type="button" disabled={!!why} className="block w-full rounded-md border border-line px-4 py-3 text-left transition enabled:hover:border-emerald-500/60 enabled:hover:bg-raised/40 disabled:opacity-50" onClick={() => onPick(t.id)}>
              <div className="font-medium text-zinc-100">{t.label}</div>
              <div className="text-xs text-muted">{why ?? t.hint}</div>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

type Editing =
  | { type: 'mqtt-broker'; role: MqttHubRole | null }
  | { type: 'pve-cluster'; role: PveHubRole | null }
  | { type: 'omada-controller'; role: OmadaHubRole | null }
  | { type: 'pbs-primary' | 'pbs-offsite' };

// Paramètres › Rôles: every role of the hub, declared, edited and removed here.
export function RolesSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: roles, isLoading, error } = useRoles();
  // the clusters as their window edits them (token, detection)
  const { data: pve } = useQuery({ queryKey: ['settings', 'pve'], queryFn: api.pveSettings });
  const { data: pbs } = useQuery({ queryKey: ['settings', 'pbs'], queryFn: api.pbsSettings });
  const { data: remote } = useQuery({ queryKey: ['settings', 'pbs-remote'], queryFn: api.pbsRemoteSettings });
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<HubRole | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: keys.roles }),
      qc.invalidateQueries({ queryKey: keys.mqttBrokers }),
      qc.invalidateQueries({ queryKey: ['settings'] }),
      qc.invalidateQueries({ queryKey: ['backups'] }),
    ]);
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      if (removing.type === 'pve-cluster') {
        const r = await api.deletePveCluster(removing.config.cluster);
        toast.success(r.revoked ? `Rôle ${removing.name} supprimé, jeton ${r.revoked} révoqué${r.userDeleted ? ' (utilisateur supprimé)' : ''}` : `Rôle ${removing.name} supprimé`);
      } else {
        await api.deleteRole(removing.id);
        toast.success(`Rôle ${removing.name} supprimé`);
      }
      await refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRemoving(null);
      setBusy(false);
    }
  };
  const edit = (r: HubRole) =>
    setEditing(r.type === 'mqtt-broker' ? { type: r.type, role: r } : r.type === 'pve-cluster' ? { type: r.type, role: r } : r.type === 'omada-controller' ? { type: r.type, role: r } : { type: r.type });
  // the PBS are disconnected by their own window (what the disconnection does, then its report)
  const [disconnecting, setDisconnecting] = useState<'pbs-primary' | 'pbs-offsite' | null>(null);
  const askRemove = (r: HubRole) => (r.type === 'pbs-primary' || r.type === 'pbs-offsite' ? setDisconnecting(r.type) : setRemoving(r));
  const uses = (r: HubRole) => r.uses ?? [];
  const actions = (r: HubRole) => (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button size="sm" icon={Pencil} aria-label={`Modifier ${r.name}`} title="Modifier" onClick={() => edit(r)} />
      <Button size="sm" variant="danger" icon={Trash2} aria-label={`Supprimer ${r.name}`} title={uses(r).length ? `Utilisé par : ${uses(r).join(', ')}` : r.type.startsWith('pbs-') ? 'Déconnecter' : 'Supprimer'} disabled={uses(r).length > 0} onClick={() => askRemove(r)} />
    </div>
  );
  const cluster = editing?.type === 'pve-cluster' && editing.role ? pve?.clusters.find((c) => c.id === editing.role!.config.cluster) ?? null : null;

  return (
    <Panel title="Rôles du hub" icon={Radio} bodyClassName="" actions={<Button size="sm" icon={Plus} onClick={() => setPicking(true)}>Déclarer un rôle</Button>}>
      <p className="border-b border-line px-4 py-3 text-xs text-muted">
        Ce que le hub peut faire grâce à un hôte du homelab : un broker MQTT est écouté par les sondes MQTT et peut servir à l'intégration Home Assistant ; le
        cluster Proxmox VE donne l'inventaire de ses nœuds, VM et CT, relie les hôtes à leur VM ou CT et leur rattache les sauvegardes vzdump ; le PBS principal reçoit les sauvegardes, le
        PBS hors site en copie chaque jour une sélection ; un contrôleur Omada ouvre au hub l'Open API du réseau d'un site. Un rôle utilisé ne peut pas être
        supprimé, et l'hôte qui le porte non plus.
      </p>
      {isLoading ? (
        <div className="flex justify-center p-6"><Spinner /></div>
      ) : error ? (
        <p className="p-4 text-sm text-red-400">{(error as Error).message}</p>
      ) : !roles?.length ? (
        <p className="p-4 text-sm text-muted">Aucun rôle : pas de sauvegarde, de sonde MQTT, d'intégration Home Assistant ni d'inventaire Proxmox VE.</p>
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
                  <p className="text-xs text-muted"><Link className="underline" to={`/hosts/${r.carrier.id}`}>{r.carrier.name}</Link> · {uses(r).join(', ') || r.summary || 'inutilisé'}</p>
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
                    <td className="td text-muted">{r.account || 'anonyme'}</td>
                    <td className="td">
                      <Badge tone={roleStatus(r).tone}>{roleStatus(r).label}</Badge>
                      {r.status?.error && <p className="mt-0.5 max-w-[240px] truncate text-xs text-amber-300" title={r.status.error}>{r.status.error}</p>}
                    </td>
                    <td className="td text-muted">{uses(r).join(', ') || r.summary || '—'}</td>
                    <td className="td">{actions(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveList>
        </>
      )}
      {picking && (
        <TypePicker
          roles={roles ?? []}
          onClose={() => setPicking(false)}
          onPick={(t) => (setPicking(false), setEditing(t === 'pbs-primary' || t === 'pbs-offsite' ? { type: t } : { type: t, role: null }))}
        />
      )}
      {editing?.type === 'pbs-primary' && pbs && <PbsModal data={pbs} open onClose={() => (setEditing(null), void refresh())} />}
      {editing?.type === 'pbs-offsite' && remote && <RemoteModal data={remote} open onClose={() => (setEditing(null), void refresh())} />}
      {disconnecting === 'pbs-primary' && <PbsDisconnectModal open onClose={() => (setDisconnecting(null), void refresh())} />}
      {disconnecting === 'pbs-offsite' && remote && <PbsDisconnectModal open remote={remote} onClose={() => (setDisconnecting(null), void refresh())} />}
      {editing?.type === 'mqtt-broker' && <BrokerWizard role={editing.role} onClose={() => setEditing(null)} />}
      {editing?.type === 'omada-controller' && <OmadaWizard role={editing.role} onClose={() => setEditing(null)} />}
      {editing?.type === 'pve-cluster' && (!editing.role || cluster) && (
        <ClusterModal
          key={editing.role?.id ?? 'new'}
          cluster={cluster}
          others={(pve?.clusters ?? []).filter((c) => c.id !== cluster?.id)}
          onClose={() => (setEditing(null), void refresh())}
        />
      )}
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => void remove()} title="Supprimer le rôle" confirmLabel="Supprimer" danger loading={busy}>
        {removing?.type === 'pve-cluster' ? (
          <>
            Le hub ne relèvera plus <b>{removing.name}</b> : son jeton <code>{removing.account}</code> est révoqué par l’agent du nœud (ainsi que l’utilisateur s’il
            n’a plus de jeton), les liens de ses VM et CT avec les hôtes et le rattachement automatique de leurs sauvegardes sont retirés (les sauvegardes restent
            sur le PBS, orphelines).
          </>
        ) : removing?.type === 'omada-controller' ? (
          <>
            Le rôle <b>{removing.name}</b> est retiré du hub, qui oublie l'application et son secret. Rien n'est changé sur le contrôleur : l'application de sa
            plateforme d'intégration reste à supprimer à la main.
          </>
        ) : (
          <>Le rôle <b>{removing?.name}</b> est retiré du hub : le broker n'est plus écouté.</>
        )}
      </ConfirmModal>
    </Panel>
  );
}
