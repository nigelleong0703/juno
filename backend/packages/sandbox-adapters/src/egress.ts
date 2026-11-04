/**
 * Egress guard (BACKEND §7.9a): nothing running as an agent in the computer can open a connection to a private,
 * link-local, carrier-NAT or cloud-metadata address. The browser and `web_fetch` already refuse such URLs (§8.0); this is the
 * network-level rule for everything else: `curl`, a script, an MCP server, a page's own requests.
 *
 * One mechanism for every platform (local Docker and E2B): each agent lives in its own network namespace (`netns.ts`) and reaches
 * the world through a veth pair that the root namespace routes and NATs. The rules below sit on that forward path, so they apply to
 * exactly what an agent runs and never to root or the sandbox daemon (`envd`, `juno-link`), which stay in the root namespace. No
 * owner match is needed, which is what E2B's kernel (6.1.158, no `xt_owner`) could not do.
 *  - Forward: DNS to the configured nameservers is allowed (Docker's is on a private address), every blocked range is refused,
 *    agent to agent is refused (the veth subnets are inside a blocked range), IPv6 is not routed at all.
 *  - Input: nothing an agent sends reaches a service of the root namespace (the sandbox daemon, VNC, the Spaces gateway, the link);
 *    only replies to connections root made into the namespace come back.
 * E2B's own `network.denyOut` (`nativeDenyOut`) stays as the outer layer, outside the VM.
 * The computer's own loopback is the agent's own: inside its namespace (dev servers, its browser's debugging port, its apps).
 */
import { BLOCKED_IPV4, BLOCKED_IPV6 } from 'juno-agent/modules/tools/net/addressGuard';

/** The nft table that holds every rule of this file (replaced as a whole, so a rerun never duplicates). */
export const NFT_TABLE = 'juno_netns';
/** Every agent's host-side veth is named with this prefix; the rules match it as a wildcard, so they cover any number of agents. */
export const HOST_IF_PREFIX = 'jh-';
/** The private /30s of the veth pairs, one per agent: inside the benchmarking range 198.18.0.0/15 (RFC 2544), which no network routes and which is on the blocklist. */
export const AGENT_NET = '198.19.0.0/16';

/** The computer's own loopback: not a place an agent can reach anything but its own services. */
const isLoopback = ([network]: readonly [string, number]) => network === '127.0.0.0' || network === '::1';
const cidr = ([network, prefix]: readonly [string, number]) => `${network}/${prefix}`;

/** The ranges an agent may not dial, as CIDR strings (the same tables as the URL guard, minus loopback). */
export const egressRanges = () => ({
  ipv4: BLOCKED_IPV4.filter((range) => !isLoopback(range)).map(cidr),
  ipv6: BLOCKED_IPV6.filter((range) => !isLoopback(range)).map(cidr),
});

/**
 * E2B's `network.denyOut` list. E2B refuses `0.0.0.0/8` ("invalid denied CIDR", checked 2026-11-01) and takes IPv4 only.
 * Firecracker's metadata service (169.254.169.254) is answered before the network layer, so this list does not cover it;
 * the namespaces' forward rules below do.
 */
export const nativeDenyOut = (): string[] => egressRanges().ipv4.filter((range) => range !== '0.0.0.0/8');

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The IPv4 nameservers of a resolv.conf (the only addresses an agent may reach inside a blocked range, and only on port 53). */
export function nameserversOf(resolvConf: string): string[] {
  const found = new Set<string>();
  for (const line of resolvConf.split('\n')) {
    const [keyword, address] = line.trim().split(/\s+/);
    if (keyword === 'nameserver' && address !== undefined && IPV4.test(address)) found.add(address);
  }
  return [...found];
}

/**
 * The nft ruleset (one `nft -f` transaction: the old table is deleted and the new one made in the same commit, so there is never a
 * moment without rules). Written for the wildcard `jh-*`, so it needs no change when an agent is added.
 */
export function egressRuleset(nameservers: readonly string[]): string {
  const agents = `iifname "${HOST_IF_PREFIX}*"`;
  const dns = nameservers.length === 0 ? [] : [
    `${agents} ip daddr { ${nameservers.join(', ')} } udp dport 53 accept`,
    `${agents} ip daddr { ${nameservers.join(', ')} } tcp dport 53 accept`,
  ];
  return [
    `table inet ${NFT_TABLE}`,
    `delete table inet ${NFT_TABLE}`,
    `table inet ${NFT_TABLE} {`,
    '  chain input {',
    '    type filter hook input priority 0; policy accept;',
    `    ${agents} ct state established,related accept`,
    `    ${agents} drop`,
    '  }',
    '  chain forward {',
    '    type filter hook forward priority 0; policy accept;',
    `    ${agents} meta nfproto ipv6 drop`,
    `    ${agents} oifname "${HOST_IF_PREFIX}*" drop`,
    ...dns.map((rule) => `    ${rule}`),
    `    ${agents} ip daddr { ${egressRanges().ipv4.join(', ')} } reject with icmp type admin-prohibited`,
    '  }',
    '  chain postrouting {',
    '    type nat hook postrouting priority srcnat; policy accept;',
    `    ip saddr ${AGENT_NET} oifname != "${HOST_IF_PREFIX}*" masquerade`,
    '  }',
    '}',
    '',
  ].join('\n');
}
