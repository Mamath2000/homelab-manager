import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Boxes, Cpu, Home, KeyRound, Network, Pencil, Plug, Plus, RefreshCw, Save, ScrollText, ShieldCheck, Trash2 } from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, type BrokerScheme, type Equipment, type EsphomeHubRole, type HaHubRole, type Host, type HubRole, type HubRoleTest, type HubRoleType, type LogHubRole, type MqttHubRole, type OmadaHubRole, type PresentedFingerprint, type PveHubRole, type RoleCandidate } from '../lib/api';
import { keys, useEquipments, useHosts, useRoles, useSites } from '../lib/queries';
import { ROLE_TYPES, SINGLE_ROLES, lanAddress, siteRoleName, ofManagedBroker, roleStatus } from '../lib/roles';
import { roleAccent, roleIcon, roleTint } from '../lib/hostSkills';
import { ROLE_PAGES, roleOfPage, rolePagesOf } from '../lib/roleSettings';
import { stepStates } from '../lib/steps';
import { useToast } from '../lib/toast';
import { CheckLine, DetectedRows, Step, Steps, type CheckState } from './PbsDialog';
import { field } from './ProxmoxServer';
import { PbsModal } from './BackupSettings';
import { RemoteModal } from './OffsiteSettings';
import { PbsDisconnectModal } from './PbsDisconnect';
import { PbsRotateModal } from './PbsRotate';
import { ClusterModal } from './PveSettings';
import { Badge, Button, ConfirmModal, CopyField, Modal, Spinner } from './ui';
import { EsphomeInventory } from './EsphomeInventory';
import { HomeAssistantPanel } from './HomeAssistantPanel';
import { haQueryKey } from '../lib/haDetail';
import { LogHostsSettings } from './LogHosts';
import { BrokerCardControls, MqttAccountsModal, type BrokerCardSlots } from './MqttSecurity';
import { OmadaInventory } from './OmadaInventory';
import { PveInventory } from './PveInventory';

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
  available: 'gestion des comptes par HLM possible (dynamic-security), à activer dans la carte du rôle',
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
  const { data: allSites = [] } = useSites();
  const brokerName = (h: Host) =>
    siteRoleName('MQTT', allSites.find((x) => x.id === h.siteId)?.name, h.name, roles.filter((r) => r.id !== role?.id && r.type === 'mqtt-broker').map((r) => r.name));
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
  // never typed: see brokerName
  const moved = !!role && !!host && host.id !== role.carrier.id;
  const roleName = host ? brokerName(host) : '';
  const save = async () => {
    setBusy('save');
    try {
      if (role) await api.updateRole(role.id, { ...(moved ? { carrier } : {}), name: roleName, config: config() });
      else await api.createRole({ type, carrier, name: roleName, config: config() });
      await Promise.all([qc.invalidateQueries({ queryKey: keys.roles }), qc.invalidateQueries({ queryKey: keys.mqttBrokers }), qc.invalidateQueries({ queryKey: ['mqtt-accounts'] })]);
      toast.success(role ? `Rôle ${roleName} modifié` : `Rôle ${roleName} déclaré`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const nameOk = roleName.length > 0;
  const addressOk = /^[A-Za-z0-9.:_-]*$/.test(form.address);
  const portOk = !form.port.trim() || (/^\d{1,5}$/.test(form.port.trim()) && +form.port >= 1 && +form.port <= 65535);
  const connectionOk = addressOk && portOk && !!url;
  // the account is optional (anonymous broker): done with the connection
  // the account (step 3) is optional: nothing to validate, reached when needed
  const [picked, connected, tested] = stepStates([!!broker, connectionOk, test?.level === 'ok' || test?.level === 'warn']);
  // editing: the broker is tested on opening, the window shows its state at once
  const autoTested = useRef(false);
  useEffect(() => {
    if (autoTested.current || !role || !broker || !connectionOk) return;
    autoTested.current = true;
    void runTest();
  });
  const dynsecInfo = info ?? (broker?.dynsec ? { state: 'active' as const, managed } : null);

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        wide="screen"
        wider
        fixed
        title={role ? `Broker MQTT · ${role.name}` : 'Nouveau rôle Broker MQTT'}
        footer={
          <>
            <Button variant="ghost" disabled={busy !== null} onClick={requestClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null || !nameOk || !test || test.level === 'error'} onClick={() => void save()}>Enregistrer</Button>
          </>
        }
      >
        <div className="flex h-full min-h-0 flex-col gap-4">
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
                state="optional"
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
                    { label: 'Nom', value: roleName, empty: 'broker non choisi' },
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
  address: string;
  port: string;
  fingerprint: string;
  clientId: string;
  // the site of the controller this role reads (typed, or picked among the ones the application sees) and the site of the homelab
  omadaSite: string;
  siteId: string;
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
// must not extend the window) and what the carrier is. group: the radio group, when a window has several lists; disabled:
// a choice offered but taken.
function CarrierRow({ on, onPick, title, children, group = 'role-carrier', disabled }: { on: boolean; onPick: () => void; title: string; children: React.ReactNode; group?: string; disabled?: boolean }) {
  return (
    <label className={clsx('block rounded-md border px-3 py-2', on ? 'border-emerald-500/60 bg-emerald-500/5' : 'border-line', disabled ? 'opacity-50' : 'cursor-pointer hover:bg-raised/40')}>
      <input type="radio" name={group} className="sr-only" checked={on} disabled={disabled} onChange={onPick} />
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
  const [initialCarrier] = useState<OmadaCarrier | null>(() => (role && role.carrier.kind !== 'hub' ? { kind: role.carrier.kind, id: role.carrier.id } : null));
  const [carrier, setCarrier] = useState<OmadaCarrier | null>(initialCarrier);
  const [initial] = useState<OmadaForm>(() => ({ ...(role ? splitUrl(role.config.url) : { address: '', port: String(OMADA_PORT) }), fingerprint: role?.config.fingerprint ?? '', clientId: role?.config.clientId ?? '', omadaSite: role?.config.omadaSite ?? '', siteId: role?.config.siteId ?? '' }));
  const [form, setForm] = useState<OmadaForm>(initial);
  const [secret, setSecret] = useState('');
  const { data: homelabSites = [] } = useSites();
  const { data: allRoles = [] } = useRoles();
  const [busy, setBusy] = useState<'save' | 'test' | 'read' | 'probe' | 'sites' | null>(null);
  const [test, setTest] = useState<CheckState>(null);
  // the sites of the controller the application sees, read by « Récupérer les sites » (step 3)
  const [omadaSites, setOmadaSites] = useState<{ id: string; name: string }[] | null>(null);
  const [sitesError, setSitesError] = useState<string | null>(null);
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
    setOmadaSites(null);
    setSitesError(null);
  };
  // the sites do not change what was checked of the controller, only the test of the connection
  const setSite = (patch: Partial<Pick<OmadaForm, 'omadaSite' | 'siteId'>>) => {
    setForm({ ...form, ...patch });
    setTest(null);
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
  const config = () => ({ url, fingerprint: form.fingerprint.trim(), clientId: form.clientId.trim(), ...(secret ? { clientSecret: secret } : {}), omadaSite: form.omadaSite.trim(), siteId: form.siteId });
  // « Récupérer les sites »: what the application sees on the controller, to pick the site of the role
  const getSites = async () => {
    setBusy('sites');
    setOmadaSites(null);
    setSitesError(null);
    setPresented(null);
    try {
      const c = config();
      const r = await api.omadaSites({ carrier: carrier!, config: { url: c.url, fingerprint: c.fingerprint, clientId: c.clientId, ...(c.clientSecret ? { clientSecret: c.clientSecret } : {}) }, ...(role ? { roleId: role.id } : {}) });
      if (r.ok) setOmadaSites(r.sites ?? []);
      else setSitesError(r.error ?? 'échec');
      setPresented(presentedOf(r));
    } catch (err) {
      setSitesError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
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
  // never typed: « Omada — <site of the homelab> », with the carrier in brackets when the name is taken
  const roleName = siteRoleName('Omada', homelabSites.find((x) => x.id === form.siteId)?.name, carrierName, allRoles.filter((r) => r.id !== role?.id && r.type === 'omada-controller').map((r) => r.name));
  const save = async () => {
    setBusy('save');
    try {
      const moved = role && (carrier!.id !== role.carrier.id || carrier!.kind !== role.carrier.kind);
      if (role) await api.updateRole(role.id, { ...(moved ? { carrier: carrier! } : {}), name: roleName, config: config() });
      else await api.createRole({ type, carrier: carrier!, name: roleName, config: config() });
      await qc.invalidateQueries({ queryKey: keys.roles });
      toast.success(role ? `Rôle ${roleName} modifié` : `Rôle ${roleName} déclaré`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const addressOk = ADDRESS_RE.test(form.address.trim());
  const portOk = portValid(form.port);
  const fingerprintOk = !form.fingerprint.trim() || FINGERPRINT_RE.test(normalizeFingerprint(form.fingerprint));
  const controllerOk = addressOk && portOk && fingerprintOk;
  const appOk = form.clientId.trim().length > 0 && (!!secret || !!role?.hasSecret);
  const siteOk = form.omadaSite.trim().length > 0 && homelabSites.some((x) => x.id === form.siteId);
  const [carried, configured, application, tested] = stepStates([!!carrier, controllerOk, appOk && siteOk, test?.level === 'ok']);
  // editing: the controller is tested on opening, the window shows its state at once
  const autoTested = useRef(false);
  useEffect(() => {
    if (autoTested.current || !role || !carrier || !controllerOk || !appOk || !siteOk) return;
    autoTested.current = true;
    void runTest();
  });

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        wide="screen"
        wider
        fixed
        title={role ? `Contrôleur Omada · ${role.name}` : 'Nouveau rôle Contrôleur Omada'}
        footer={
          <>
            <Button variant="ghost" disabled={busy !== null} onClick={requestClose}>Annuler</Button>
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
          <Step n={3} title="Application et site" state={application} intro="Une application de l'Open API du contrôleur, en mode client (Client Credentials). Un rôle lit un seul site du contrôleur : déclarer le contrôleur une fois par site à suivre.">
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
                onChange={(e) => (setSecret(e.target.value), setTest(null), setPresented(null), setOmadaSites(null), setSitesError(null))}
                placeholder={role?.hasSecret ? '••••••••' : ''}
                autoComplete="new-password"
              />
              {role?.hasSecret && <span className="mt-1 block text-xs text-muted">Laisser vide pour garder le secret enregistré</span>}
            </label>
            <label className="block">
              <span className={field}>Site du contrôleur</span>
              <input className="input" maxLength={128} value={form.omadaSite} onChange={(e) => setSite({ omadaSite: e.target.value })} placeholder="nom du site dans Omada" autoComplete="off" spellCheck={false} />
              {role && !role.config.omadaSite && <span className="mt-1 block text-xs text-amber-300">Rôle déclaré avant « un rôle par site » : choisir le site à lire</span>}
            </label>
            <Button size="sm" variant="secondary" icon={Plug} loading={busy === 'sites'} disabled={busy !== null || !carrier || !controllerOk || !appOk} onClick={() => void getSites()}>
              Récupérer les sites
            </Button>
            {sitesError && <p className="text-xs text-amber-300">{sitesError}</p>}
            {presented && busy === null && <p className="text-xs text-amber-300">Le certificat du contrôleur est refusé : épingler son empreinte à l'étape 2.</p>}
            {omadaSites && (
              <div className="space-y-1.5">
                <span className={field}>Sites vus par l'application</span>
                {omadaSites.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {omadaSites.map((s) => (
                      <Button key={s.id} size="sm" variant={form.omadaSite.trim().toLowerCase() === s.name.toLowerCase() ? 'primary' : 'secondary'} onClick={() => setSite({ omadaSite: s.name })}>
                        {s.name}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-amber-300">L'application ne voit aucun site : lui donner accès dans Omada.</p>
                )}
              </div>
            )}
            <label className="block">
              <span className={field}>Site du homelab</span>
              <select className="input" value={form.siteId} onChange={(e) => setSite({ siteId: e.target.value })}>
                <option value="">— choisir —</option>
                {homelabSites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-muted">Site des équipements créés depuis ce rôle</span>
            </label>
          </Step>
          <Step
            n={4}
            title="Test de connexion"
            state={tested}
            intro="Le hub demande un jeton au contrôleur avec cette application, puis cherche le site dans la liste de ses sites ; l'enregistrement n'est possible qu'après un test réussi."
            footer={
              <Button className="w-full" variant={tested === 'active' ? 'primary' : 'secondary'} icon={Plug} loading={busy === 'test'} disabled={busy !== null || !carrier || !controllerOk || !appOk || !siteOk} onClick={() => void runTest()}>
                {test ? 'Tester à nouveau' : 'Tester la connexion'}
              </Button>
            }
          >
            <DetectedRows
              rows={[
                { label: 'Nom', value: roleName, empty: 'site non choisi (étape 3)' },
                { label: 'Porteur', value: carrierName, empty: 'non choisi' },
                { label: 'Open API', value: addressOk && portOk ? url : '', empty: 'non renseignée' },
                { label: 'Empreinte', value: form.fingerprint && fingerprintOk ? normalizeFingerprint(form.fingerprint) : '', empty: 'aucune (autorités système)' },
                { label: 'Client ID', value: form.clientId, empty: 'non renseigné' },
                { label: 'Site Omada', value: form.omadaSite.trim(), empty: 'non renseigné (étape 3)' },
                { label: 'Site du homelab', value: homelabSites.find((x) => x.id === form.siteId)?.name ?? '', empty: 'non choisi (étape 3)' },
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

interface LogForm {
  name: string;
  // the query API of VictoriaLogs; https: behind a reverse proxy, the only case with an account
  apiAddress: string;
  apiPort: string;
  https: boolean;
  username: string;
  // where the hosts send their journals, as rsyslog reads it: tcp://server:port
  destination: string;
  silentHours: string;
  // where the collectors of the containers send (homelab#346); '': the TCP listener tagged source=docker, read in its flags
  dockerPort: string;
}

const LOG_API_PORT = 9428;
// the standard syslog port, the one proposed when the agent saw no other
const LOG_SYSLOG_PORT = 514;
const bracket = (a: string) => (a.includes(':') && !a.startsWith('[') ? `[${a}]` : a);
const logUrl = (f: Pick<LogForm, 'apiAddress' | 'apiPort' | 'https'>) => `${f.https ? 'https' : 'http'}://${bracket(f.apiAddress)}:${f.apiPort}`;
const tcpUrl = (address: string, port: number) => `tcp://${bracket(address)}:${port}`;

// the server and the port of a destination typed as tcp://server:port, null when it is not one
function parseDestination(d: string) {
  const m = /^tcp:\/\/(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9._-]+):(\d{1,5})\/?$/.exec(d.trim());
  if (!m || !portValid(m[2])) return null;
  return { address: m[1].replace(/^\[|\]$/g, ''), port: +m[2] };
}

function splitLogUrl(url: string) {
  try {
    const u = new URL(url);
    return { apiAddress: u.hostname.replace(/^\[|\]$/g, ''), apiPort: u.port || (u.protocol === 'https:' ? '443' : '80'), https: u.protocol === 'https:' };
  } catch {
    return { apiAddress: '', apiPort: String(LOG_API_PORT), https: false };
  }
}

// Declares a log server role, or edits one (another carrier moves it). Four steps: the host of VictoriaLogs (the ones its
// agent found; the others on demand), its API (where the hub reads, tested there), the configuration (when a silent host
// is a drift, where the hosts send), and a summary to save. VictoriaLogs has no account: one is typed only behind an
// HTTPS reverse proxy. The password is never sent back.
export function LogServerWizard({ role, onClose }: { role: LogHubRole | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: hosts = [] } = useHosts();
  const type = 'log-server' as const;
  const [initialCarrier] = useState<string | null>(() => role?.carrier.id ?? null);
  const [carrier, setCarrier] = useState<string | null>(initialCarrier);
  const [initial] = useState<LogForm>(() => ({
    name: role?.name ?? '',
    ...(role ? splitLogUrl(role.config.url) : { apiAddress: '', apiPort: String(LOG_API_PORT), https: false }),
    username: role?.config.username ?? '',
    destination: role?.target ?? '',
    silentHours: String(role?.config.silentHours ?? 6),
    dockerPort: role?.config.dockerPort ? String(role.config.dockerPort) : '',
  }));
  const [form, setForm] = useState<LogForm>(initial);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'reception' | null>(null);
  // the test of the API (step 2): made void by any change of what it reached
  const [test, setTest] = useState<CheckState>(null);
  // the test of the reception (step 3): a syslog line sent to the destination, then read back through the API
  const [reception, setReception] = useState<CheckState>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const setApi = (patch: Partial<LogForm>) => {
    setForm({ ...form, ...patch });
    setTest(null);
    setReception(null);
  };
  const setConf = (patch: Partial<LogForm>) => {
    setForm({ ...form, ...patch });
    if ('destination' in patch) setReception(null);
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || carrier !== initialCarrier || !!secret;
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  // the hosts whose agent sees a VictoriaLogs; the others only on demand (a server the detection misses: API on another
  // port behind Docker, or behind a proxy)
  const found = (h: Host) => (h.roleCandidates ?? []).filter((c) => c.type === 'log-server' && !c.local);
  const detected = hosts.filter((h) => found(h).length);
  const others = hosts.filter((h) => !found(h).length);
  const [showOthers, setShowOthers] = useState(() => !!role && !detected.some((h) => h.id === role.carrier.id));
  const host = hosts.find((h) => h.id === carrier);
  const pickHost = (h: Host) => {
    const c = found(h);
    const lan = lanAddress(h.info?.ips);
    setCarrier(h.id);
    setForm({
      ...form,
      name: form.name || `Logs ${h.name}`,
      apiAddress: lan,
      apiPort: String(c.find((x) => x.scheme === 'http')?.port ?? LOG_API_PORT),
      destination: lan ? tcpUrl(lan, c.find((x) => x.scheme === 'syslog')?.port ?? LOG_SYSLOG_PORT) : '',
    });
    setTest(null);
    setReception(null);
  };
  // the syslog ports Docker publishes, seen by the agent: the ones the hosts reach when they differ from the server's own
  const syslogPorts = host ? found(host).filter((c) => c.scheme === 'syslog').map((c) => c.port) : [];

  const url = logUrl(form);
  const dest = parseDestination(form.destination);
  const config = () => ({
    url,
    // the address of the carrier is the default: stored only when it is another one
    ...(dest && dest.address !== lanAddress(host?.info?.ips) ? { address: dest.address } : {}),
    // the test of the API does not need the destination: one being typed does not stop it
    port: dest?.port ?? LOG_SYSLOG_PORT,
    protocol: 'tcp' as const,
    username: form.https ? form.username.trim() : '',
    ...(form.https && secret ? { password: secret } : {}),
    silentHours: /^\d{1,2}$/.test(form.silentHours) ? Math.min(+form.silentHours, 24) : 6,
    ...(form.dockerPort && portValid(form.dockerPort) ? { dockerPort: +form.dockerPort } : {}),
  });
  // auto: the test made on opening a role to edit; it leaves the destination of the hosts as saved
  const runTest = async (auto = false) => {
    setBusy('test');
    setTest(null);
    try {
      const r = await api.testRole({ type, carrier: { kind: 'host', id: carrier! }, config: config(), ...(role ? { roleId: role.id } : {}) });
      setTest(r.ok ? { level: 'ok', title: 'API joignable', detail: r.detail ?? url } : { level: 'error', title: 'Échec', detail: r.error ?? 'échec' });
      // the destination of the hosts follows what the test read: the server reached, on the port VictoriaLogs receives on
      // (published by Docker when the agent sees it, else read in its flags)
      const tcp = r.ok ? (r.syslog?.tcp ?? []) : [];
      const port = syslogPorts.find((p) => tcp.includes(p)) ?? syslogPorts[0] ?? tcp[0];
      if (r.ok && port && !auto) {
        setForm((f) => ({ ...f, destination: tcpUrl(f.apiAddress, port) }));
        setReception(null);
      }
    } catch (err) {
      setTest({ level: 'error', title: 'Échec', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const runReception = async () => {
    setBusy('reception');
    setReception(null);
    try {
      const r = await api.testLogReception({ carrier: { kind: 'host', id: carrier! }, config: config(), ...(role ? { roleId: role.id } : {}) });
      setReception(r.ok ? { level: 'ok', title: 'Journal de test reçu', detail: r.detail ?? destination } : { level: 'error', title: 'Non reçu', detail: r.error ?? 'échec' });
    } catch (err) {
      setReception({ level: 'error', title: 'Échec', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    try {
      const moved = role && carrier !== role.carrier.id;
      if (role) await api.updateRole(role.id, { ...(moved ? { carrier: { kind: 'host', id: carrier! } } : {}), name: form.name.trim(), config: config() });
      else await api.createRole({ type, carrier: { kind: 'host', id: carrier! }, name: form.name.trim(), config: config() });
      await Promise.all([qc.invalidateQueries({ queryKey: keys.roles }), qc.invalidateQueries({ queryKey: ['logs'] })]);
      toast.success(role ? `Rôle ${form.name.trim()} modifié` : `Rôle ${form.name.trim()} déclaré : la page Logs est ouverte`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const nameOk = form.name.trim().length > 0;
  const accountOk = !form.https || !secret || !!form.username.trim();
  const apiOk = nameOk && ADDRESS_RE.test(form.apiAddress.trim()) && portValid(form.apiPort) && accountOk;
  const silentOk = /^\d{1,2}$/.test(form.silentHours) && +form.silentHours <= 24;
  const dockerPortOk = !form.dockerPort || portValid(form.dockerPort);
  const destinationOk = !!dest;
  const configOk = silentOk && destinationOk && dockerPortOk;
  const tested = test?.level === 'ok';
  // the reception test (summary) is optional and never stops the save: the hub may not see the server as the hosts do
  // the configuration (step 3) is implicit: nothing to validate, reached when needed; the summary (step 4) follows the API test
  const [carried, reached, summary] = stepStates([!!carrier, apiOk && tested, false]);
  // editing: the API is tested on opening; when it answers, the window opens on the summary
  const autoTested = useRef(false);
  useEffect(() => {
    if (autoTested.current || !role || !carrier || !apiOk) return;
    autoTested.current = true;
    void runTest(true);
  });
  const destination = dest ? tcpUrl(dest.address, dest.port) : '';
  const sub = 'text-xs font-medium uppercase tracking-wide text-muted';

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        wide="screen"
        wider
        fixed
        title={role ? `Serveur de logs · ${role.name}` : 'Nouveau rôle Serveur de logs'}
        footer={
          <>
            <Button variant="ghost" disabled={busy !== null} onClick={requestClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null || !carrier || !apiOk || !tested || !configOk} onClick={() => void save()}>Enregistrer</Button>
          </>
        }
      >
        <Steps fill>
          <Step n={1} title="Hôte" state={carried} intro={role ? 'Choisir un autre hôte déplace le rôle, ses réglages gardés.' : "L'hôte où tourne VictoriaLogs."}>
            {!hosts.length ? (
              <p className="text-sm text-muted">Aucun hôte.</p>
            ) : (
              <div className="relative min-h-0 flex-1 space-y-1.5 overflow-y-auto">
                {detected.length > 0 ? (
                  <div className={listHead}>VictoriaLogs trouvé par l'agent</div>
                ) : (
                  <p className="text-xs text-amber-300">Aucun agent ne voit VictoriaLogs en écoute (processus victoria-logs, ou port 9428 publié par Docker). Choisir l'hôte où il tourne.</p>
                )}
                {detected.map((h) => (
                  <CarrierRow key={h.id} on={carrier === h.id} onPick={() => pickHost(h)} title={h.name}>
                    ports {found(h).map((c) => c.port).join(', ')} · {lanAddress(h.info?.ips) || 'adresse inconnue'}
                  </CarrierRow>
                ))}
                {detected.length > 0 && !showOthers && others.length > 0 && (
                  <button type="button" className="px-1 pt-1 text-xs text-emerald-400 hover:underline" onClick={() => setShowOthers(true)}>
                    Il n'est pas dans la liste ? Choisir un autre hôte
                  </button>
                )}
                {(showOthers || !detected.length) && others.length > 0 && (
                  <>
                    {detected.length > 0 && <div className={listHead}>Autres hôtes</div>}
                    {others.map((h) => (
                      <CarrierRow key={h.id} on={carrier === h.id} onPick={() => pickHost(h)} title={h.name}>
                        {lanAddress(h.info?.ips) || 'adresse inconnue'}
                      </CarrierRow>
                    ))}
                  </>
                )}
              </div>
            )}
          </Step>
          <Step
            n={2}
            title="API"
            state={reached}
            intro="Là où le hub lit les journaux."
            footer={
              <Button className="w-full" variant={reached === 'active' ? 'primary' : 'secondary'} icon={Plug} loading={busy === 'test'} disabled={busy !== null || !carrier || !apiOk} onClick={() => void runTest()}>
                {test ? "Tester l'API à nouveau" : "Tester l'API"}
              </Button>
            }
          >
            <label className="block">
              <span className={field}>Nom du rôle</span>
              <input className="input" maxLength={64} value={form.name} onChange={(e) => setApi({ name: e.target.value })} placeholder="Logs Vouillé…" />
            </label>
            <div className="grid grid-cols-[minmax(0,1fr)_4.5rem] gap-3">
              <label className="block">
                <span className={field}>Serveur (nom ou IP)</span>
                <input className="input font-mono text-xs" value={form.apiAddress} onChange={(e) => setApi({ apiAddress: e.target.value.trim() })} placeholder={carrier ? 'inconnu' : '—'} spellCheck={false} />
              </label>
              <label className="block">
                <span className={field}>Port de l'API</span>
                <input className="input font-mono text-xs" inputMode="numeric" value={form.apiPort} onChange={(e) => setApi({ apiPort: e.target.value.trim() })} />
              </label>
            </div>
            <label className="flex items-start gap-2 text-xs text-zinc-300">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-emerald-500" checked={form.https} onChange={(e) => setApi({ https: e.target.checked })} />
              <span>
                Derrière un reverse proxy HTTPS
                <span className="block text-muted">VictoriaLogs n'a pas d'authentification : un compte n'existe que si un proxy en demande un.</span>
              </span>
            </label>
            {form.https && (
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className={field}>Utilisateur du proxy</span>
                  <input className="input" value={form.username} onChange={(e) => setApi({ username: e.target.value })} autoComplete="off" spellCheck={false} />
                </label>
                <label className="block">
                  <span className={field}>Mot de passe</span>
                  <input className="input" type="password" value={secret} onChange={(e) => (setSecret(e.target.value), setTest(null))} placeholder={role?.hasSecret ? '••••••••' : ''} autoComplete="new-password" />
                </label>
              </div>
            )}
            {!accountOk && <span className="block text-xs text-amber-300">Mot de passe sans utilisateur</span>}
            <CheckLine label="API" check={test} idle={apiOk ? url : undefined} />
          </Step>
          <Step n={3} title="Configuration" state="optional">
            <section className="space-y-2">
              <h4 className={sub}>Hôte muet</h4>
              <label className="flex flex-wrap items-center gap-2 text-sm text-zinc-200">
                Alerter si un hôte n'a rien envoyé depuis
                <input className="input w-16 py-1 text-center font-mono text-xs" inputMode="numeric" value={form.silentHours} onChange={(e) => setConf({ silentHours: e.target.value.trim() })} />
                heures
              </label>
              <p className="text-xs text-muted">L'hôte passe en écart dans sa standardisation. 0 : jamais.</p>
              {!silentOk && <p className="text-xs text-amber-300">De 0 à 24 heures</p>}
            </section>
            <section className="space-y-2 border-t border-line pt-3">
              <h4 className={sub}>Envoi depuis les hôtes</h4>
              <label className="block">
                <span className={field}>Destination des journaux</span>
                <input className="input font-mono text-xs" value={form.destination} onChange={(e) => setConf({ destination: e.target.value.trim() })} placeholder="tcp://serveur:514" spellCheck={false} />
              </label>
              <p className="text-xs text-muted">
                Où rsyslog envoie les journaux de chaque hôte, en TCP. Remplie par le test de l'API (étape 2) avec le port où VictoriaLogs reçoit ; à changer
                seulement si les hôtes le joignent autrement.
              </p>
              {form.destination && !dest && <p className="text-xs text-amber-300">Format attendu : tcp://serveur:port</p>}
            </section>
            <section className="space-y-2 border-t border-line pt-3">
              <h4 className={sub}>Journaux des conteneurs</h4>
              <label className="block">
                <span className={field}>Port Docker (TCP)</span>
                <input className="input w-28 font-mono text-xs" inputMode="numeric" value={form.dockerPort} onChange={(e) => setConf({ dockerPort: e.target.value.trim() })} placeholder="auto" />
              </label>
              <p className="text-xs text-muted">
                Où les collecteurs des hôtes Docker envoient, en syslog TCP, à la même adresse que les hôtes. Vide : le listener TCP de VictoriaLogs marqué{' '}
                <span className="font-mono">source=docker</span> (lu dans ses options).
              </p>
              {!dockerPortOk && <p className="text-xs text-amber-300">Port invalide (1 à 65535)</p>}
            </section>
          </Step>
          <Step
            n={4}
            title="Récapitulatif"
            state={summary}
            footer={
              <Button className="w-full" variant="secondary" icon={Plug} loading={busy === 'reception'} disabled={busy !== null || !carrier || !apiOk || !tested || !destinationOk} onClick={() => void runReception()}>
                {reception ? 'Tester la réception à nouveau' : 'Tester la réception'}
              </Button>
            }
          >
            <DetectedRows
              rows={[
                { label: 'Nom', value: form.name, empty: 'non renseigné' },
                { label: 'Hôte', value: host?.name, empty: 'non choisi' },
                { label: 'API', value: apiOk ? url : '', empty: 'non renseignée', hint: tested ? 'testée' : "à tester (étape 2)" },
                ...(form.https ? [{ label: 'Compte du proxy', value: form.username, empty: 'aucun' }] : []),
                { label: 'Hôte muet', value: silentOk ? (+form.silentHours ? `alerte après ${form.silentHours} h` : 'pas d’alerte') : '', empty: 'à corriger (étape 3)' },
                { label: 'Envoi des hôtes', value: destinationOk ? destination : '', empty: 'à compléter (étape 3)', hint: reception?.level === 'ok' ? 'réception testée' : reception ? 'réception en échec (étape 3)' : 'réception non testée (étape 3)' },
                { label: 'Conteneurs', value: dockerPortOk ? (form.dockerPort ? `port ${form.dockerPort}` : 'port lu sur le serveur') : '', empty: 'à corriger (étape 3)' },
              ]}
            />
            <CheckLine label="Réception syslog" check={reception} idle={destination ? `test facultatif : le hub envoie une ligne à ${destination}, puis la cherche par l'API` : undefined} />
            {!tested && <p className="text-xs text-amber-300">L'enregistrement demande un test de l'API réussi (étape 2).</p>}
          </Step>
        </Steps>
      </Modal>
      <ConfirmModal open={confirmDiscard} onClose={() => setConfirmDiscard(false)} onConfirm={onClose} title="Abandonner les modifications ?" confirmLabel="Abandonner" danger>
        Les paramètres du rôle modifiés ne seront pas enregistrés.
      </ConfirmModal>
    </>
  );
}

interface EsphomeForm {
  siteId: string;
  brokerId: string;
  name: string;
  silentHours: string;
}

// the delay after which an ESP online without a line is mute, when the role sets none (hub/src/esphome.ts)
const ESPHOME_SILENT_HOURS = 2;
const ESPHOME_TOPICS = 'esphome/+/LWT, esphome/+/info, esphome/+/log_level';

// What the hub reads of the broker chosen, as the check of the summary: the role of the broker is already listened to by
// the hub, its state says whether the devices can be found now.
// Declares an ESPHome role, or edits one: the same dialog. Carried by the hub, one per site and one per broker (homelab#358).
// Four steps: the site of the devices, the broker the hub listens to for them (a mqtt-broker role, possibly of another
// site), the settings (name, mute delay), and a summary with the state of the broker. Its devices are then managed from
// « Inventaire » on its card.
export function EsphomeWizard({ role, onClose }: { role: EsphomeHubRole | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: roles = [] } = useRoles();
  const { data: sites = [] } = useSites();
  const [initial] = useState<EsphomeForm>(() => ({
    siteId: role?.config.siteId ?? '',
    brokerId: role?.config.brokerId ?? '',
    name: role?.name ?? '',
    silentHours: String(role?.config.silentHours ?? ESPHOME_SILENT_HOURS),
  }));
  const [form, setForm] = useState<EsphomeForm>(initial);
  const [busy, setBusy] = useState<'save' | 'check' | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const autoName = (id: string) => `ESPHome — ${siteName(id)}`;
  // the other ESPHome roles: a site and a broker each
  const others = roles.filter((r): r is EsphomeHubRole => r.type === 'esphome' && r.id !== role?.id);
  const siteOwner = (id: string) => others.find((r) => r.config.siteId === id);
  const brokerOwner = (id: string) => others.find((r) => r.config.brokerId === id);
  const brokers = roles.filter((r): r is MqttHubRole => r.type === 'mqtt-broker');
  const broker = brokers.find((b) => b.id === form.brokerId);
  // the name follows the site while it is the one given by default (or empty)
  const pickSite = (id: string) => setForm({ ...form, siteId: id, name: !form.name.trim() || (form.siteId && form.name === autoName(form.siteId)) ? autoName(id) : form.name });
  const name = form.name.trim() || (form.siteId ? autoName(form.siteId) : '');

  const hours = Number(form.silentHours);
  const hoursOk = /^\d{1,2}$/.test(form.silentHours) && hours <= 48;
  const siteOk = !!form.siteId && sites.some((s) => s.id === form.siteId) && !siteOwner(form.siteId);
  const brokerOk = !!broker && !brokerOwner(broker.id);
  // the broker must answer to the hub: tested here (a real connection), and again by the hub when it is saved. An edit that
  // keeps its broker is not tested again.
  const [tested, setTested] = useState<{ brokerId: string; check: CheckState } | null>(null);
  const check = tested && tested.brokerId === form.brokerId ? tested.check : null;
  const online = check?.level === 'ok' || (!!role && role.config.brokerId === form.brokerId);
  const ok = siteOk && brokerOk && hoursOk && online;
  // the summary (step 4) is the one to do once the three others are done (also when editing: the window opens on it); it is never checked
  const [sited, brokered, configured, summary] = stepStates([siteOk, brokerOk, hoursOk, false]);

  const recheck = async () => {
    if (!broker) return;
    setBusy('check');
    try {
      const r = await api.testEsphomeBroker(broker.id);
      setTested({ brokerId: broker.id, check: r.ok ? { level: 'ok', title: 'Broker connecté', detail: broker.url } : { level: 'error', title: 'Broker injoignable', detail: r.error } });
    } catch (err) {
      setTested({ brokerId: broker.id, check: { level: 'error', title: 'Test impossible', detail: (err as Error).message } });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    try {
      const body = { siteId: form.siteId, brokerId: form.brokerId, name, silentHours: hours };
      if (role) await api.saveEsphome(role.id, body);
      else await api.declareEsphome(body);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.roles }), qc.invalidateQueries({ queryKey: ['settings', 'esphome'] }), qc.invalidateQueries({ queryKey: keys.equipments })]);
      toast.success(role ? `Rôle ${name} modifié` : `Rôle ${name} déclaré`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        wide="screen"
        wider
        fixed
        title={role ? `ESPHome · ${role.name}` : 'Nouveau rôle ESPHome'}
        footer={
          <>
            <Button variant="ghost" disabled={busy !== null} onClick={requestClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null || !ok} onClick={() => void save()}>Enregistrer</Button>
          </>
        }
      >
        <Steps fill>
          <Step n={1} title="Site" state={sited} intro={role ? 'Changer de site : les équipements des appareils passent au nouveau site.' : 'Le site des appareils découverts : un rôle ESPHome par site.'}>
            {!sites.length ? (
              <p className="text-sm text-muted">Aucun site.</p>
            ) : (
              <div className="relative min-h-0 flex-1 space-y-1.5 overflow-y-auto">
                {sites.map((s) => {
                  const owner = siteOwner(s.id);
                  return (
                    <CarrierRow key={s.id} group="esphome-site" on={form.siteId === s.id} disabled={!!owner} onPick={() => pickSite(s.id)} title={s.name}>
                      {owner ? `déjà un rôle : ${owner.name}` : 'libre'}
                    </CarrierRow>
                  );
                })}
              </div>
            )}
          </Step>
          <Step
            n={2}
            title="Broker"
            state={brokered}
            intro={role ? "Changer de broker : les appareils découverts sur l'ancien sont oubliés, ceux du nouveau apparaissent dans l'inventaire." : "Le broker MQTT où les appareils du site publient. Il peut être celui d'un autre site ; un broker n'est écouté que par un rôle ESPHome."}
          >
            {!brokers.length ? (
              <p className="text-sm text-muted">Aucun broker MQTT déclaré : déclarer d'abord un rôle Broker MQTT.</p>
            ) : (
              <div className="relative min-h-0 flex-1 space-y-1.5 overflow-y-auto">
                {brokers.map((b) => {
                  const owner = brokerOwner(b.id);
                  return (
                    <CarrierRow key={b.id} group="esphome-broker" on={form.brokerId === b.id} disabled={!!owner} onPick={() => setForm({ ...form, brokerId: b.id })} title={b.name}>
                      {owner ? `déjà écouté par ${owner.name}` : `${b.carrier.name || 'porteur introuvable'} · ${b.url || 'adresse inconnue'} · ${roleStatus(b).label}`}
                    </CarrierRow>
                  );
                })}
              </div>
            )}
          </Step>
          <Step n={3} title="Réglages" state={configured}>
            <label className="block">
              <span className={field}>Nom du rôle</span>
              <input className="input" maxLength={64} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={form.siteId ? autoName(form.siteId) : 'ESPHome — <site>'} />
              <span className="mt-1 block text-xs text-muted">Vide : « ESPHome — &lt;site&gt; ».</span>
            </label>
            <label className="block">
              <span className={field}>Muet après</span>
              <span className="flex items-center gap-2 text-sm text-zinc-200">
                <input className="input w-16 py-1 text-center font-mono text-xs" inputMode="numeric" value={form.silentHours} onChange={(e) => setForm({ ...form, silentHours: e.target.value.trim() })} aria-label="Heures sans ligne avant muet" />
                heures sans ligne
              </span>
              <span className="mt-1 block text-xs text-muted">
                Pour un ESP en ligne dont les logs sont activés : son équipement passe en alerte « muet ». 0 : pas de surveillance ; le package envoie un heartbeat
                toutes les heures.
              </span>
            </label>
            {!hoursOk && <p className="text-xs text-amber-300">De 0 à 48 heures</p>}
          </Step>
          <Step
            n={4}
            title="Récapitulatif"
            state={summary}
            intro="Le hub s'abonne aux messages des appareils sur le broker ; ils apparaissent ensuite dans l'inventaire du rôle."
            footer={
              <Button className="w-full" variant="secondary" icon={Plug} loading={busy === 'check'} disabled={busy !== null || !broker} onClick={() => void recheck()}>
                Tester le broker
              </Button>
            }
          >
            <DetectedRows
              rows={[
                { label: 'Nom', value: name, empty: 'non renseigné' },
                { label: 'Site', value: form.siteId ? siteName(form.siteId) : '', empty: 'non choisi (étape 1)' },
                { label: 'Broker', value: broker ? `${broker.name}${broker.url ? ` · ${broker.url}` : ''}` : '', empty: 'non choisi (étape 2)' },
                { label: 'Écoute', value: broker ? ESPHOME_TOPICS : '', empty: '—' },
                { label: 'Muet après', value: hoursOk ? (hours ? `${hours} h sans ligne` : 'pas de surveillance') : '', empty: 'à corriger (étape 3)' },
              ]}
            />
            <CheckLine label="Broker MQTT" check={check} idle={broker ? (online ? 'inchangé' : 'à tester') : 'broker non choisi'} />
            {!online && broker && <p className="text-xs text-muted">Le broker doit répondre au hub pour enregistrer le rôle : lancer le test.</p>}
          </Step>
        </Steps>
      </Modal>
      <ConfirmModal open={confirmDiscard} onClose={() => setConfirmDiscard(false)} onConfirm={onClose} title="Abandonner les modifications ?" confirmLabel="Abandonner" danger>
        Les paramètres du rôle modifiés ne seront pas enregistrés.
      </ConfirmModal>
    </>
  );
}

interface HaForm {
  name: string;
  brokerId: string;
  mode: 'full' | 'site';
  siteId: string;
  topic: string;
  discoveryPrefix: string;
  publicUrl: string;
}

const HA_TOPIC = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;
const HA_URL = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/;

// Declares a Home Assistant role, or edits one: the same dialog (homelab#361). Carried by the hub, one per broker. Five
// steps: the name, the broker its Home Assistant is connected to (MQTT integration), the scope (the whole homelab or one
// site), the topics and the link of the devices, and the test of the broker. The level of detail is then set from
// « Publication » on its card.
export function HomeAssistantWizard({ role, onClose }: { role: HaHubRole | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: roles = [] } = useRoles();
  const { data: sites = [] } = useSites();
  const [initial] = useState<HaForm>(() => ({
    name: role?.name ?? '',
    brokerId: role?.config.brokerId ?? '',
    mode: role?.config.mode ?? 'full',
    siteId: role?.config.siteId ?? '',
    topic: role?.config.topic ?? 'homelab-manager',
    discoveryPrefix: role?.config.discoveryPrefix ?? 'homeassistant',
    publicUrl: role?.config.publicUrl ?? '',
  }));
  const [form, setForm] = useState<HaForm>(initial);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const autoName = (f: Pick<HaForm, 'mode' | 'siteId'>) => (f.mode === 'site' && f.siteId ? `Home Assistant — ${siteName(f.siteId)}` : 'Home Assistant');
  // the name follows the scope while it is the one given by default (or empty)
  const setScope = (patch: Partial<Pick<HaForm, 'mode' | 'siteId'>>) => {
    const next = { ...form, ...patch };
    setForm({ ...next, name: !form.name.trim() || form.name === autoName(form) ? autoName(next) : form.name });
  };
  const name = form.name.trim() || autoName(form);
  // the other Home Assistant roles: a broker each
  const others = roles.filter((r): r is HaHubRole => r.type === 'home-assistant' && r.id !== role?.id);
  const brokerOwner = (id: string) => others.find((r) => r.config.brokerId === id);
  const brokers = roles.filter((r): r is MqttHubRole => r.type === 'mqtt-broker');
  const broker = brokers.find((b) => b.id === form.brokerId);

  const brokerOk = !!broker && !brokerOwner(broker.id);
  const scopeOk = form.mode === 'full' || (!!form.siteId && sites.some((s) => s.id === form.siteId));
  const topicsOk = HA_TOPIC.test(form.topic) && HA_TOPIC.test(form.discoveryPrefix) && (!form.publicUrl.trim() || HA_URL.test(form.publicUrl.trim()));
  // the broker must answer to the hub: tested here, and again by the hub when it is saved. An edit that keeps its broker is
  // not tested again.
  const [tested, setTested] = useState<{ brokerId: string; check: CheckState } | null>(null);
  const check = tested && tested.brokerId === form.brokerId ? tested.check : null;
  const online = check?.level === 'ok' || (!!role && role.config.brokerId === form.brokerId);
  const ok = brokerOk && scopeOk && topicsOk && online;
  // the name follows the scope by default: confirmed at the end, beside the summary and the test
  const [brokered, scoped, topics, testedStep] = stepStates([brokerOk, scopeOk, topicsOk, online]);
  // what moves the devices: another broker or other prefixes take them out of the Home Assistant of before
  const moves = !!role && (role.config.brokerId !== form.brokerId || role.config.topic !== form.topic || role.config.discoveryPrefix !== form.discoveryPrefix);

  const runTest = async () => {
    if (!broker) return;
    setBusy('test');
    try {
      const r = await api.testHomeAssistant(broker.id);
      setTested({ brokerId: broker.id, check: r.ok ? { level: 'ok', title: 'Connexion réussie', detail: broker.url } : { level: 'error', title: 'Broker injoignable', detail: r.error } });
    } catch (err) {
      setTested({ brokerId: broker.id, check: { level: 'error', title: 'Test impossible', detail: (err as Error).message } });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    try {
      const body = {
        name,
        brokerId: form.brokerId,
        mode: form.mode,
        ...(form.mode === 'site' ? { siteId: form.siteId } : {}),
        topic: form.topic,
        discoveryPrefix: form.discoveryPrefix,
        publicUrl: form.publicUrl.trim(),
      };
      const saved = role ? await api.saveHomeAssistant(role.id, body) : await api.declareHomeAssistant(body);
      qc.setQueryData(haQueryKey(saved.id), saved);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.roles }), qc.invalidateQueries({ queryKey: ['settings', 'homeassistant'] })]);
      toast.success(role ? `Rôle ${name} modifié` : `Rôle ${name} déclaré : publication dans Home Assistant`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        wide="screen"
        wider
        fixed
        title={role ? `Home Assistant · ${role.name}` : 'Nouveau rôle Home Assistant'}
        footer={
          <>
            <Button variant="ghost" disabled={busy !== null} onClick={requestClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null || !ok} onClick={() => void save()}>Enregistrer</Button>
          </>
        }
      >
        <Steps fill>
          <Step
            n={1}
            title="Broker"
            state={brokered}
            intro={role ? "Changer de broker retire les appareils du Home Assistant d'avant et les publie sur le nouveau." : "Le broker MQTT auquel ce Home Assistant est relié (intégration MQTT). Un broker ne sert qu'à un rôle Home Assistant."}
          >
            {!brokers.length ? (
              <p className="text-sm text-muted">Aucun broker MQTT déclaré : déclarer d'abord un rôle Broker MQTT.</p>
            ) : (
              <div className="relative min-h-0 flex-1 space-y-1.5 overflow-y-auto">
                {brokers.map((b) => {
                  const owner = brokerOwner(b.id);
                  return (
                    <CarrierRow key={b.id} group="ha-broker" on={form.brokerId === b.id} disabled={!!owner} onPick={() => setForm({ ...form, brokerId: b.id })} title={b.name}>
                      {owner ? `déjà utilisé par ${owner.name}` : `${b.carrier.name || 'porteur introuvable'} · ${b.url || 'adresse inconnue'} · ${b.config.username || 'anonyme'}`}
                    </CarrierRow>
                  );
                })}
              </div>
            )}
          </Step>
          <Step n={2} title="Périmètre" state={scoped} intro="Ce que ce Home Assistant reçoit : tout le homelab, ou les hôtes et équipements d'un seul site (et leurs commandes).">
            <div className="relative min-h-0 flex-1 space-y-1.5 overflow-y-auto">
              <CarrierRow group="ha-scope" on={form.mode === 'full'} onPick={() => setScope({ mode: 'full', siteId: '' })} title="Tout le homelab">
                tous les sites ; regroupement par site possible dans la publication
              </CarrierRow>
              {sites.map((s) => (
                <CarrierRow key={s.id} group="ha-scope" on={form.mode === 'site' && form.siteId === s.id} onPick={() => setScope({ mode: 'site', siteId: s.id })} title={`Site ${s.name}`}>
                  seulement les hôtes et équipements de ce site
                </CarrierRow>
              ))}
            </div>
          </Step>
          <Step n={3} title="Topics" state={topics} intro={moves ? 'Changer de préfixe retire les appareils publiés sous les anciens.' : 'Valeurs par défaut à confirmer.'}>
            <label className="block">
              <span className={field}>Préfixe de découverte</span>
              <input className="input font-mono text-xs" value={form.discoveryPrefix} onChange={(e) => setForm({ ...form, discoveryPrefix: e.target.value.trim() })} spellCheck={false} />
              <span className="mt-1 block text-xs text-muted">Celui de l'intégration MQTT de Home Assistant : homeassistant par défaut</span>
            </label>
            <label className="block">
              <span className={field}>Préfixe des topics du hub</span>
              <input className="input font-mono text-xs" value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value.trim() })} spellCheck={false} />
              <span className="mt-1 block text-xs text-muted">États et commandes : préfixe/appareil/entité/state</span>
            </label>
            <label className="block">
              <span className={field}>URL de l'interface (facultatif)</span>
              <input className="input" value={form.publicUrl} onChange={(e) => setForm({ ...form, publicUrl: e.target.value })} placeholder="https://homelab-manager.example.org" />
              <span className="mt-1 block text-xs text-muted">Lien « Visiter » des appareils dans Home Assistant ; vide : URL du hub (Paramètres &gt; Agent)</span>
            </label>
            {!topicsOk && <p className="text-xs text-amber-400">Préfixe : lettres, chiffres, _ et -, niveaux séparés par / ; URL en http(s)://.</p>}
          </Step>
          <Step
            n={4}
            title="Nom et test"
            state={testedStep}
            intro="Le hub se connecte au broker avec le compte du rôle Broker MQTT ; l'enregistrement démarre la publication."
            footer={
              <Button className="w-full" variant={testedStep === 'active' ? 'primary' : 'secondary'} icon={Plug} loading={busy === 'test'} disabled={busy !== null || !broker} onClick={() => void runTest()}>
                {check ? 'Tester à nouveau' : 'Tester le broker'}
              </Button>
            }
          >
            <label className="block">
              <span className={field}>Nom du rôle</span>
              <input className="input" maxLength={64} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={autoName(form)} />
              <span className="mt-1 block text-xs text-muted">Affiché dans Rôles et sur le broker ; suit le périmètre tant qu'il n'est pas modifié.</span>
            </label>
            <DetectedRows
              rows={[
                { label: 'Broker', value: broker ? `${broker.name}${broker.url ? ` · ${broker.url}` : ''}` : '', empty: 'non choisi (étape 1)' },
                { label: 'Périmètre', value: form.mode === 'full' ? 'tout le homelab' : form.siteId ? `site ${siteName(form.siteId)}` : '', empty: 'site non choisi (étape 2)' },
                { label: 'Découverte', value: `${form.discoveryPrefix}/…` },
                { label: 'États', value: `${form.topic}/…` },
              ]}
            />
            <CheckLine label="Broker MQTT" check={check} idle={broker ? (online ? 'inchangé' : 'à tester') : 'broker non choisi'} />
            {moves && <p className="text-xs text-amber-300">Les appareils publiés seront retirés de l'ancien broker ou des anciens préfixes, puis publiés à nouveau.</p>}
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
    ? 'Comptes gérés par HLM (dynamic-security) : la carte du rôle'
    : s.state === 'active'
      ? 'dynamic-security chargé, mais géré en dehors de HLM'
      : `Gestion des comptes par HLM possible${s.version ? ` (Mosquitto ${s.version})` : ''} : à activer dans la carte du rôle`;
  return (
    <Link to={`/roles/mqtt?role=${encodeURIComponent(role.id)}`} title={title} aria-label={title} className="shrink-0">
      <ShieldCheck className={clsx('h-3.5 w-3.5', managed ? 'text-emerald-400' : 'text-zinc-500')} aria-hidden />
    </Link>
  );
}

function notNow(t: HubRoleType, roles: HubRole[]) {
  if (SINGLE_ROLES.includes(t) && roles.some((r) => r.type === t)) return 'déjà déclaré : un seul dans le homelab';
  if (t === 'pbs-offsite' && !roles.some((r) => r.type === 'pbs-primary')) return 'déclarer d’abord le PBS principal';
  if ((t === 'esphome' || t === 'home-assistant') && !roles.some((r) => r.type === 'mqtt-broker')) return 'déclarer d’abord un broker MQTT';
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
  | { type: 'log-server'; role: LogHubRole | null }
  | { type: 'esphome'; role: EsphomeHubRole | null }
  | { type: 'home-assistant'; role: HaHubRole | null }
  | { type: 'pbs-primary' | 'pbs-offsite' };

// Rôles: every role of the hub, declared, edited and removed here.
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
      } else if (removing.type === 'esphome') {
        await api.deleteEsphome(removing.id);
        toast.success(`Rôle ${removing.name} supprimé`);
      } else if (removing.type === 'home-assistant') {
        await api.deleteHomeAssistant(removing.id);
        toast.success(`Rôle ${removing.name} supprimé : appareils retirés de Home Assistant`);
        if (page === 'homeassistant') closeOption();
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
  // the sites, by name on the cards of the ESPHome roles
  const { data: homelabSitesAll } = useSites();
  // the options of a role are a window over this screen, set by the URL: /roles/<page>?role=<role id>
  const { page } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const openOption = (id: string, roleId: string) => navigate(`/roles/${id}?role=${encodeURIComponent(roleId)}`);
  const closeOption = () => navigate('/roles', { replace: true });
  const optionRole = roles ? roleOfPage(page, params.get('role'), roles) : undefined;
  // a page that names no role to open (unknown page, role gone, several roles and none asked): back to the roles
  useEffect(() => {
    if (page && roles && optionRole === null || (page && !ROLE_PAGES.some((p) => p.id === page))) closeOption();
  }, [page, roles, optionRole]); // eslint-disable-line react-hooks/exhaustive-deps
  const optionTitle = (icon: React.ReactNode, label: string) => <span className="flex items-center gap-2">{icon}{label}{optionRole ? <span className="text-muted">· {optionRole.name}</span> : null}</span>;
  const edit = (r: HubRole) =>
    setEditing(r.type === 'mqtt-broker' ? { type: r.type, role: r } : r.type === 'pve-cluster' ? { type: r.type, role: r } : r.type === 'omada-controller' ? { type: r.type, role: r } : r.type === 'log-server' ? { type: r.type, role: r } : r.type === 'esphome' ? { type: r.type, role: r } : r.type === 'home-assistant' ? { type: r.type, role: r } : { type: r.type });
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
  const carrierLink = (r: HubRole) => r.carrier.kind === 'hub' ? <span>Hub</span> : <Link className="underline" to={r.carrier.kind === 'equipment' ? `/equipments/${r.carrier.id}` : `/hosts/${r.carrier.id}`}>{r.carrier.name || 'porteur introuvable'}</Link>;
  // two columns of sections from 2xl up (sections are dealt alternately: 1st left, 2nd right, 3rd left…)
  const [twoCols, setTwoCols] = useState(() => window.matchMedia('(min-width: 1536px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1536px)');
    const on = () => setTwoCols(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  // by type, in the order of the catalog of the types; the two PBS (main and off-site) share one section
  const sections = ROLE_TYPES.filter((t) => t.id !== 'pbs-offsite')
    .map((t) => {
      const pbs = t.id === 'pbs-primary';
      return { type: t.id, label: pbs ? 'Proxmox Backup Server' : t.label, list: (roles ?? []).filter((r) => r.type === t.id || (pbs && r.type === 'pbs-offsite')) };
    })
    .filter((g) => g.list.length);
  const sectionTitle = (g: (typeof sections)[number]) => {
    const Icon = roleIcon[g.type];
    return (
      <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
        <span className={clsx('inline-flex h-7 w-7 items-center justify-center rounded-md ring-1 ring-inset', roleTint[g.type])}><Icon className="h-4 w-4" aria-hidden /></span>
        <h3 className="font-medium text-zinc-100">{g.label}</h3>
        <span className="rounded-full bg-raised px-2 text-xs text-muted">{g.list.length}</span>
        <span className={clsx('h-px min-w-4 flex-1 bg-gradient-to-r to-transparent', roleAccent[g.type].rule)} aria-hidden />
      </div>
    );
  };
  // the site and the broker of the role of the hub, by name
  const esphomeTarget = (r: Extract<HubRole, { type: 'esphome' }>) => `${homelabSitesAll?.find((s) => s.id === r.config.siteId)?.name ?? r.config.siteId} · ${roles?.find((x) => x.id === r.config.brokerId)?.name ?? r.config.brokerId}`;
  // the scope and the broker of a Home Assistant role, by name
  const haTarget = (r: HaHubRole) => `${r.config.mode === 'site' && r.config.siteId ? `site ${homelabSitesAll?.find((s) => s.id === r.config.siteId)?.name ?? r.config.siteId}` : 'tout le homelab'} · ${roles?.find((x) => x.id === r.config.brokerId)?.name ?? r.config.brokerId}`;
  const dot: Record<string, string> = { ok: 'bg-emerald-500', warn: 'bg-amber-500', info: 'bg-sky-500', neutral: 'bg-zinc-500' };
  // one card per role: two a row at most (they share its width), a lone one takes all of it
  const cardOf = (r: HubRole, c?: BrokerCardSlots) => {
    const st = roleStatus(r);
    return (
      <article key={r.id} className={clsx('min-w-[20rem] max-w-full flex-[1_1_calc(50%-0.375rem)] rounded-lg border border-t-[3px] border-line bg-raised/40 px-3.5 py-3', roleAccent[r.type].edge)}>
        <div className="flex min-w-0 items-center gap-2">
          <span className={clsx('h-2 w-2 shrink-0 rounded-full', dot[st.tone] ?? dot.neutral)} aria-hidden />
          <span className="truncate font-medium text-zinc-100" title={r.name}>{r.name}</span>
          {r.type === 'mqtt-broker' && <DynsecIcon role={r} />}
          {r.type === 'pbs-primary' && <Badge tone="info">Principal</Badge>}
          {r.type === 'pbs-offsite' && <Badge tone="info">Hors site</Badge>}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <Badge tone={st.tone}>{st.label}</Badge>
            {c?.anonymous}
            {actions(r)}
          </span>
        </div>
        {r.type === 'esphome' ? (
          <p className="mt-1.5 break-all text-xs text-muted">{esphomeTarget(r)}</p>
        ) : r.type === 'home-assistant' ? (
          <p className="mt-1.5 break-all text-xs text-muted">{haTarget(r)}</p>
        ) : (
          <p className="mt-1.5 break-all font-mono text-xs text-muted">{r.url || 'adresse inconnue'}</p>
        )}
        <div className="mt-2 flex flex-wrap items-start gap-x-8 gap-y-2">
          <div className="min-w-0 flex-1 basis-60">
            <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs">
              <dt className="text-muted">Porteur</dt>
              <dd className="truncate">{carrierLink(r)}</dd>
              <dt className="text-muted">Compte</dt>
              <dd className="truncate" title={r.account || undefined}>{r.account || (r.carrier.kind === 'hub' ? '—' : 'anonyme')}</dd>
              <dt className="text-muted">Utilisé par</dt>
              <dd className="truncate" title={uses(r).join(', ') || r.summary || undefined}>{uses(r).join(', ') || r.summary || '—'}</dd>
            </dl>
            {c?.reset}
          </div>
          {c?.stats}
        </div>
        {r.status?.error && <p className="mt-1 truncate text-xs text-amber-300" title={r.status.error}>{r.status.error}</p>}
        {/* what the role unlocks: its options, opened in a window over this screen */}
        <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5 border-t border-line pt-2.5 empty:hidden">
          {c?.buttons}
          {rolePagesOf(r).map((p) => (
            <Button key={p.id} size="sm" icon={p.icon} onClick={() => openOption(p.id, r.id)}>{p.action}</Button>
          ))}
        </div>
      </article>
    );
  };
  const roleCard = (r: HubRole) =>
    r.type === 'mqtt-broker' ? <BrokerCardControls key={r.id} role={r} onAccounts={() => openOption('mqtt', r.id)}>{(c) => cardOf(r, c)}</BrokerCardControls> : cardOf(r);
  const cluster = editing?.type === 'pve-cluster' && editing.role ? pve?.clusters.find((c) => c.id === editing.role!.config.cluster) ?? null : null;

  return (
    <>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start">
        <p className="max-w-5xl flex-1 text-sm text-muted">
          Ce que le hub peut faire grâce à un hôte du homelab : un broker MQTT est écouté par les sondes MQTT et peut servir à l'intégration Home Assistant ; le
          cluster Proxmox VE donne l'inventaire de ses nœuds, VM et CT, relie les hôtes à leur VM ou CT et leur rattache les sauvegardes vzdump ; le PBS principal
          reçoit les sauvegardes, le PBS hors site en copie chaque jour une sélection ; un contrôleur Omada ouvre au hub l'Open API du réseau d'un site ; un serveur
          de logs reçoit les journaux des hôtes et ouvre la page Logs ; les rôles ESPHome, portés par le hub (un par site), découvrent les appareils ESPHome sur le broker choisi ;
          les rôles Home Assistant, portés par le hub (un par broker), publient tout le homelab ou un site dans le Home Assistant relié à leur broker.
          Les réglages d'un type de rôle (comptes MQTT, publication Home Assistant, inventaires…) s'ouvrent depuis les boutons de sa section. Un rôle utilisé ne peut pas être
          supprimé, ni l'hôte ou l'équipement qui le porte.
        </p>
        <Button className="shrink-0 self-start" variant="primary" icon={Plus} onClick={() => setPicking(true)}>Déclarer un rôle</Button>
      </div>
      {!!pbs?.pinRefused?.length && (
        <div className="mb-5 space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs">
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
        // two columns of sections on a wide screen, one below; a section is never split
        <div className={twoCols ? 'grid grid-cols-2 items-start gap-x-8' : undefined}>
          {(twoCols ? [0, 1] : [null]).map((col) => (
            <div key={col ?? 'all'}>
              {sections.filter((_, i) => col === null || i % 2 === col).map((g) => (
                <section key={g.type} className="mb-5">
                  {sectionTitle(g)}
                  <div className="flex flex-wrap gap-3">{g.list.map(roleCard)}</div>
                </section>
              ))}
            </div>
          ))}
        </div>
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
      {optionRole?.type === 'mqtt-broker' && page === 'mqtt' && <MqttAccountsModal role={optionRole} onClose={closeOption} />}
      {optionRole?.type === 'home-assistant' && page === 'homeassistant' && (
        <Modal open onClose={closeOption} wide="screen-wide" title={optionTitle(<Home className="h-4 w-4 text-muted" aria-hidden />, 'Home Assistant')}>
          <HomeAssistantPanel roleId={optionRole.id} onLeave={closeOption} onEdit={() => edit(optionRole)} onRemove={() => setRemoving(optionRole)} />
        </Modal>
      )}
      {optionRole?.type === 'pve-cluster' && page === 'pve' && (
        <Modal open onClose={closeOption} wide="screen-wide" title={optionTitle(<Boxes className="h-4 w-4 text-muted" aria-hidden />, 'Inventaire Proxmox VE')}>
          <PveInventory cluster={optionRole.config.cluster} />
        </Modal>
      )}
      {optionRole?.type === 'omada-controller' && page === 'omada' && (
        <Modal open onClose={closeOption} wide="screen-wide" title={optionTitle(<Network className="h-4 w-4 text-muted" aria-hidden />, 'Inventaire Omada')}>
          <OmadaInventory controllerId={optionRole.id} />
        </Modal>
      )}
      {optionRole?.type === 'log-server' && page === 'logs' && (
        <Modal open onClose={closeOption} wide="screen-wide" title={optionTitle(<ScrollText className="h-4 w-4 text-muted" aria-hidden />, 'Hôtes émetteurs des logs')}>
          <LogHostsSettings roleId={optionRole.id} />
        </Modal>
      )}
      {optionRole?.type === 'esphome' && page === 'esphome' && (
        <Modal open onClose={closeOption} wide="screen-wide" title={optionTitle(<Cpu className="h-4 w-4 text-muted" aria-hidden />, 'Inventaire ESPHome')}>
          <EsphomeInventory roleId={optionRole.id} />
        </Modal>
      )}
      {editing?.type === 'mqtt-broker' && <BrokerWizard role={editing.role} onClose={() => setEditing(null)} />}
      {editing?.type === 'omada-controller' && <OmadaWizard role={editing.role} onClose={() => setEditing(null)} />}
      {editing?.type === 'log-server' && <LogServerWizard role={editing.role} onClose={() => setEditing(null)} />}
      {editing?.type === 'esphome' && <EsphomeWizard role={editing.role} onClose={() => setEditing(null)} />}
      {editing?.type === 'home-assistant' && <HomeAssistantWizard role={editing.role} onClose={() => setEditing(null)} />}
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
        ) : removing?.type === 'esphome' ? (
          <>
            Le rôle <b>{removing.name}</b> est retiré du hub : son broker n'est plus écouté pour ESPHome et les appareils découverts sont oubliés. Rien
            n'est changé sur les appareils.
          </>
        ) : removing?.type === 'home-assistant' ? (
          <>
            Le rôle <b>{removing.name}</b> est retiré du hub, qui cesse de publier : ses appareils sont retirés du Home Assistant relié à son broker (configurations
            de découverte et états vidés).
          </>
        ) : removing?.type === 'log-server' ? (
          <>
            Le rôle <b>{removing.name}</b> est retiré du hub : ses journaux ne sont plus lisibles dans la page Logs. Rien n'est changé sur le serveur, qui garde
            ce qu'il a reçu.
          </>
        ) : (
          <>Le rôle <b>{removing?.name}</b> est retiré du hub : le broker n'est plus écouté.</>
        )}
      </ConfirmModal>
    </>
  );
}
