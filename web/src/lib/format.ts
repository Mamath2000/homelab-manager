const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });

export function timeAgo(value: string | number | null | undefined) {
  if (!value) return 'jamais';
  const t = typeof value === 'number' ? value : Date.parse(value);
  const diff = (t - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "à l'instant";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export function dateTime(value: string | number | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

export function duration(from: string, to: string | null) {
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function uptime(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}j ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export const actionLabel: Record<string, string> = {
  apt_report: 'Relevé des paquets',
  apt_update: 'Recherche de mises à jour',
  apt_upgrade: 'Mise à jour',
  apt_autoremove: 'Nettoyage des paquets',
  reboot: 'Redémarrage',
  agent_update: "Mise à jour de l'agent",
};
