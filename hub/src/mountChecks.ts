import type { HostDoc } from './types.js';

// One prerequisite of a host: met (true), not met (false) or unknown (null: agent offline or too old to tell).
export interface TargetCheck {
  ok: boolean | null;
  note: string | null;
}

export const yes = (note: string | null = null): TargetCheck => ({ ok: true, note });
export const no = (note: string): TargetCheck => ({ ok: false, note });
export const unknown = (note: string): TargetCheck => ({ ok: null, note });

export interface MountPrerequisites {
  os: TargetCheck; // a system that can mount (Linux with systemd; not Windows, WSL nor Home Assistant OS)
  fuse: TargetCheck;
  pbsClient: TargetCheck; // proxmox-backup-client installed natively
}

// What the hub knows of the mount prerequisites of a host, from its capabilities (agent: mountPrerequisites).
export function mountPrerequisites(h: Pick<HostDoc, 'capabilities' | 'info'>): MountPrerequisites {
  const caps = h.capabilities ?? [];
  const told = caps.includes('mount_checks');
  const mounts = caps.includes('pbs_mount');
  const osName = h.info?.osName || null;
  const os =
    h.info?.osId === 'windows'
      ? no('Windows : pas de montage')
      : mounts
        ? yes(osName)
        : told
          ? !caps.includes('mount_os')
            ? no('WSL ou Home Assistant OS : pas de montage')
            : caps.includes('systemd')
              ? yes(osName)
              : no('systemd absent')
          : unknown('agent à mettre à jour pour le savoir');
  const fuse = mounts ? yes() : told ? (caps.includes('fuse') ? yes() : no('/dev/fuse absent (conteneur LXC : activer la fonctionnalité « FUSE » dans Proxmox)')) : unknown('agent à mettre à jour pour le savoir');
  const pbsClient = caps.includes('backup:native')
    ? yes()
    : caps.includes('backup:docker')
      ? no("client en image Docker, qui ne peut pas monter : installer le client par APT depuis la fiche de l'hôte")
      : no("proxmox-backup-client absent : l'installer par APT depuis la fiche de l'hôte");
  return { os, fuse, pbsClient };
}
