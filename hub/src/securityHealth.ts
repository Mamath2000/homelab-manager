import { CLIENT_CERT_DAYS } from './pki.js';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ObjectId } from 'mongodb';
import { AGENT_TARGETS, agentBinary, agentOutdated } from './agentBinaries.js';
import { brokerAnonymous } from './brokerAnonymous.js';
import { config } from './config.js';
import { hosts, passkeys, users } from './db.js';
import { loadHaBridgeSettings } from './routes/settings.js';
import { loadMqttBrokers } from './probes.js';
import { hasMasterKey } from './secrets.js';
import { cookieSecure, transport } from './transport.js';
import type { HostDoc } from './types.js';

// Security posture of the installation, as the hub can see it from inside (homelab#310). Admins only (the route sits
// under /api/settings/, profiles.ts). It reads, it never changes anything.

export type SecurityStatus = 'ok' | 'warn' | 'bad' | 'unknown';

export interface SecurityCheck {
  id: string;
  label: string;
  status: SecurityStatus;
  detail: string;
  // the items concerned (hosts, brokers), when the check is about several
  items?: { name: string; status: SecurityStatus; detail: string }[];
}

export interface SecurityGroup {
  id: 'access' | 'data' | 'agents' | 'mqtt' | 'container';
  title: string;
  checks: SecurityCheck[];
}

const worst = (list: SecurityStatus[]): SecurityStatus =>
  (['bad', 'warn', 'unknown', 'ok'] as const).find((s) => list.includes(s)) ?? 'ok';

// --- what the process sees of its container (Linux only; unknown elsewhere) -------------------------------------

export interface ContainerFacts {
  uid: number | null;
  noNewPrivs: boolean | null;
  // bounding set of capabilities, hex as in /proc/self/status (cap_drop: [ALL] gives all zeros)
  capBounding: string | null;
  rootReadOnly: boolean | null;
}

export function parseProcStatus(status: string): Pick<ContainerFacts, 'noNewPrivs' | 'capBounding'> {
  const field = (name: string) => new RegExp(`^${name}:\\s*(\\S+)`, 'm').exec(status)?.[1] ?? null;
  const nnp = field('NoNewPrivs');
  return { noNewPrivs: nnp === null ? null : nnp === '1', capBounding: field('CapBnd') };
}

// mountinfo: id parent major:minor root mountpoint options … — the line whose mountpoint is "/"
export function rootIsReadOnly(mountinfo: string): boolean | null {
  for (const line of mountinfo.split('\n')) {
    const f = line.split(' ');
    if (f[4] === '/') return (f[5] ?? '').split(',').includes('ro');
  }
  return null;
}

export function readContainerFacts(): ContainerFacts {
  const read = (p: string) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
  const status = read('/proc/self/status');
  const mounts = read('/proc/self/mountinfo');
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    ...(status ? parseProcStatus(status) : { noNewPrivs: null, capBounding: null }),
    rootReadOnly: mounts ? rootIsReadOnly(mounts) : null,
  };
}

// --- the checks ----------------------------------------------------------------------------------------------

export interface AccessInput {
  https: boolean;
  hopClear: boolean;
  cookieSecure: boolean;
  trustProxy: boolean | string[];
}

export function accessChecks(i: AccessInput): SecurityCheck[] {
  const checks: SecurityCheck[] = [];
  checks.push(
    i.https
      ? i.hopClear
        ? { id: 'https', label: 'Interface en HTTPS', status: 'warn', detail: 'HTTPS jusqu’au proxy, puis en clair vers le hub depuis une autre machine : ce tronçon peut être écouté. Faire pointer le proxy sur le port HTTPS du hub.' }
        : { id: 'https', label: 'Interface en HTTPS', status: 'ok', detail: 'Cette page est servie en HTTPS.' }
      : { id: 'https', label: 'Interface en HTTPS', status: 'bad', detail: 'Cette page est servie en HTTP : mots de passe et cookie de session circulent en clair. Activer HTTPS_PORT ou passer par un reverse proxy HTTPS.' },
  );
  checks.push(
    i.cookieSecure
      ? { id: 'cookie', label: 'Cookie de session Secure', status: 'ok', detail: 'Le cookie n’est jamais envoyé en HTTP.' }
      : { id: 'cookie', label: 'Cookie de session Secure', status: i.https ? 'warn' : 'bad', detail: i.https ? 'COOKIE_SECURE=false : le cookie est accepté aussi en HTTP.' : 'Le cookie n’a pas l’attribut Secure (requête en HTTP).' },
  );
  checks.push(
    i.trustProxy === true
      ? { id: 'trust-proxy', label: 'Proxy de confiance', status: 'warn', detail: 'TRUST_PROXY=true : tout client peut choisir l’adresse IP que le hub lui attribue. Donner l’adresse exacte du proxy.' }
      : Array.isArray(i.trustProxy)
        ? { id: 'trust-proxy', label: 'Proxy de confiance', status: 'ok', detail: `Limité à : ${i.trustProxy.join(', ')}.` }
        : { id: 'trust-proxy', label: 'Proxy de confiance', status: 'ok', detail: 'Aucun proxy déclaré (accès direct).' },
  );
  return checks;
}

export interface MfaInput {
  rpId: string | undefined;
  required: boolean;
  admins: { name: string; passkeys: number }[];
}

// Passkeys of the admins (homelab#291).
export function mfaChecks(i: MfaInput): SecurityCheck[] {
  const label = 'Double authentification des admins';
  if (!i.rpId) {
    return [
      i.required
        ? { id: 'mfa', label, status: 'bad', detail: 'MFA_REQUIRED=true sans WEBAUTHN_RP_ID : les passkeys sont désactivées, l’obligation ne s’applique pas. Renseigner le nom de domaine de l’interface.' }
        : { id: 'mfa', label, status: 'warn', detail: 'Passkeys désactivées (WEBAUTHN_RP_ID absent) : chaque compte se connecte avec son seul mot de passe.' },
    ];
  }
  const items = i.admins.filter((a) => !a.passkeys).map((a) => ({ name: a.name, status: 'warn' as SecurityStatus, detail: 'aucune passkey' }));
  if (!i.required) {
    return [{ id: 'mfa', label, status: 'warn', detail: `Passkeys proposées (${i.rpId}) mais pas obligatoires : MFA_REQUIRED=true pour les imposer aux admins.`, ...(items.length ? { items } : {}) }];
  }
  return [
    items.length
      ? { id: 'mfa', label, status: 'warn', detail: 'Obligatoires ; les admins sans passkey en enregistreront une à leur prochaine connexion.', items }
      : { id: 'mfa', label, status: 'ok', detail: `Obligatoires pour les admins (${i.rpId}), chacun en a une.` },
  ];
}

export function dataChecks(i: { mongoAuth: boolean; masterKey: boolean }): SecurityCheck[] {
  return [
    i.mongoAuth
      ? { id: 'mongo-auth', label: 'Authentification MongoDB', status: 'ok', detail: 'Le hub se connecte avec un compte.' }
      : { id: 'mongo-auth', label: 'Authentification MongoDB', status: 'warn', detail: 'Aucun compte (MONGO_USERNAME / MONGO_PASSWORD) : la base accepte toute connexion qui l’atteint.' },
    i.masterKey
      ? { id: 'master-key', label: 'Secrets chiffrés dans la base', status: 'ok', detail: 'Clé maître présente (HM_MASTER_KEY).' }
      : { id: 'master-key', label: 'Secrets chiffrés dans la base', status: 'warn', detail: 'Pas de clé maître : jetons et mots de passe stockés en clair dans MongoDB.' },
  ];
}

type AgentHost = Pick<HostDoc, 'name' | 'enrolledAt' | 'certFingerprint' | 'certNotAfter' | 'info' | 'agentVersion' | 'agentMinVersion' | 'policy' | 'agentHash' | 'capabilities'>;

// One line per agent that is behind on a protection; hosts that never enrolled are not agents yet.
export function agentItems(list: AgentHost[], outdated: (h: AgentHost) => boolean | null, now = Date.now()): NonNullable<SecurityCheck['items']> {
  const items: NonNullable<SecurityCheck['items']> = [];
  for (const h of list) {
    if (!h.enrolledAt || !h.certFingerprint) continue;
    const gaps: string[] = [];
    if (outdated(h) === true) gaps.push('version de l’agent en retard sur celle du hub');
    if (!h.agentMinVersion) gaps.push('pas de version minimum (mise à jour sans protection contre le retour arrière)');
    if (!h.policy) gaps.push('pas de politique locale (agent trop ancien)');
    else if (h.policy.invalid) gaps.push('politique locale invalide');
    else if (!h.policy.file) gaps.push('aucune politique locale posée : l’agent accepte tout');
    // certificates of the first versions last 5 years; renewed ones one year (certRenew.ts)
    if (!h.capabilities?.includes('cert_renew')) gaps.push('certificat sans renouvellement automatique (agent trop ancien)');
    else if (h.certNotAfter && new Date(h.certNotAfter).getTime() - now > (CLIENT_CERT_DAYS + 1) * 24 * 3600 * 1000) gaps.push('certificat pas encore renouvelé (valable plus d’un an)');
    if (gaps.length) items.push({ name: h.name, status: 'warn', detail: gaps.join(' · ') });
  }
  return items;
}

export function agentChecks(list: AgentHost[], binaries: { signed: boolean; floor: string | null }[], outdated: (h: AgentHost) => boolean | null): SecurityCheck[] {
  const checks: SecurityCheck[] = [];
  if (!binaries.length) {
    checks.push({ id: 'signature', label: 'Binaires de l’agent signés', status: 'unknown', detail: 'Aucun binaire d’agent sur ce hub.' });
  } else {
    const unsigned = binaries.some((b) => !b.signed);
    const noFloor = binaries.some((b) => !b.floor);
    checks.push(
      unsigned
        ? { id: 'signature', label: 'Binaires de l’agent signés', status: 'bad', detail: 'Au moins un binaire distribué n’est pas signé (image de développement) : les agents ne peuvent pas vérifier leurs mises à jour.' }
        : { id: 'signature', label: 'Binaires de l’agent signés', status: 'ok', detail: 'Chaque binaire est signé (Ed25519) ; les agents vérifient la signature avant de se mettre à jour.' },
    );
    checks.push(
      noFloor
        ? { id: 'floor', label: 'Version minimum (anti-retour arrière)', status: 'warn', detail: 'Les binaires distribués n’embarquent pas de version minimum.' }
        : { id: 'floor', label: 'Version minimum (anti-retour arrière)', status: 'ok', detail: `Plancher embarqué : ${binaries.find((b) => b.floor)?.floor}.` },
    );
  }
  const items = agentItems(list, outdated);
  const total = list.filter((h) => h.enrolledAt && h.certFingerprint).length;
  checks.push({
    id: 'agents',
    label: 'Agents à jour des protections',
    status: total === 0 ? 'unknown' : items.length ? 'warn' : 'ok',
    detail: total === 0 ? 'Aucun agent enrôlé.' : items.length ? `${items.length} agent(s) sur ${total} en retard sur une protection.` : `${total} agent(s), tous à jour.`,
    ...(items.length ? { items } : {}),
  });
  return checks;
}

export interface BrokerFacts {
  name: string;
  url: string;
  anonymous: boolean | null;
  hasAccount: boolean;
  usedByBridge: boolean;
}

export function mqttChecks(brokers: BrokerFacts[], bridgeEnabled: boolean): SecurityCheck[] {
  if (!brokers.length) return [{ id: 'mqtt', label: 'Brokers MQTT', status: 'unknown', detail: 'Aucun broker déclaré dans les rôles.' }];
  const items = brokers.map((b) => {
    const gaps: { status: SecurityStatus; text: string }[] = [];
    if (b.anonymous === true) gaps.push({ status: 'bad', text: 'accepte les connexions sans compte : tout client du réseau peut publier' });
    else if (b.anonymous === null) gaps.push({ status: 'unknown', text: 'accès anonyme pas encore vérifié' });
    if (b.url && !b.url.startsWith('mqtts://')) gaps.push({ status: 'warn', text: 'sans TLS (mqtt://)' });
    if (!b.hasAccount && b.anonymous === false) gaps.push({ status: 'warn', text: 'le hub s’y connecte sans compte' });
    return {
      name: b.usedByBridge && bridgeEnabled ? `${b.name} (pont Home Assistant)` : b.name,
      status: gaps.length ? worst(gaps.map((g) => g.status)) : ('ok' as SecurityStatus),
      detail: gaps.length ? gaps.map((g) => g.text).join(' · ') : 'compte requis, TLS',
    };
  });
  const status = worst(items.map((i) => i.status));
  const bridgeOnBad = brokers.some((b) => b.usedByBridge && b.anonymous === true) && bridgeEnabled;
  return [
    {
      id: 'mqtt',
      label: 'Brokers MQTT',
      status,
      detail: bridgeOnBad
        ? 'Le broker du pont Home Assistant est ouvert : n’importe quel client peut publier les commandes de mise à jour.'
        : 'Compte et TLS vérifiés depuis le hub.',
      items,
    },
    {
      id: 'mqtt-acl',
      label: 'Commandes du pont Home Assistant',
      status: bridgeEnabled ? 'unknown' : 'ok',
      detail: bridgeEnabled
        ? 'Le hub ne voit pas les ACL du broker : réserver l’écriture sur <topic>/+/+/set au seul compte de Home Assistant (voir la doc).'
        : 'Pont désactivé : aucune commande n’est acceptée.',
    },
  ];
}

export function containerChecks(f: ContainerFacts): SecurityCheck[] {
  const bool = (id: string, label: string, v: boolean | null, okText: string, badText: string, status: SecurityStatus = 'warn'): SecurityCheck =>
    v === null ? { id, label, status: 'unknown', detail: 'Non lisible depuis le processus.' } : v ? { id, label, status: 'ok', detail: okText } : { id, label, status, detail: badText };
  return [
    bool('non-root', 'Processus sans droits root', f.uid === null ? null : f.uid !== 0, `uid ${f.uid}.`, 'Le hub tourne en root.', 'bad'),
    bool('read-only', 'Système de fichiers en lecture seule', f.rootReadOnly, 'read_only: true.', 'Le système de fichiers du conteneur est inscriptible (read_only: true dans compose.hardened.yml).'),
    bool('cap-drop', 'Capacités Linux retirées', f.capBounding === null ? null : /^0+$/.test(f.capBounding), 'cap_drop: [ALL].', `Capacités restantes (CapBnd ${f.capBounding}) : cap_drop: [ALL] dans compose.hardened.yml.`),
    bool('no-new-privileges', 'no-new-privileges', f.noNewPrivs, 'Actif.', 'Inactif (security_opt: no-new-privileges:true dans compose.hardened.yml).'),
  ];
}

// --- assembly ------------------------------------------------------------------------------------------------

export async function securityHealth(req: FastifyRequest) {
  const t = transport(req);
  const [hostList, { brokers }, bridge] = await Promise.all([hosts.find({}).toArray() as Promise<HostDoc[]>, loadMqttBrokers(), loadHaBridgeSettings()]);
  const admins = await users.find({ profile: 'admin' }, { projection: { username: 1 } }).toArray();
  const keyCounts = await passkeys.aggregate<{ _id: ObjectId; n: number }>([{ $group: { _id: '$userId', n: { $sum: 1 } } }]).toArray();
  const mfa = mfaChecks({
    rpId: config.webauthnRpId,
    required: config.mfaRequired,
    admins: admins.map((a) => ({ name: a.username, passkeys: keyCounts.find((k) => k._id.equals(a._id))?.n ?? 0 })),
  });
  const binaries = AGENT_TARGETS.map((x) => agentBinary(x.arch, x.os)).filter((b) => b !== null);
  const groups: SecurityGroup[] = [
    { id: 'access', title: 'Accès à l’interface', checks: [...accessChecks({ https: t.https, hopClear: t.hopClear, cookieSecure: cookieSecure(req), trustProxy: config.trustProxy }), ...mfa] },
    { id: 'data', title: 'Base et secrets', checks: dataChecks({ mongoAuth: !!(config.mongoUsername && config.mongoPassword), masterKey: hasMasterKey() }) },
    { id: 'agents', title: 'Agents', checks: agentChecks(hostList, binaries, (h) => agentOutdated(h as HostDoc)) },
    {
      id: 'mqtt',
      title: 'MQTT',
      checks: mqttChecks(
        brokers.map((b) => ({ name: b.name, url: b.url, anonymous: brokerAnonymous(b.id), hasAccount: !!b.username, usedByBridge: bridge.brokerRoleId === b.id })),
        bridge.enabled,
      ),
    },
    { id: 'container', title: 'Conteneur du hub', checks: containerChecks(readContainerFacts()) },
  ];
  const all = groups.flatMap((g) => g.checks.map((c) => c.status));
  return { checkedAt: new Date().toISOString(), summary: { ok: all.filter((s) => s === 'ok').length, warn: all.filter((s) => s === 'warn').length, bad: all.filter((s) => s === 'bad').length, unknown: all.filter((s) => s === 'unknown').length }, groups };
}

export function registerSecurityHealthRoutes(app: FastifyInstance) {
  app.get('/api/settings/security', async (req) => securityHealth(req));
}
