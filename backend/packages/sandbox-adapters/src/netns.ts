/**
 * One network namespace per agent (BACKEND §7.9, §7.9a), the same on local Docker and on E2B. Root creates it when the agent's user is
 * made; everything that runs as the agent runs inside it (`inAgentNetns`). That alone separates the agents' loopbacks (an agent's
 * Chromium debugging port is invisible to the others) and puts every byte an agent sends through the root namespace's forward path,
 * where `egress.ts` blocks private and metadata addresses. Root, `envd` and `juno-link` never leave the root namespace.
 *
 * Layout per agent: namespace `juno-<hash>` (the user's name) and a veth pair `jh-<hash>` (root side, 198.19.x.y/30 .1) and `eth0`
 * (agent side, .2, default route via the root side). The /30 is picked from the agent's uid and moved on to the next free slot when
 * taken. Nothing is written for this on durable storage: a cold start loses the namespaces and `agentCommand` reports "not ready",
 * which makes `prepareNetns` run again.
 */
import { HOST_IF_PREFIX, egressRuleset, nameserversOf } from './egress.js';
import { NETNS_DIR, agentNetnsPath, agentUid, agentUser } from './isolation-user.js';
import { runLocked } from './locked.js';
import type { SandboxRuntime } from './runtime.js';
import { shq } from './shq.js';

/** A /30 per agent inside 198.19.0.0/16: 16384 slots. */
const SLOTS = 16384;

/** `ip` (iproute2) and `nft` are in the images; an older one gets them from apt once, or the error says why not. */
export const ENSURE_NET_TOOLS: readonly string[] = [
  'if ! command -v ip >/dev/null 2>&1 || ! command -v nft >/dev/null 2>&1; then',
  '  export DEBIAN_FRONTEND=noninteractive',
  '  { apt-get update -qq && apt-get install -y -qq --no-install-recommends iproute2 nftables; } >/dev/null 2>&1 || { echo "network isolation needs iproute2 and nftables and apt-get could not install them (no network?)" >&2; exit 1; }',
  'fi',
];

/** The root side of the network, once per computer: forwarding on, and the nft rules of `egress.ts`. */
export function hostNetScript(nameservers: readonly string[]): string {
  return [
    'set -e',
    ...ENSURE_NET_TOOLS,
    // Docker leaves forwarding on and /proc/sys read-only; E2B's kernel starts with it off.
    '[ "$(cat /proc/sys/net/ipv4/ip_forward)" = 1 ] || sysctl -qw net.ipv4.ip_forward=1 || { echo "cannot turn IPv4 forwarding on" >&2; exit 1; }',
    `printf '%s' ${shq(egressRuleset(nameservers))} | nft -f -`,
  ].join('\n');
}

/**
 * Put the forward rules in place (idempotent, one transaction). Runs as root before any agent action: when the computer is created,
 * after a cold start (the kernel rules are gone), the first time this process looks at a running computer, and with every new agent.
 */
export async function applyEgressGuard(root: SandboxRuntime): Promise<void> {
  const nameservers = nameserversOf(await root.readText('/etc/resolv.conf').catch(() => ''));
  await runLocked(root, hostNetScript(nameservers), 'close the computer to private networks');
}

/** This agent's namespace and veth pair (idempotent: a cold start recreates what it lost, a running one is left alone). */
export function agentNetnsScript(agentId: string): string {
  const name = agentUser(agentId);
  const host = HOST_IF_PREFIX + name.slice('juno-'.length);
  const file = agentNetnsPath(agentId);
  return [
    'set -e',
    `NS=${name}; H=${host}; D=${file}`,
    `mkdir -p ${NETNS_DIR}`,
    // A file left by a restart that lost the mount is not a namespace: replace it.
    'nsenter --net=$D true 2>/dev/null || { rm -f $D; ip netns add $NS || { echo "cannot create a network namespace (a local container needs --cap-add SYS_ADMIN)" >&2; exit 1; }; }',
    'ip netns exec $NS ip link set lo up',
    // No IPv6 in the namespace at all: there is no route out, and nothing to leak through one.
    'ip netns exec $NS sysctl -qw net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1 2>/dev/null || true',
    // The pair is made when the namespace has no eth0 (a new namespace); a root side left over from a lost one goes first.
    'ip netns exec $NS ip link show eth0 >/dev/null 2>&1 || { ip link delete $H 2>/dev/null || true; ip link add $H type veth peer name eth0 netns $NS; }',
    "cur=$(ip -4 -o addr show dev $H | awk '{print $4}' | head -n 1)",
    'if [ -z "$cur" ]; then',
    "  used=$(ip -4 -o addr show | awk '{print $4}')",
    `  slot=${agentUid(agentId) % SLOTS}`,
    '  while :; do',
    '    cur="198.19.$((slot / 64)).$((slot % 64 * 4 + 1))/30"',
    '    echo "$used" | grep -qxF "$cur" || break',
    `    slot=$(( (slot + 1) % ${SLOTS} ))`,
    '  done',
    '  ip addr add "$cur" dev $H',
    'fi',
    'hostip=${cur%/*}; last=${hostip##*.}; peer="${hostip%.*}.$((last + 1))"',
    'ip link set $H up',
    'ip netns exec $NS ip addr replace "$peer/30" dev eth0',
    'ip netns exec $NS ip link set eth0 up',
    'ip netns exec $NS ip route replace default via "$hostip"',
  ].join('\n');
}

/** The forward rules are in place and this agent has its namespace. */
export async function prepareNetns(root: SandboxRuntime, agentId: string): Promise<void> {
  await applyEgressGuard(root);
  await runLocked(root, agentNetnsScript(agentId), `give agent ${agentId} its network`);
}
