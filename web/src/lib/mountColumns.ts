import type { CheckColumn } from '../components/ExcludedHostsModal';

// the columns shared by the mount and the database restore
export const MOUNT_COLUMNS: CheckColumn[] = [
  { key: 'online', label: 'En ligne', title: 'Agent connecté' },
  { key: 'agent', label: 'Agent', title: 'Agent à jour' },
  { key: 'os', label: 'OS', title: 'Système qui peut monter : Linux avec systemd (ni Windows, ni WSL, ni Home Assistant OS)' },
  { key: 'fuse', label: 'FUSE', title: '/dev/fuse présent (conteneur LXC : fonctionnalité « FUSE » de Proxmox)' },
  { key: 'pbsClient', label: 'Client PBS', title: 'proxmox-backup-client installé nativement' },
];
