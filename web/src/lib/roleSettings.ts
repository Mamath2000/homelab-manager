import { Boxes, Cpu, Home, Network, ScrollText, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { HubRole, HubRoleType } from './api';

// The options a role unlocks, opened from its card in a window over the Rôles screen: /roles/<id>?role=<role id> (without
// role: the only role of the type). They used to be tabs of Paramètres, then pages: old links still lead here.
// mqtt: the accounts of a broker secured by the hub; esphome: the devices found on the broker of the role of a site.
export const ROLE_PAGES = [
  { id: 'mqtt', label: 'Comptes MQTT', action: 'Gérer les comptes', icon: ShieldCheck, type: 'mqtt-broker' },
  { id: 'homeassistant', label: 'Home Assistant', action: 'Home Assistant', icon: Home, type: 'mqtt-broker' },
  { id: 'pve', label: 'Proxmox VE', action: 'Inventaire', icon: Boxes, type: 'pve-cluster' },
  { id: 'omada', label: 'Omada', action: 'Inventaire', icon: Network, type: 'omada-controller' },
  { id: 'esphome', label: 'ESPHome', action: 'Inventaire', icon: Cpu, type: 'esphome' },
  { id: 'logs', label: 'Logs', action: 'Hôtes émetteurs', icon: ScrollText, type: 'log-server' },
] as const satisfies readonly { id: string; label: string; action: string; icon: LucideIcon; type: HubRoleType }[];

export type RolePageId = (typeof ROLE_PAGES)[number]['id'];

// The options shown in the foot of the card of a role (the accounts of a broker have their own button). Home Assistant:
// on the broker it uses, or on every broker while it uses none.
export function rolePagesOf(role: HubRole, haBrokerId: string | null) {
  return ROLE_PAGES.filter((p) => p.type === role.type && p.id !== 'mqtt' && (p.id !== 'homeassistant' || !haBrokerId || haBrokerId === role.id));
}

// The role a page of options is opened on: the one asked, else the only one of the type (null: nothing to open).
export function roleOfPage(page: string | undefined, askedId: string | null, roles: HubRole[]) {
  const def = ROLE_PAGES.find((p) => p.id === page);
  if (!def) return undefined;
  const ofType = roles.filter((r) => r.type === def.type);
  return ofType.find((r) => r.id === askedId) ?? (!askedId && ofType.length === 1 ? ofType[0] : null);
}
