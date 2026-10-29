// First private IPv4 of the host, the address the other machines reach it at.
export function lanAddress(ips: string[] | null | undefined) {
  const v4 = (ips ?? []).map((ip) => ip.replace(/\/\d+$/, '')).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !ip.startsWith('127.') && !ip.startsWith('169.254.'));
  return v4.find((ip) => ip.startsWith('192.168.') || ip.startsWith('10.')) ?? v4.find((ip) => !/^172\.(1[7-9]|2\d|3[01])\./.test(ip)) ?? v4[0] ?? '';
}
