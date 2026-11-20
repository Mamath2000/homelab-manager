import type { ThresholdForm, ThresholdRow } from './healthThresholds';

// Usual scale of the slider of each indicator (widened when a stored value goes outside), with its wording.
export interface Scale { min: number; max: number; step: number; unit: string; what: string; subject: string; duration: string }
export const SCALES: Record<string, Scale> = {
  cpuWarningThreshold: { min: 0, max: 100, step: 1, unit: '%', what: 'Utilisation processeur moyenne de l’hôte', subject: 'le CPU', duration: 'Partagée avec la mémoire.' },
  memoryWarningThreshold: { min: 0, max: 100, step: 1, unit: '%', what: 'Mémoire utilisée sur la mémoire totale de l’hôte', subject: 'la mémoire', duration: 'Partagée avec le CPU.' },
  loadWarningThreshold: { min: 0, max: 2, step: 0.05, unit: '×', what: 'load5 rapporté au nombre de CPU, sans alerte sur les conteneurs', subject: 'la charge', duration: 'Propre à la charge Unix.' },
  diskWarningThreshold: { min: 50, max: 100, step: 1, unit: '%', what: 'Espace utilisé par volume. Les seuils sont immédiats ; la durée est un délai de réactivation après la levée', subject: 'un volume', duration: '0 = aucun délai de réactivation.' },
  smartTemperatureWarningThreshold: { min: 30, max: 90, step: 1, unit: '°C', what: 'Température des disques relevée par SMART', subject: 'la température', duration: 'Partagée avec l’usure NVMe.' },
  smartWearWarningThreshold: { min: 0, max: 100, step: 1, unit: '%', what: 'Usure des disques NVMe relevée par SMART', subject: 'l’usure', duration: 'Partagée avec la température.' },
};
export const barOf = (r: ThresholdRow, f: ThresholdForm) => {
  const sc = SCALES[r.warning];
  const lo = Math.min(sc.min, f[r.warning]);
  const hi = Math.max(sc.max, f[r.alert]);
  const p = (v: number) => ((v - lo) / (hi - lo)) * 100;
  return { w: p(f[r.warning]), a: p(f[r.alert]) };
};
export const num = (v: number, unit: string) => `${String(v).replace('.', ',')} ${unit}`;
