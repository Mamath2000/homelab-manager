// IPv4 subnets in CIDR notation, as Omada gives them (the networks a site-to-site VPN carries, homelab#261).

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipToInt(ip: string): number | null {
  const m = IPV4_RE.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

const intToIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const maskOf = (bits: number) => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);

// "192.168.10.1/24" (a gateway address) or { ip, mask } -> "192.168.10.0/24"; null when unreadable
export function networkOf(v: unknown): string | null {
  let ip: string;
  let bits: number;
  if (typeof v === 'string') {
    const [a, b] = v.trim().split('/');
    ip = a;
    bits = b === undefined ? 32 : Number(b);
  } else if (v && typeof v === 'object' && typeof (v as { ip?: unknown }).ip === 'string') {
    ip = (v as { ip: string }).ip;
    bits = Number((v as { mask?: unknown }).mask);
  } else return null;
  const n = ipToInt(ip);
  if (n === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  return `${intToIp((n & maskOf(bits)) >>> 0)}/${bits}`;
}

export function inSubnet(ip: string, cidr: string): boolean {
  const n = ipToInt(ip);
  const [net, b] = cidr.split('/');
  const base = ipToInt(net);
  const bits = Number(b);
  if (n === null || base === null || !Number.isInteger(bits)) return false;
  const mask = maskOf(bits);
  return ((n & mask) >>> 0) === ((base & mask) >>> 0);
}

// The first address of the list in one of the subnets ('' : none)
export const addressIn = (ips: (string | undefined)[], subnets: string[]) => ips.find((ip) => !!ip && subnets.some((s) => inSubnet(ip, s))) ?? '';
