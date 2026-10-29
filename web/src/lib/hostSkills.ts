import { Archive, ArchiveRestore, BatteryCharging, Cloud, Container, Database, HardDrive, Home, Layers, Radio, Server, type LucideIcon } from 'lucide-react';
import type { DatabaseKind, Host, HostBackupJobs } from './api';
import { backupClient, databaseKindLabel } from './backups';

// What a host does, for the badges of its options: nature (Proxmox node, PBS), roles declared on it and what its agent reads.
export interface HostSkill {
  label: string;
  title: string;
  icon: LucideIcon;
  // tinted tile: icon colour, background and ring
  cls: string;
}

const tint = {
  orange: 'bg-orange-500/15 text-orange-300 ring-orange-500/30',
  sky: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  teal: 'bg-teal-500/15 text-teal-300 ring-teal-500/30',
  violet: 'bg-violet-500/15 text-violet-300 ring-violet-500/30',
  blue: 'bg-blue-500/15 text-blue-300 ring-blue-500/30',
  emerald: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  amber: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  yellow: 'bg-yellow-500/15 text-yellow-200 ring-yellow-500/30',
  rose: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  indigo: 'bg-indigo-500/15 text-indigo-300 ring-indigo-500/30',
  cyan: 'bg-cyan-500/15 text-cyan-300 ring-cyan-500/30',
};

// jobs: backup view of the host (engines found by its agent, Nextcloud AIO instance), undefined while not loaded
export function hostSkills(h: Host, jobs?: Pick<HostBackupJobs, 'databases' | 'nextcloudPlugin' | 'nextcloud'>): HostSkill[] {
  const databases = jobs?.databases ?? null;
  const caps = h.capabilities ?? [];
  const client = backupClient(caps);
  return [
    caps.includes('pve') && { label: 'PVE', title: 'Nœud Proxmox VE', icon: Server, cls: tint.orange },
    caps.includes('pbs') && { label: 'PBS', title: 'Serveur Proxmox Backup Server', icon: Archive, cls: tint.sky },
    client.mode && { label: 'Client PBS', title: `Client de sauvegarde PBS installé (${client.mode})`, icon: ArchiveRestore, cls: tint.teal },
    ...h.roles.map((r) => ({ label: 'Broker MQTT', title: `${r.name} · ${r.url || `port ${r.port}`}`, icon: Radio, cls: tint.violet })),
    ...(databases ?? []).map((k) => ({ label: databaseKindLabel[k], title: `Moteur ${databaseKindLabel[k]} détecté par l’agent`, icon: Database, cls: tint.rose })),
    jobs?.nextcloudPlugin && jobs.nextcloud && { label: 'Nextcloud AIO', title: 'Instance Nextcloud AIO détectée (plugin de sauvegarde activé)', icon: Cloud, cls: tint.indigo },
    h.docker && { label: 'Docker', title: `${h.docker.engine} · Compose ${h.docker.compose}`, icon: Container, cls: tint.blue },
    caps.includes('smart') && { label: 'SMART', title: `Disques physiques suivis : ${h.smartDevices.length || 'aucun choisi'}`, icon: HardDrive, cls: tint.emerald },
    caps.includes('raid') && { label: 'RAID', title: 'Arrays mdadm, Unraid ou Ceph lus sur l’hôte', icon: Layers, cls: tint.amber },
    caps.includes('ups') && { label: 'UPS', title: 'Onduleur suivi par NUT', icon: BatteryCharging, cls: tint.yellow },
    caps.includes('ha_backups') && { label: 'Sauvegardes HA', title: 'Sauvegardes Home Assistant remontées', icon: Home, cls: tint.cyan },
  ].filter((s): s is HostSkill => !!s);
}
