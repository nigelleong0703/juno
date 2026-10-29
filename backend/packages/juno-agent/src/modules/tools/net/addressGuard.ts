/**
 * Which network addresses an agent may reach (BACKEND 8.0 内网拦截). Shared by the policy rule for
 * `browser.navigate` / `web_fetch` (name-only check, no DNS) and by `web_fetch`'s connect-time check
 * (every resolved address, every redirect hop).
 */

import { BlockList, isIP } from 'node:net';

const BLOCKED = new BlockList();
const BLOCKED_IPV4: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
for (const [network, prefix] of BLOCKED_IPV4) BLOCKED.addSubnet(network, prefix, 'ipv4');
BLOCKED.addAddress('::', 'ipv6');
BLOCKED.addAddress('::1', 'ipv6');
BLOCKED.addSubnet('fc00::', 7, 'ipv6');
BLOCKED.addSubnet('fe80::', 10, 'ipv6');
BLOCKED.addSubnet('ff00::', 8, 'ipv6');
const BLOCKED_SUFFIXES: readonly string[] = ['.localhost', '.local', '.internal', '.ts.net'];

/** A literal IP (v4 or v6) in a blocked range. A non-IP string is not judged here; see isBlockedHostname. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Name-only judgement: IP literals by range, names by shape (localhost, single label, internal suffixes). */
export function isBlockedHostname(raw: string): boolean {
  const host = raw.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  if (isIP(host) !== 0) return isBlockedAddress(host);
  return host === '' || host === 'localhost' || !host.includes('.') || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Whether a URL points at the host, a private network or the cloud metadata service. `new URL` already turns
 * decimal, hex and octal IPv4 into dotted form. A hostname is only judged by its name here (no DNS lookup);
 * `web_fetch` resolves and checks the addresses itself.
 */
export function targetsPrivateNetwork(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  return isBlockedHostname(url.hostname);
}
