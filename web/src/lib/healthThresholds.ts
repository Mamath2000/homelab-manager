import type { HealthEnabledKey, HealthSettings } from '../lib/api';

export type ThresholdKey =
  | 'cpuWarningThreshold' | 'cpuAlertThreshold' | 'memoryWarningThreshold' | 'memoryAlertThreshold'
  | 'loadWarningThreshold' | 'loadAlertThreshold' | 'diskWarningThreshold' | 'diskAlertThreshold'
  | 'smartTemperatureWarningThreshold' | 'smartTemperatureAlertThreshold' | 'smartWearWarningThreshold' | 'smartWearAlertThreshold'
  | 'systemSustainedMinutes' | 'loadSustainedMinutes' | 'smartSustainedMinutes' | 'diskRearmMinutes';
export type ThresholdForm = Pick<HealthSettings, ThresholdKey>;

export interface ThresholdRow {
  label: string;
  warning: ThresholdKey;
  alert: ThresholdKey;
  duration?: ThresholdKey;
  // delay after the alert is lifted before the same level can be raised again (volumes)
  rearm?: ThresholdKey;
  enabled: HealthEnabledKey;
  // rows hidden for hosts without volumes (WSL) or without SMART (virtualized)
  group?: 'disks' | 'smart';
  max: number;
  suffix: string;
  durationMax?: number;
  step?: number;
  min?: number;
}

export const THRESHOLD_ROWS: ThresholdRow[] = [
  { label: 'CPU', warning: 'cpuWarningThreshold', alert: 'cpuAlertThreshold', duration: 'systemSustainedMinutes', enabled: 'cpuEnabled', max: 100, suffix: '%', durationMax: 60 },
  { label: 'Mémoire', warning: 'memoryWarningThreshold', alert: 'memoryAlertThreshold', duration: 'systemSustainedMinutes', enabled: 'memoryEnabled', max: 100, suffix: '%', durationMax: 60 },
  { label: 'Charge Unix (load5 / CPU)', warning: 'loadWarningThreshold', alert: 'loadAlertThreshold', duration: 'loadSustainedMinutes', enabled: 'loadEnabled', max: 10, suffix: '× CPU', durationMax: 60, step: 0.05, min: 0.1 },
  { label: 'Volumes', warning: 'diskWarningThreshold', alert: 'diskAlertThreshold', rearm: 'diskRearmMinutes', enabled: 'diskEnabled', group: 'disks', max: 100, suffix: '%', durationMax: 2880 },
  { label: 'Température SMART', warning: 'smartTemperatureWarningThreshold', alert: 'smartTemperatureAlertThreshold', duration: 'smartSustainedMinutes', enabled: 'smartTemperatureEnabled', group: 'smart', max: 150, suffix: '°C', durationMax: 2880 },
  { label: 'Usure NVMe SMART', warning: 'smartWearWarningThreshold', alert: 'smartWearAlertThreshold', duration: 'smartSustainedMinutes', enabled: 'smartWearEnabled', group: 'smart', max: 1000, suffix: '%', durationMax: 2880 },
];

export const THRESHOLD_KEYS = [...new Set(THRESHOLD_ROWS.flatMap((r) => [r.warning, r.alert, ...(r.duration ? [r.duration] : []), ...(r.rearm ? [r.rearm] : [])]))];
export const ENABLED_KEYS = THRESHOLD_ROWS.map((r) => r.enabled);

export const thresholdsOf = (s: HealthSettings): ThresholdForm => Object.fromEntries(THRESHOLD_KEYS.map((k) => [k, s[k]])) as ThresholdForm;

// First pair whose warning is not under its alert (the hub refuses it too).
export const invalidThreshold = (f: ThresholdForm) => THRESHOLD_ROWS.find((r) => f[r.warning] >= f[r.alert])?.label;
