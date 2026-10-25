import { Home, Monitor, Terminal } from 'lucide-react';

// Systems an agent installs on (add-host dialog, install instructions).
export type Platform = 'linux' | 'haos' | 'windows';

export const PLATFORMS = [
  { id: 'linux', label: 'Linux / Unraid', icon: Terminal, hint: 'Debian / Ubuntu avec systemd, WSL2, Unraid' },
  { id: 'haos', label: 'Home Assistant OS', icon: Home, hint: 'Application (add-on) de la boutique HA' },
  { id: 'windows', label: 'Windows', icon: Monitor, hint: 'Windows 10 / 11, 64 bits, service' },
] as const;
