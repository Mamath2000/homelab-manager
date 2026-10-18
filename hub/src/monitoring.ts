import { isOnline } from './agents.js';
import { dockerView } from './docker.js';
import { backupState } from './pbs.js';
import { offsiteState } from './offsite.js';
import { upsProblems } from './ups.js';
import type { AlertDomain, AlertLevel, BackupDoc, DayAlert, HostDoc } from './types.js';

// What the hub monitors, in two levels:
// - a domain (system, apt, backup...) groups what one source can tell about a host;
// - a check is one followed element of a domain (a backup group, a Docker stack, a disk...) with its
//   own level. A domain is the worst of its checks, a host the worst of its domains, a site the worst
//   of its hosts.
// To follow something new: write a provider, register it in PROVIDERS (and its domain in DOMAINS).
// Nothing else depends on the list: the history, the live status and the web interface read it.

export interface DomainMeta {
  id: AlertDomain;
  label: string;
  icon: string; // key of the icon map of the web interface
}

// Display order.
export const DOMAINS: DomainMeta[] = [
  { id: 'system', label: 'Connexion', icon: 'radio' },
  { id: 'apt', label: 'Mises à jour', icon: 'package' },
  { id: 'docker', label: 'Docker', icon: 'container' },
  { id: 'backup', label: 'Sauvegardes', icon: 'database-backup' },
  { id: 'offsite', label: 'Copie externe', icon: 'cloud-upload' },
  { id: 'ups', label: 'Onduleur', icon: 'battery-charging' },
];

export interface Check {
  key: string; // stable inside its domain (group id, stack name...)
  label: string;
  level: AlertLevel;
  reason?: string; // why, when not ok
}

// unknown: the domain applies to the host but cannot be read now (host offline, never connected).
// It never counts in the worst level: the connection domain already tells the host is away.
export interface DomainStatus {
  level: AlertLevel | 'unknown';
  checks: Check[];
  reason?: string;
}

// A domain that does not apply to a host (no Docker, no UPS...) is absent: null / missing key.
export type DomainReport = DomainStatus | null;

export interface HostStatus {
  level: AlertLevel;
  domains: Partial<Record<AlertDomain, DomainStatus>>;
}

// What a provider needs to know besides the host document.
export interface Context {
  online: boolean;
  groups: BackupDoc[]; // backup groups attached to the host
  now: number;
}

type Provider = (h: HostDoc, ctx: Context) => DomainReport;

const rank: Record<AlertLevel, number> = { ok: 0, warn: 1, alert: 2 };

export function worst(levels: Iterable<AlertLevel>): AlertLevel {
  let w: AlertLevel = 'ok';
  for (const l of levels) if (rank[l] > rank[w]) w = l;
  return w;
}

const known = (checks: Check[]): DomainStatus => ({ level: worst(checks.map((c) => c.level)), checks });
const unknown = (reason: string): DomainStatus => ({ level: 'unknown', checks: [], reason });
const check = (key: string, label: string, level: AlertLevel, reason?: string): Check => ({ key, label, level, ...(level !== 'ok' && reason ? { reason } : {}) });

// A roaming host away cannot back up, nor be read: being late or offline is expected then.
const away = (h: Pick<HostDoc, 'roaming'>, ctx: Pick<Context, 'online'>) => !!h.roaming && !ctx.online;

const STALE_LISTS_MS = 2 * 24 * 3600 * 1000;

// --- providers ----------------------------------------------------------------------------------

export function systemStatus(h: Pick<HostDoc, 'enrolledAt' | 'roaming' | 'critical'>, ctx: Pick<Context, 'online'>): DomainStatus {
  if (ctx.online) return known([check('connection', 'Connexion', 'ok')]);
  if (!h.enrolledAt) return unknown('En attente de connexion');
  if (h.roaming) return unknown('Absent (itinérant)');
  return known([check('connection', 'Connexion', h.critical ? 'alert' : 'warn', 'Agent hors ligne')]);
}

export function aptStatus(h: Pick<HostDoc, 'apt' | 'roaming'>, ctx: Pick<Context, 'online' | 'now'>): DomainReport {
  const r = h.apt;
  if (!r) return null;
  if (!ctx.online) return unknown('Hôte hors ligne');
  const security = r.upgradable.filter((p) => p.security).map((p) => p.name);
  const others = r.upgradable.length - security.length;
  return known([
    check('security', 'Sécurité', security.length ? 'alert' : 'ok', `Mises à jour de sécurité : ${security.join(', ')}`),
    check('reboot', 'Redémarrage', r.rebootRequired ? 'warn' : 'ok', `Redémarrage requis${r.rebootPkgs.length ? ` (${r.rebootPkgs.join(', ')})` : ''}`),
    check('updates', 'Paquets', others > 0 ? 'warn' : 'ok', `${others} paquet(s) à mettre à jour`),
    check('lists', 'Listes', ctx.now - r.listsUpdatedAt > STALE_LISTS_MS ? 'warn' : 'ok', 'Listes de paquets périmées'),
  ]);
}

export function dockerStatus(h: HostDoc, ctx: Pick<Context, 'online'>): DomainReport {
  const v = dockerView(h);
  if (!v) return null;
  if (!ctx.online) return unknown('Hôte hors ligne');
  // an unmanaged stack has neither problems nor updates to follow
  return known(
    v.stacks
      .filter((st) => st.managed)
      .map((st) =>
        st.problems.length
          ? check(st.name, st.name, 'alert', `${st.name} : ${st.problems.join(', ')}`)
          : st.updates > 0
            ? check(st.name, st.name, 'warn', `${st.name} : ${st.updates} image(s) à mettre à jour`)
            : check(st.name, st.name, 'ok'),
      ),
  );
}

const groupName = (b: BackupDoc) => b.managed?.name ?? b.comment ?? b.backupId;

export function backupStatus(h: Pick<HostDoc, 'roaming'>, ctx: Pick<Context, 'online' | 'groups' | 'now'>): DomainReport {
  if (!ctx.groups.length) return null;
  const gone = away(h, ctx);
  return known(
    ctx.groups.map((b) => {
      const name = groupName(b);
      const key = String(b._id ?? b.backupId);
      switch (backupState(b, ctx.now)) {
        case 'failed': return check(key, name, 'alert', `${name} : vérification en échec`);
        case 'task_failed': return check(key, name, 'alert', `${name} : dernière exécution en échec`);
        case 'stale': return gone ? check(key, name, 'ok') : check(key, name, 'warn', `${name} : en retard`);
        case 'gone': return check(key, name, 'warn', `${name} : disparue du PBS`);
        case 'disabled': return check(key, name, 'warn', `${name} : job désactivé`);
        case 'not_synced': return check(key, name, 'warn', `${name} : pas encore appliquée par l'agent`);
        default: return check(key, name, 'ok');
      }
    }),
  );
}

// Copy of the groups to the secondary PBS: only the groups whose copy is enabled.
export function offsiteStatus(h: Pick<HostDoc, 'roaming'>, ctx: Pick<Context, 'online' | 'groups' | 'now'>): DomainReport {
  const copied = ctx.groups.filter((b) => b.offsite?.enabled);
  if (!copied.length) return null;
  const gone = away(h, ctx);
  return known(
    copied.map((b) => {
      const name = groupName(b);
      const key = String(b._id ?? b.backupId);
      switch (offsiteState(b, ctx.now)) {
        case 'failed': return check(key, name, 'alert', `${name} : copie en échec`);
        case 'late': return gone ? check(key, name, 'ok') : check(key, name, 'warn', `${name} : copie en retard`);
        default: return check(key, name, 'ok');
      }
    }),
  );
}

export function upsStatus(h: Pick<HostDoc, 'ups'>, ctx: Pick<Context, 'online'>): DomainReport {
  if (!h.ups) return null;
  if (!ctx.online) return unknown('Hôte hors ligne');
  const problems = upsProblems(h.ups);
  if (!problems.length) return known([check('ups', 'Onduleur', 'ok')]);
  return known(problems.map((p) => check(p.message, p.message, p.level, p.message)));
}

const PROVIDERS: Record<AlertDomain, Provider> = {
  system: systemStatus,
  apt: aptStatus,
  docker: dockerStatus,
  backup: backupStatus,
  offsite: offsiteStatus,
  ups: upsStatus,
};

// --- evaluation ---------------------------------------------------------------------------------

export function evaluate(h: HostDoc, ctx: Context): HostStatus {
  const domains: HostStatus['domains'] = {};
  for (const { id } of DOMAINS) {
    const s = PROVIDERS[id](h, ctx);
    if (s) domains[id] = s;
  }
  const levels = Object.values(domains).flatMap((d) => (d.level === 'unknown' ? [] : [d.level]));
  return { level: worst(levels), domains };
}

// Status of every host from the backup groups attached to them.
export function evaluateAll(list: HostDoc[], groups: BackupDoc[], now = Date.now()): Record<string, HostStatus> {
  const byHost = new Map<string, BackupDoc[]>();
  for (const g of groups) if (g.hostId) byHost.set(g.hostId.toHexString(), [...(byHost.get(g.hostId.toHexString()) ?? []), g]);
  const out: Record<string, HostStatus> = {};
  for (const h of list) {
    const id = h._id.toHexString();
    out[id] = evaluate(h, { online: isOnline(id), groups: byHost.get(id) ?? [], now });
  }
  return out;
}

// The day of the history: unknown is not recorded (the day stays "nothing known" for this domain).
export function dayOf(d: DomainReport | undefined): DayAlert | null {
  if (!d || d.level === 'unknown') return null;
  return { level: d.level, reasons: d.checks.filter((c) => c.level !== 'ok' && c.reason).map((c) => c.reason!) };
}
