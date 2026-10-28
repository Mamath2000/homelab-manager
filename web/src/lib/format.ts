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
  shutdown: 'Extinction',
  lock: 'Verrouillage de session',
  agent_update: "Mise à jour de l'agent",
  docker_check: 'Vérification des images Docker',
  docker_up: 'Démarrage de stack',
  docker_stop: 'Arrêt de stack',
  docker_restart: 'Redémarrage de stack',
  docker_update: 'Mise à jour de stack',
  setup_apply: 'Standardisation',
  backup_run: 'Sauvegarde',
  offsite_run: 'Copie déportée',
  backup_install: 'Installation du client PBS',
};

// "Mise à jour de stack · web/app": action plus its stack (and service) for docker jobs
export function jobTitle(j: { action: string; stack?: string | null; service?: string | null; backupJobName?: string | null; method?: string | null }) {
  const label = actionLabel[j.action] ?? j.action;
  if (j.method) return `${label} · ${j.method === 'apt' ? 'APT' : 'Docker'}`;
  if (j.backupJobName) return `${label} · ${j.backupJobName}`;
  if (!j.stack) return label;
  return `${label} · ${j.stack}${j.service ? `/${j.service}` : ''}`;
}

// IPs of a host split by kind. Docker bridges are recognised by their address (172.x.0.1, the bridge gateway), as the
// agent reports no interface names; Tailscale = CGNAT range 100.64.0.0/10 or the fd7a:115c:a1e0::/48 ULA.
export function groupIps(ips: string[] | null | undefined): { lan: string[]; tailscale: string[] } {
  const lan: string[] = [];
  const tailscale: string[] = [];
  for (const ip of ips ?? []) {
    const m = /^(\d+)\.(\d+)\./.exec(ip);
    if (/^172\.\d+\.0\.1$/.test(ip)) continue;
    if ((m && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127) || ip.toLowerCase().startsWith('fd7a:115c:a1e0:')) tailscale.push(ip);
    else lan.push(ip);
  }
  return { lan, tailscale };
}
