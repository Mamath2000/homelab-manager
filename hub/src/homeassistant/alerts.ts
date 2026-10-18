import type { AlertDomain } from '../types.js';
import type { Check, DomainStatus, HostStatus } from '../monitoring.js';

// Alerts of Home Assistant and of /api/summary are read from the registry of monitoring.ts:
// warn -> warning, alert -> critical. A domain that is unknown has no checks, so no alerts.
export interface Alert {
  level: 'critical' | 'warning';
  source: AlertDomain; // domain of the registry
  message: string;
  host?: string;
}

// Not-ok checks of a domain, optionally only some of them (one Docker stack...).
export function alertsOf(domain: DomainStatus | undefined, source: AlertDomain, only?: (c: Check) => boolean): Alert[] {
  return (domain?.checks ?? [])
    .filter((c) => c.level !== 'ok' && (!only || only(c)))
    .map((c) => ({ level: c.level === 'alert' ? 'critical' : 'warning', source, message: c.reason ?? c.label }));
}

export function hostAlerts(status: HostStatus): Alert[] {
  return (Object.entries(status.domains) as [AlertDomain, DomainStatus][]).flatMap(([id, d]) => alertsOf(d, id));
}
