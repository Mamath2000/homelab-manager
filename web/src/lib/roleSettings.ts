import { Boxes, Cpu, Home, Network, ScrollText, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { HubRole, HubRoleType } from './api';

// The settings that come with a type of role, each on its own page under the Rôles screen (/roles/<id>), opened from
// the section of that type (action: the label of its button there). They used to be tabs of Paramètres, shown or hidden by the roles declared.
export const ROLE_PAGES = [
  { id: 'mqtt', label: 'Comptes MQTT', action: 'Comptes MQTT', icon: ShieldCheck, type: 'mqtt-broker' },
  { id: 'homeassistant', label: 'Home Assistant', action: 'Home Assistant', icon: Home, type: 'mqtt-broker' },
  { id: 'pve', label: 'Proxmox VE', action: 'Inventaire', icon: Boxes, type: 'pve-cluster' },
  { id: 'omada', label: 'Omada', action: 'Inventaire', icon: Network, type: 'omada-controller' },
  { id: 'esphome', label: 'ESPHome', action: 'Réglages', icon: Cpu, type: 'esphome' },
  { id: 'logs', label: 'Logs', action: 'Hôtes émetteurs', icon: ScrollText, type: 'log-server' },
] as const satisfies readonly { id: string; label: string; action: string; icon: LucideIcon; type: HubRoleType }[];

export type RolePageId = (typeof ROLE_PAGES)[number]['id'];

// The pages a section of roles offers: the accounts of the brokers only when one of them can manage its accounts.
export function rolePagesOf(type: HubRoleType, roles: HubRole[]) {
  return ROLE_PAGES.filter((p) => p.type === type && (p.id !== 'mqtt' || roles.some((r) => r.type === 'mqtt-broker' && r.security.state !== 'unavailable')));
}
