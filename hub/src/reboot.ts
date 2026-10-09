// Packages whose upgrade only takes effect after a reboot (kernel, microcode, firmware,
// and the core userland that every process links against).
const PREFIXES = [
  'linux-image-',
  'linux-modules-',
  'linux-signed-image-',
  'proxmox-kernel-',
  'pve-kernel-',
  'linux-firmware',
  'firmware-',
];
const EXACT = new Set([
  'intel-microcode',
  'amd64-microcode',
  'libc6',
  'libc-bin',
  'systemd',
  'libsystemd0',
  'systemd-sysv',
  'dbus',
  'dbus-daemon',
  'dbus-system-bus-common',
]);

export function needsReboot(pkg: string) {
  return EXACT.has(pkg) || PREFIXES.some((p) => pkg.startsWith(p));
}
