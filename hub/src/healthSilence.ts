import type { HealthSnapshot, HostDoc } from './types.js';

type Alert = NonNullable<HealthSnapshot['alerts']>[number];

// An alert the user accepted ("silenced") no longer counts for the state of the host. The acceptance is for the level
// it was given at: a warning that becomes an alert is reported again.
export function isHealthAlertSilenced(alert: Pick<Alert, 'key' | 'level'>, silenced: HostDoc['healthSilenced']): boolean {
  return !!silenced?.some((s) => s.key === alert.key && (alert.level === 'warn' || s.level === 'alert'));
}

// Alerts as shown in the UI: all of them, the silenced ones flagged.
export function healthWithSilenced(health: HostDoc['health'], silenced: HostDoc['healthSilenced']) {
  if (!health) return null;
  return { ...health, alerts: (health.alerts ?? []).map((a) => ({ ...a, silenced: isHealthAlertSilenced(a, silenced) })) };
}
