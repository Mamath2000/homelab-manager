import type { Host, HubRole, HubRoleType } from './api';
import type { Tone } from './status';

// Services the agent found that are not a role yet (a role on the same port counts as activated); the ones that
// listen on loopback only are left out: the hub cannot reach them.
// First private IPv4 among the addresses of a host (hub/src/hostAddress.ts): the one the other machines reach it at.
export function lanAddress(ips: string[] | null | undefined) {
  const v4 = (ips ?? []).map((ip) => ip.replace(/\/\d+$/, '')).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !ip.startsWith('127.') && !ip.startsWith('169.254.'));
  return v4.find((ip) => ip.startsWith('192.168.') || ip.startsWith('10.')) ?? v4.find((ip) => !/^172\.(1[7-9]|2\d|3[01])\./.test(ip)) ?? v4[0] ?? '';
}

export const offeredCandidates = (host: Host) => (host.roleCandidates ?? []).filter((c) => c.type === 'mqtt-broker' && !c.local && !host.roles.some((r) => r.type === 'mqtt-broker' && r.config.port === c.port));

export const ROLE_TYPES: { id: HubRoleType; label: string; hint: string }[] = [
  { id: 'mqtt-broker', label: 'Broker MQTT', hint: 'écouté par les sondes MQTT, et broker de l’intégration Home Assistant' },
  { id: 'pve-cluster', label: 'Cluster Proxmox VE', hint: 'Inventaire d’un cluster Proxmox VE (nœuds, VM et CT, jobs vzdump) : les hôtes y sont reliés à leur VM ou CT' },
  { id: 'pbs-primary', label: 'PBS principal', hint: 'le Proxmox Backup Server des sauvegardes : groupes relevés, jobs des agents, montages' },
  { id: 'pbs-offsite', label: 'PBS hors site', hint: 'un second PBS, distant, qui copie chaque jour les sauvegardes choisies du principal' },
  { id: 'omada-controller', label: 'Contrôleur Omada', hint: 'l’Open API du contrôleur Omada d’un site (application en mode client), source à venir des équipements réseau' },
];
// one role of these types in the homelab
export const SINGLE_ROLES: HubRoleType[] = ['pbs-primary', 'pbs-offsite'];
export const roleTypeLabel = (t: HubRoleType) => ROLE_TYPES.find((x) => x.id === t)?.label ?? t;

export const roleStatus = (b: { status: HubRole['status']; url: string }): { label: string; tone: Tone } =>
  !b.url ? { label: 'Adresse inconnue', tone: 'warn' }
    : !b.status ? { label: 'Inactif', tone: 'neutral' }
      : b.status.state === 'connected' ? { label: 'Connecté', tone: 'ok' }
        : b.status.state === 'connecting' ? { label: 'Connexion…', tone: 'info' }
          : { label: 'Injoignable', tone: 'warn' };
