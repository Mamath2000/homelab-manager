// Default fastfetch configuration of the welcome screen (Paramètres > Standardisation), written by the agent
// to /etc/homelab/fastfetch.jsonc. Generic: the Klipper line only shows where the service exists, the
// address is the one of the default route interface, /boot/firmware only shows on a Raspberry Pi.
const config = {
  $schema: 'https://github.com/fastfetch-cli/fastfetch/raw/dev/doc/json_schema.json',
  logo: {
    source: 'debian',
    padding: { top: 1, left: 2, right: 3 },
    color: { '1': 'red', '2': 'red' },
  },
  display: {
    separator: '  ',
    color: { keys: 'blue', title: 'red' },
    key: { width: 16 },
    bar: { charElapsed: '■', charTotal: '·', borderLeft: '', borderRight: '', width: 12 },
    percent: { type: ['bar', 'num'], color: { green: 'green', yellow: 'yellow', red: 'red' } },
    size: { binaryPrefix: 'iec', ndigits: 1 },
    temp: { unit: 'C', ndigits: 0 },
  },
  modules: [
    'break',
    { type: 'title', format: '{user-name-colored}{at-symbol-colored}{host-name-colored}' },
    { type: 'custom', format: '\u001b[90m┌──────────────── Système ────────────────' },
    { type: 'os', key: '│ OS', keyColor: 'red', format: '{pretty-name} {arch}' },
    { type: 'host', key: '│ Machine', keyColor: 'red' },
    { type: 'kernel', key: '│ Kernel', keyColor: 'red' },
    { type: 'uptime', key: '│ Uptime', keyColor: 'red' },
    { type: 'packages', key: '│ Paquets', keyColor: 'red' },
    // a failing command hides the line
    {
      type: 'command',
      key: '│ Klipper',
      keyColor: 'red',
      text: "systemctl cat klipper.service >/dev/null 2>&1 || exit 1; for s in klipper moonraker; do printf '%s:%s  ' $s $(systemctl is-active $s); done",
    },
    { type: 'command', key: '│ Docker', keyColor: 'red', text: "docker ps -q 2>/dev/null | wc -l | xargs -I{} echo '{} conteneur(s) actif(s)'" },
    { type: 'custom', format: '\u001b[90m├──────────────── Matériel ───────────────' },
    { type: 'cpu', key: '│ CPU', keyColor: 'yellow', temp: true, format: '{name} ({cores-logical}) @ {freq-max} {temperature}' },
    { type: 'loadavg', key: '│ Load', keyColor: 'yellow' },
    { type: 'memory', key: '│ RAM', keyColor: 'yellow' },
    { type: 'swap', key: '│ Swap', keyColor: 'yellow' },
    {
      type: 'disk',
      key: '│ {mountpoint}',
      keyColor: 'yellow',
      folders: '/:/boot/firmware',
      format: '{size-percentage-bar} {size-used} / {size-total} ({size-percentage}) {filesystem}',
    },
    { type: 'custom', format: '\u001b[90m├──────────────── Réseau ─────────────────' },
    {
      type: 'localip',
      key: '│ {ifname}',
      keyColor: 'green',
      showIpv4: true,
      showIpv6: false,
      showMac: true,
      showPrefixLen: true,
      defaultRouteOnly: true,
    },
    { type: 'command', key: '│ Gateway', keyColor: 'green', text: "ip -4 route show default | awk '{print $3\" via \"$5; exit}'" },
    { type: 'dns', key: '│ DNS', keyColor: 'green', showType: 'ipv4' },
    { type: 'custom', format: '\u001b[90m└─────────────────────────────────────────' },
    'break',
    { type: 'colors', symbol: 'circle', paddingLeft: 2 },
  ],
};

export const DEFAULT_FASTFETCH = JSON.stringify(config, null, 2) + '\n';
