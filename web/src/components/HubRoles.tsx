import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { KeyRound, Pencil, Plug, Plus, Radio, RefreshCw, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { api, type BrokerScheme, type Equipment, type Host, type HubRole, type HubRoleTest, type HubRoleType, type MqttHubRole, type OmadaHubRole, type PresentedFingerprint, type PveHubRole, type RoleCandidate } from '../lib/api';
import { keys, useEquipments, useHosts, useRoles } from '../lib/queries';
import { ROLE_TYPES, SINGLE_ROLES, lanAddress, ofManagedBroker, roleStatus } from '../lib/roles';
import { roleIcon, roleTint } from '../lib/hostSkills';
import { stepStates } from '../lib/steps';
import { useToast } from '../lib/toast';
import { CheckLine, DetectedRows, Step, Steps, type CheckState } from './PbsDialog';
import { field } from './ProxmoxServer';
import { PbsModal } from './BackupSettings';
import { RemoteModal } from './OffsiteSettings';
import { PbsDisconnectModal } from './PbsDisconnect';
import { PbsRotateModal } from './PbsRotate';
import { ClusterModal } from './PveSettings';
import { Badge, Button, ConfirmModal, CopyField, Modal, Panel, ResponsiveList, Spinner } from './ui';

// Roles of the hub (hub/src/roles.ts): what the hub can do through a host of the homelab, declared here. Without a
// role, what consumes it is off (no MQTT broker: no probe on MQTT, no Home Assistant integration).

// a broker open without an account: anyone on the network may publish, the commands of Home Assistant included
const ANONYMOUS_HINT = "n'importe qui sur le réseau peut y publier, y compris les commandes de Home Assistant. Désactiver l'accès anonyme du broker (allow_anonymous false).";

// A host and the port of the service its agent found: what carries a role.
interface RolePick {
  hostId: string;
  port: number;
}

// address and port: optional, '' = the IP of the host (its agent) and the port the agent found (else 1883)
interface Form {
  name: string;
  scheme: BrokerScheme;
  address: string;
  port: string;
  username: string;
}

// The protocols a role can connect with, offered as cards: only MQTT over TCP for now (TLS, WebSocket come later, with the
// authority and the certificates managed by HLM).
const PROTOCOLS: { scheme: BrokerScheme; label: string; hint: string }[] = [{ scheme: 'mqtt', label: 'MQTT', hint: 'TCP, sans chiffrement (mqtt://)' }];
const MQTT_PORT = 1883;

// One broker an agent found: a process of a host and the ports it listens on (1883, 9001…), the TLS listener of the hub
// left out. taken: already a role (one process, one role), other than the one edited.
interface BrokerFound {
  host: Host;
  process: string;
  version?: string;
  dynsec: boolean;
  listeners: RoleCandidate[];
  taken: boolean;
}

function brokersOf(hosts: Host[], roles: HubRole[], editing: MqttHubRole | null): BrokerFound[] {
  const out: BrokerFound[] = [];
  for (const h of hosts) {
    for (const c of h.roleCandidates ?? []) {
      if (c.type !== 'mqtt-broker' || ofManagedBroker(h, c)) continue;
      let b = out.find((x) => x.host.id === h.id && x.process === c.process);
      if (!b) {
        b = { host: h, process: c.process, version: c.version, dynsec: !!c.dynsec, listeners: [], taken: false };
        out.push(b);
      }
      b.listeners.push(c);
    }
  }
  for (const b of out) {
    b.listeners.sort((x, y) => x.port - y.port);
    b.taken = roles.some((r) => r.id !== editing?.id && r.type === 'mqtt-broker' && r.carrier.id === b.host.id && b.listeners.some((l) => l.port === r.config.port));
  }
  // the broker of the role edited stays offered, even if its agent no longer reports it
  if (editing && !out.some((b) => b.host.id === editing.carrier.id && b.listeners.some((l) => l.port === editing.config.port))) {
    const host = hosts.find((h) => h.id === editing.carrier.id);
    if (host) out.unshift({ host, process: '', dynsec: false, listeners: [{ type: 'mqtt-broker', process: '', port: editing.config.port, scheme: editing.config.scheme }], taken: false });
  }
  return out;
}

const brokerKey = (b: Pick<BrokerFound, 'host' | 'process'>) => `${b.host.id}|${b.process}`;
// the port the agent found for the protocol, else its usual one
const defaultPort = (b: BrokerFound | undefined, scheme: BrokerScheme) => b?.listeners.find((l) => !l.local && l.scheme === scheme)?.port ?? MQTT_PORT;

function generatePassword() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const DYNSEC_INFO: Record<'unavailable' | 'available' | 'active', string> = {
  unavailable: 'gestion des comptes par HLM indisponible',
  available: 'gestion des comptes par HLM possible (dynamic-security), à activer dans Paramètres › MQTT',
  active: 'dynamic-security chargé',
};

// Declares an MQTT broker role, or edits one: the same dialog. Its name first, then four steps (PbsDialog.tsx): the
// broker, the protocol (address and port optional), the account, the test; saving needs a successful test and the
// password is never sent back. When the hub runs the accounts of the broker, the account typed or generated here is made
// on the broker (or its password changed) when the role is saved. preset: the host and port to start from (banner of a
// host page).
export function BrokerWizard({ role, preset, onClose }: { role: MqttHubRole | null; preset?: RolePick; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: hosts = [] } = useHosts();
  const { data: roles = [] } = useRoles();
  const type = 'mqtt-broker' as const;
  const managed = !!role?.security.managed;
  const brokers = brokersOf(hosts, roles, role);
  const start = role ? { hostId: role.carrier.id, port: role.config.port } : preset;
  const startBroker = start ? brokers.find((b) => b.host.id === start.hostId && b.listeners.some((l) => l.port === start.port)) : undefined;
  const [initialKey] = useState<string | null>(() => (startBroker ? brokerKey(startBroker) : null));
  const [key, setKey] = useState<string | null>(initialKey);
  const [initial] = useState<Form>(() => {
    const scheme = role?.config.scheme ?? 'mqtt';
    return {
      name: role?.name ?? startBroker?.host.name ?? '',
      scheme,
      address: role?.config.address ?? '',
      // the stored port is shown only when it is not the one found
      port: role && role.config.port !== defaultPort(startBroker, scheme) ? String(role.config.port) : '',
      username: role?.config.username ?? '',
    };
  });
  const [form, setForm] = useState<Form>(initial);
  const [password, setPassword] = useState('');
  const [generated, setGenerated] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<CheckState>(null);
  const [info, setInfo] = useState<HubRoleTest['dynsec'] | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // any change makes the last test void
  const set = (patch: Partial<Form>) => {
    setForm({ ...form, ...patch });
    setTest(null);
  };
  const broker = brokers.find((b) => brokerKey(b) === key);
  const choose = (b: BrokerFound) => {
    setKey(brokerKey(b));
    // a new role is named after the host of its broker, until the name is typed
    if (!role && (!form.name.trim() || form.name === broker?.host.name)) setForm({ ...form, name: b.host.name });
    setTest(null);
  };
  const regenerate = () => {
    setPassword(generatePassword());
    setGenerated(true);
    setClearPassword(false);
    setTest(null);
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || key !== initialKey || !!password || clearPassword;
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const host = broker?.host;
  const carrier = host ? { kind: 'host' as const, id: host.id } : undefined;
  const port = form.port.trim() ? Number(form.port) : defaultPort(broker, form.scheme);
  const hostIp = lanAddress(host?.info?.ips);
  const address = form.address.trim() || hostIp;
  const url = address ? `${form.scheme}://${address.includes(':') && !address.startsWith('[') ? `[${address}]` : address}:${port}` : '';
  const protocols = PROTOCOLS.some((p) => p.scheme === form.scheme) ? PROTOCOLS : [...PROTOCOLS, { scheme: form.scheme, label: form.scheme, hint: 'protocole du rôle existant' }];
  const config = () => ({
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
      const r = await api.testRole({ type, carrier, config: config(), ...(role ? { roleId: role.id } : {}) });
      setInfo(r.dynsec ?? null);
      setTest(
        !r.ok
          ? { level: 'error', title: 'Échec', detail: r.error ?? 'échec' }
          : r.pending
            ? { level: 'ok', title: 'Broker joignable', detail: r.detail ?? url }
            : r.anonymous
              ? { level: 'warn', title: 'Connexion réussie, mais connexions anonymes acceptées', detail: ANONYMOUS_HINT }
              : { level: 'ok', title: 'Connexion réussie', detail: url },
      );
    } catch (err) {
      setTest({ level: 'error', title: 'Échec', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    try {
      const moved = role && host && host.id !== role.carrier.id;
      if (role) await api.updateRole(role.id, { ...(moved ? { carrier } : {}), name: form.name.trim(), config: config() });
      else await api.createRole({ type, carrier, name: form.name.trim(), config: config() });
      await Promise.all([qc.invalidateQueries({ queryKey: keys.roles }), qc.invalidateQueries({ queryKey: keys.mqttBrokers }), qc.invalidateQueries({ queryKey: ['mqtt-accounts'] })]);
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
  const portOk = !form.port.trim() || (/^\d{1,5}$/.test(form.port.trim()) && +form.port >= 1 && +form.port <= 65535);
  const connectionOk = addressOk && portOk && !!url;
  // the account is optional (anonymous broker): done with the connection
  const [picked, connected, account, tested] = stepStates([!!broker, connectionOk, connectionOk, test?.level === 'ok' || test?.level === 'warn']);
  const dynsecInfo = info ?? (broker?.dynsec ? { state: 'active' as const, managed } : null);

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
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null || !nameOk || !test || test.level === 'error'} onClick={() => void save()}>Enregistrer</Button>
          </>
        }
      >
        <div className="flex h-full min-h-0 flex-col gap-4">
          <label className="block max-w-md shrink-0">
            <span className={field}>Nom du rôle</span>
            <input className="input" maxLength={64} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="zigbee2mqtt, esphome…" autoFocus={!role} />
            <span className="mt-1 block text-xs text-muted">L'identifiant du broker dans les sondes et le pont Home Assistant.</span>
          </label>
          <div className="min-h-0 flex-1">
            <Steps fill>
              <Step n={1} title="Broker" state={picked} intro={role ? 'Choisir un autre broker déplace le rôle, ses paramètres gardés.' : 'Les brokers que les agents ont trouvés sur leur hôte.'}>
                {!brokers.length ? (
                  <p className="text-sm text-muted">Aucun broker détecté par les agents. Il faut un agent HLM sur l'hôte du broker.</p>
                ) : (
                  <div className="relative min-h-0 flex-1 space-y-1.5 overflow-y-auto">
                    {brokers.map((b) => {
                      const off = b.taken || b.listeners.every((l) => l.local) || (managed && b.host.id !== role!.carrier.id);
                      const on = key === brokerKey(b);
                      return (
                        <label key={brokerKey(b)} className={clsx('block rounded-md border px-3 py-2', on ? 'border-emerald-500/60 bg-emerald-500/5' : 'border-line', off ? 'opacity-50' : 'cursor-pointer hover:bg-raised/40')}>
                          <input type="radio" name="role-broker" className="sr-only" checked={on} disabled={off} onChange={() => choose(b)} />
                          <div className="truncate font-medium text-zinc-100">{b.host.name}</div>
                          <div className="text-xs text-muted">
                            {b.process ? `${b.process}${b.version ? ` ${b.version}` : ''}` : 'broker non détecté actuellement'}
                            {b.taken ? ' · déjà déclaré' : b.listeners.every((l) => l.local) ? ' · en écoute locale seulement : injoignable par le hub' : ''}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </Step>
              <Step n={2} title="Protocole" state={connected} intro="Comment le hub joint le broker.">
                <div className="space-y-1.5">
                  {protocols.map((p) => {
                    const on = form.scheme === p.scheme;
                    return (
                      <label key={p.scheme} className={clsx('block cursor-pointer rounded-md border px-3 py-2', on ? 'border-emerald-500/60 bg-emerald-500/5' : 'border-line hover:bg-raised/40')}>
                        <input type="radio" name="role-protocol" className="sr-only" checked={on} onChange={() => set({ scheme: p.scheme })} />
                        <div className="font-medium text-zinc-100">{p.label}</div>
                        <div className="text-xs text-muted">{p.hint}</div>
                      </label>
                    );
                  })}
                </div>
                <p className="pt-1 text-[11px] font-medium tracking-wide text-muted uppercase">Facultatif</p>
                <label className="block">
                  <span className={field}>Adresse IP</span>
                  <input className="input font-mono text-xs" value={form.address} onChange={(e) => set({ address: e.target.value.trim() })} placeholder={hostIp || "IP de l'hôte"} spellCheck={false} />
                  <span className="mt-1 block text-xs text-muted">Par défaut, l'IP de l'hôte relevée par son agent. À renseigner pour une autre IP ou un nom DNS.</span>
                </label>
                <label className="block">
                  <span className={field}>Port</span>
                  <input className="input font-mono text-xs" inputMode="numeric" value={form.port} onChange={(e) => set({ port: e.target.value.trim() })} placeholder={String(defaultPort(broker, form.scheme))} />
                  <span className="mt-1 block text-xs text-muted">Par défaut, le port relevé par l'agent pour ce protocole, sinon {MQTT_PORT}.</span>
                </label>
              </Step>
              <Step
                n={3}
                title="Identifiants"
                state={account}
                intro={managed ? 'Les comptes de ce broker sont gérés par HLM : le compte est créé, ou son mot de passe changé, sur le broker à l\'enregistrement.' : 'Facultatif : laisser vide pour un broker anonyme. Le compte doit exister sur le broker.'}
              >
                <label className="block">
                  <span className={field}>Utilisateur</span>
                  <input className="input" value={form.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />
                </label>
                <div className="block">
                  <span className={field}>Mot de passe</span>
                  <div className="flex gap-1.5">
                    <input
                      className="input min-w-0 flex-1"
                      type={generated ? 'text' : 'password'}
                      value={password}
                      disabled={clearPassword}
                      onChange={(e) => (setPassword(e.target.value), setGenerated(false), setTest(null))}
                      placeholder={role?.hasSecret ? '••••••••' : ''}
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                    <Button icon={RefreshCw} aria-label="Générer un mot de passe" title="Générer un mot de passe" disabled={busy !== null} onClick={regenerate} />
                  </div>
                  {role?.hasSecret && !password && <span className="mt-1 block text-xs text-muted">Laisser vide pour garder le mot de passe enregistré</span>}
                  {generated && password && (
                    <div className="mt-2 space-y-1">
                      <CopyField value={password} />
                      <span className="block text-xs text-muted">{managed ? 'Enregistré sur le broker et dans le rôle à l\'enregistrement.' : 'À reporter sur le broker : HLM ne le connaît que pour ce rôle.'}</span>
                    </div>
                  )}
                </div>
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
                intro="Le hub se connecte au broker avec ces identifiants ; l'enregistrement n'est possible qu'après un test réussi."
                footer={
                  <Button className="w-full" variant={tested === 'active' ? 'primary' : 'secondary'} icon={Plug} loading={busy === 'test'} disabled={busy !== null || !broker || !connectionOk} onClick={() => void runTest()}>
                    {test ? 'Tester à nouveau' : 'Tester la connexion'}
                  </Button>
                }
              >
                <DetectedRows
                  rows={[
                    { label: 'Nom', value: form.name, empty: 'non renseigné' },
                    { label: 'Hôte', value: host?.name, empty: 'non choisi' },
                    { label: 'URL', value: url, empty: host ? "IP de l'hôte inconnue : la saisir" : 'broker non choisi' },
                    { label: 'Utilisateur', value: form.username, empty: 'anonyme' },
                  ]}
                />
                <CheckLine label="Broker MQTT" check={test} idle={url || '—'} />
                {dynsecInfo && (
                  <p className="flex items-start gap-1.5 text-xs text-muted">
                    <ShieldCheck className={clsx('mt-0.5 h-3.5 w-3.5 shrink-0', dynsecInfo.managed ? 'text-emerald-400' : 'text-zinc-500')} aria-hidden />
                    <span>
                      Pour info : {dynsecInfo.managed ? 'comptes gérés par HLM (dynamic-security)' : DYNSEC_INFO[dynsecInfo.state]}
                      {dynsecInfo.state === 'unavailable' && dynsecInfo.reason ? ` (${dynsecInfo.reason})` : ''}.
                    </span>
                  </p>
                )}
              </Step>
            </Steps>
          </div>
        </div>
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

const presentedOf = (r: HubRoleTest): PresentedFingerprint | null =>
  !r.ok && r.fingerprint && r.source ? { fingerprint: r.fingerprint, source: r.source, agentFingerprint: r.agentFingerprint, agentError: r.agentError } : null;

// The fingerprint the controller presents, before it is pinned (homelab#300). agent: read the same on the host by the
// agent of the carrier; network: nothing to compare it to, the admin compares it first; mismatch: never pinned.
function FingerprintOffer({ presented, port, carrierName, onPin, onBack }: { presented: PresentedFingerprint; port: string; carrierName?: string; onPin: () => void; onBack: () => void }) {
  const { source } = presented;
  return (
    <div
      className={clsx(
        'space-y-2 rounded-md border px-3 py-2 text-xs',
        source === 'agent' ? 'border-emerald-500/40 bg-emerald-500/5' : source === 'mismatch' ? 'border-red-500/40 bg-red-500/5' : 'border-amber-500/40 bg-amber-500/5',
      )}
    >
      {source === 'agent' && <p className="text-emerald-300">Certificat présenté par le contrôleur, identique à celui que l'agent de {carrierName ?? 'son porteur'} lit sur l'hôte.</p>}
      {source === 'mismatch' && (
        <p className="text-red-300">
          L'agent de {carrierName ?? 'son porteur'} lit un autre certificat sur l'hôte : interception entre le hub et le contrôleur, ou l'adresse n'est pas celle de cet hôte. Il n'est pas épinglé.
        </p>
      )}
      {source === 'network' && (
        <>
          <p className="text-amber-300">Certificat présenté par le contrôleur, lu par le réseau sans vérification : le comparer avant de l'épingler.</p>
          <ul className="list-disc space-y-1 pl-4 text-zinc-300">
            <li>cadenas du navigateur sur l'interface du contrôleur (empreinte SHA-256 du certificat) ;</li>
            <li>
              ou, sur sa machine : <code className="break-all">openssl s_client -connect 127.0.0.1:{port} &lt;/dev/null 2&gt;/dev/null | openssl x509 -noout -fingerprint -sha256</code>
            </li>
          </ul>
          {presented.agentError && <p className="text-muted">Lecture par l'agent impossible : {presented.agentError}</p>}
        </>
      )}
      <p className="font-mono break-all text-zinc-200">{source === 'mismatch' ? `réseau : ${presented.fingerprint}` : presented.fingerprint}</p>
      {source === 'mismatch' && <p className="font-mono break-all text-zinc-200">hôte : {presented.agentFingerprint}</p>}
      <div className="flex gap-2">
        {source !== 'mismatch' && (
          <Button size="sm" variant="primary" onClick={onPin}>
            Épingler l'empreinte
          </Button>
        )}
        <Button size="sm" onClick={onBack}>Retour</Button>
      </div>
    </div>
  );
}

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
  const [presented, setPresented] = useState<PresentedFingerprint | null>(null);
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
      const r = await api.roleProbe(url, form.fingerprint.trim(), carrier);
      setProbe(r.ok ? { level: 'ok', title: 'Le contrôleur répond', detail: r.detail ?? url } : { level: 'error', title: 'Échec', detail: r.error ?? 'échec' });
      setPresented(presentedOf(r));
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
      setPresented(await api.roleFingerprint(url, carrier));
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
      setPresented(presentedOf(r));
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
              <FingerprintOffer presented={presented} port={form.port} carrierName={carrierName} onPin={() => set({ fingerprint: presented.fingerprint })} onBack={() => setPresented(null)} />
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
// The management of the accounts of a broker (dynamic-security), as an icon beside its name: green when HLM runs it, grey
// when it is only possible (or loaded but run outside HLM); nothing when unavailable.
function DynsecIcon({ role }: { role: MqttHubRole }) {
  const s = role.security;
  if (s.state === 'unavailable') return null;
  const managed = s.state === 'active' && !!s.managed;
  const title = managed
    ? 'Comptes gérés par HLM (dynamic-security) : Paramètres › MQTT'
    : s.state === 'active'
      ? 'dynamic-security chargé, mais géré en dehors de HLM'
      : `Gestion des comptes par HLM possible${s.version ? ` (Mosquitto ${s.version})` : ''} : à activer dans Paramètres › MQTT`;
  return (
    <Link to="/settings?tab=mqtt" title={title} aria-label={title} className="shrink-0">
      <ShieldCheck className={clsx('h-3.5 w-3.5', managed ? 'text-emerald-400' : 'text-zinc-500')} aria-hidden />
    </Link>
  );
}

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
  // the main PBS issues the tokens of the hosts: their regeneration at once starts from it (#205)
  const [rotating, setRotating] = useState(false);
  const askRemove = (r: HubRole) => (r.type === 'pbs-primary' || r.type === 'pbs-offsite' ? setDisconnecting(r.type) : setRemoving(r));
  const uses = (r: HubRole) => r.uses ?? [];
  const actions = (r: HubRole) => (
    <div className="flex shrink-0 items-center gap-1.5">
      {r.type === 'pbs-primary' && <Button size="sm" icon={KeyRound} aria-label="Régénérer les jetons des hôtes" title="Régénérer les jetons des hôtes" onClick={() => setRotating(true)} />}
      <Button size="sm" icon={Pencil} aria-label={`Modifier ${r.name}`} title="Modifier" onClick={() => edit(r)} />
      <Button size="sm" variant="danger" icon={Trash2} aria-label={`Supprimer ${r.name}`} title={uses(r).length ? `Utilisé par : ${uses(r).join(', ')}` : r.type.startsWith('pbs-') ? 'Déconnecter' : 'Supprimer'} disabled={uses(r).length > 0} onClick={() => askRemove(r)} />
    </div>
  );
  // the carrier, a host or an equipment (an Omada controller)
  const carrierLink = (r: HubRole) => <Link className="underline" to={r.carrier.kind === 'equipment' ? `/equipments/${r.carrier.id}` : `/hosts/${r.carrier.id}`}>{r.carrier.name || 'porteur introuvable'}</Link>;
  // by type, in the order of the catalog of the types
  const groups = ROLE_TYPES.map((t) => ({ type: t.id, label: t.label, list: (roles ?? []).filter((r) => r.type === t.id) })).filter((g) => g.list.length);
  const groupTitle = (g: (typeof groups)[number]) => {
    const Icon = roleIcon[g.type];
    return (
      <span className="flex items-center gap-2">
        <span className={clsx('inline-flex h-6 w-6 items-center justify-center rounded-md ring-1 ring-inset', roleTint[g.type])}><Icon className="h-3.5 w-3.5" aria-hidden /></span>
        <span className="font-medium text-zinc-100">{g.label}</span>
        <span className="text-xs text-muted">{g.list.length}</span>
      </span>
    );
  };
  const cluster = editing?.type === 'pve-cluster' && editing.role ? pve?.clusters.find((c) => c.id === editing.role!.config.cluster) ?? null : null;

  return (
    <Panel title="Rôles du hub" icon={Radio} bodyClassName="" actions={<Button size="sm" icon={Plus} onClick={() => setPicking(true)}>Déclarer un rôle</Button>}>
      <p className="border-b border-line px-4 py-3 text-xs text-muted">
        Ce que le hub peut faire grâce à un hôte du homelab : un broker MQTT est écouté par les sondes MQTT et peut servir à l'intégration Home Assistant ; le
        cluster Proxmox VE donne l'inventaire de ses nœuds, VM et CT, relie les hôtes à leur VM ou CT et leur rattache les sauvegardes vzdump ; le PBS principal reçoit les sauvegardes, le
        PBS hors site en copie chaque jour une sélection ; un contrôleur Omada ouvre au hub l'Open API du réseau d'un site. Un rôle utilisé ne peut pas être
        supprimé, ni l'hôte ou l'équipement qui le porte.
      </p>
      {!!pbs?.pinRefused?.length && (
        <div className="space-y-2 border-b border-line bg-amber-500/5 px-4 py-3 text-xs">
          <p className="text-amber-300">
            Le PBS principal est refusé par {pbs.pinRefused.length > 1 ? `${pbs.pinRefused.length} hôtes` : 'un hôte'} : un autre PBS y est épinglé par la politique locale,
            leurs sauvegardes échouent. Le hub ne peut pas lever ce verrou : sur chaque hôte, supprimer le fichier d'épinglage (le PBS suivant est retenu) ou ajouter
            l'empreinte du nouveau PBS à <code>backup.pbsFingerprints</code> de <code>/etc/homelab-agent/policy.json</code>.
          </p>
          <ul className="space-y-1">
            {pbs.pinRefused.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-2">
                <Link className="underline" to={`/hosts/${h.id}`}>{h.name}</Link>
                <code className="font-mono text-zinc-300">rm {h.pinFile}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {isLoading ? (
        <div className="flex justify-center p-6"><Spinner /></div>
      ) : error ? (
        <p className="p-4 text-sm text-red-400">{(error as Error).message}</p>
      ) : !roles?.length ? (
        <p className="p-4 text-sm text-muted">Aucun rôle : pas de sauvegarde, de sonde MQTT, d'intégration Home Assistant ni d'inventaire Proxmox VE.</p>
      ) : (
        <>
          <ResponsiveList mode="mobile">
            {groups.map((g) => (
              <section key={g.type}>
                <div className="bg-raised/30 px-4 py-2">{groupTitle(g)}</div>
                {g.list.map((r) => (
                  <article key={r.id} className="min-w-0 space-y-2 border-t border-line p-4">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-1.5 font-medium text-zinc-100">
                        <span className="truncate">{r.name}</span>
                        {r.type === 'mqtt-broker' && <DynsecIcon role={r} />}
                      </span>
                      <Badge tone={roleStatus(r).tone}>{roleStatus(r).label}</Badge>
                    </div>
                    <p className="break-all font-mono text-xs text-muted">{r.url || 'adresse inconnue'}</p>
                    {r.type === 'mqtt-broker' && r.anonymous && <p className="text-xs text-red-300">Connexions anonymes acceptées : {ANONYMOUS_HINT}</p>}
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-muted">{carrierLink(r)} · {uses(r).join(', ') || r.summary || 'inutilisé'}</p>
                      {actions(r)}
                    </div>
                  </article>
                ))}
              </section>
            ))}
          </ResponsiveList>
          <ResponsiveList mode="desktop">
            {/* fixed widths: the groups, one under the other, keep the same columns */}
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col className="w-[16%]" />
                <col className="w-[13%]" />
                <col className="w-[22%]" />
                <col className="w-[14%]" />
                <col className="w-[13%]" />
                <col />
                <col className="w-32" />
              </colgroup>
              <thead className="border-b border-line">
                <tr>
                  <th className="th">Nom</th>
                  <th className="th">Porteur</th>
                  <th className="th">Adresse</th>
                  <th className="th">Compte</th>
                  <th className="th">Connexion</th>
                  <th className="th">Utilisé par</th>
                  <th className="th" />
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g.type} className="divide-y divide-line border-b border-line last:border-b-0">
                  <tr className="bg-raised/30">
                    <th colSpan={7} className="px-4 py-2 text-left font-normal">{groupTitle(g)}</th>
                  </tr>
                  {g.list.map((r) => (
                    <tr key={r.id} className="hover:bg-raised/40">
                      <td className="td truncate font-medium text-zinc-100" title={r.name}>
                        <span className="inline-flex max-w-full items-center gap-1.5">
                          <span className="truncate">{r.name}</span>
                          {r.type === 'mqtt-broker' && <DynsecIcon role={r} />}
                        </span>
                      </td>
                      <td className="td truncate">{carrierLink(r)}</td>
                      <td className="td truncate font-mono text-xs text-zinc-300" title={r.url || undefined}>{r.url || 'inconnue'}</td>
                      <td className="td truncate text-muted" title={r.account || undefined}>{r.account || 'anonyme'}</td>
                      <td className="td">
                        <Badge tone={roleStatus(r).tone}>{roleStatus(r).label}</Badge>
                        {r.status?.error && <p className="mt-0.5 truncate text-xs text-amber-300" title={r.status.error}>{r.status.error}</p>}
                        {r.type === 'mqtt-broker' && r.anonymous && <p className="mt-0.5 truncate text-xs text-red-300" title={ANONYMOUS_HINT}>connexions anonymes acceptées</p>}
                      </td>
                      <td className="td truncate text-muted" title={uses(r).join(', ') || r.summary || undefined}>{uses(r).join(', ') || r.summary || '—'}</td>
                      <td className="td"><div className="flex justify-end">{actions(r)}</div></td>
                    </tr>
                  ))}
                </tbody>
              ))}
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
      {rotating && <PbsRotateModal open onClose={() => setRotating(false)} />}
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
