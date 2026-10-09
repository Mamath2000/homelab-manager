import type { HostDoc } from '../types.js';
import type { StackView } from '../docker.js';

// Alerts are produced by each sub-component of a host (agent, apt, later docker, backups...)
// and roll up: sub-component -> host -> Homelab Manager.
export interface Alert {
  level: 'critical' | 'warning';
  source: string; // sub-component: agent, apt...
  message: string;
  host?: string;
}

const STALE_MS = 2 * 24 * 3600 * 1000;

export function agentAlerts(h: HostDoc, online: boolean, outdated?: boolean | null): Alert[] {
  if (online) return outdated ? [{ level: 'warning', source: 'agent', message: 'Agent à mettre à jour' }] : [];
  if (!h.enrolledAt) return [{ level: 'warning', source: 'agent', message: 'Agent jamais connecté' }];
  return [{ level: 'critical', source: 'agent', message: 'Agent hors ligne' }];
}

export function aptAlerts(h: HostDoc, now = Date.now()): Alert[] {
  const r = h.apt;
  if (!r) return [];
  const out: Alert[] = [];
  const security = r.upgradable.filter((p) => p.security).length;
  if (security) out.push({ level: 'warning', source: 'apt', message: `${security} mise(s) à jour de sécurité` });
  if (r.rebootRequired) out.push({ level: 'warning', source: 'apt', message: 'Redémarrage requis' });
  if (!r.listsUpdatedAt || now - r.listsUpdatedAt > STALE_MS) {
    out.push({ level: 'warning', source: 'apt', message: 'Listes de paquets non rafraîchies depuis plus de 2 jours' });
  }
  return out;
}

// Partial stack, unhealthy or restarting container. A stack stopped on purpose is not an alert.
export function dockerAlerts(stack: Pick<StackView, 'name' | 'problems'>): Alert[] {
  return stack.problems.map((p) => ({ level: 'warning', source: 'docker', message: `${stack.name} : ${p}` }));
}
