import type { Host, HubRole, HubRoleType } from './api';
import type { Tone } from './status';

// Services the agent found that are not a role yet (a role on the same port counts as activated); the ones that
// listen on loopback only are left out: the hub cannot reach them.
export const offeredCandidates = (host: Host) => (host.roleCandidates ?? []).filter((c) => !c.local && !host.roles.some((r) => r.type === 'mqtt-broker' && r.config.port === c.port));

export const ROLE_TYPES: { id: HubRoleType; label: string; hint: string }[] = [
  { id: 'mqtt-broker', label: 'Broker MQTT', hint: 'écouté par les sondes MQTT, et broker de l’intégration Home Assistant' },
  { id: 'pve-reporting', label: 'Reporting PVE', hint: 'VM et CT d’un cluster Proxmox VE, leurs jobs vzdump et le résultat de leurs sauvegardes' },
  { id: 'pbs-primary', label: 'PBS principal', hint: 'le Proxmox Backup Server des sauvegardes : groupes relevés, jobs des agents, montages' },
  { id: 'pbs-offsite', label: 'PBS hors site', hint: 'un second PBS, distant, qui copie chaque jour les sauvegardes choisies du principal' },
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
