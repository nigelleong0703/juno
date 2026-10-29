/**
 * Spaces in the computer (BACKEND 5.12), the root half: what computerd does so an agent's app can be reached.
 *
 * The agent's app listens on a loopback port as the agent's Linux user. Before the platform wires a route to it,
 * root asks the kernel's socket table (/proc/net/tcp*) who really holds that port; nothing the agent wrote (a port
 * file, a claim in a tool call) is believed. Then root writes the route into /etc/juno/spaces.json (root-only), limits
 * the port to root and that agent's uid with iptables (the same owner rules as the CDP ports, BACKEND 7.9) and makes
 * sure the gateway process (files/spaces/gateway.mjs, port 7090, root) is up. Root never reads or runs anything the
 * agent can write.
 */
import type { E2bBinding } from '@agent-desktop/contracts';
import { failed } from './errors.js';
import { firewallScript, ownerOnlyPortRules, rootOnlyPortRules, runLocked } from './isolation.js';
import { ISOLATION_TMP, agentUser } from './isolation-user.js';
import type { ComputerProvider } from './provider.js';
import type { SandboxRuntime } from './runtime.js';
import { shq } from './shq.js';

/** The gateway's port inside every computer; reachable from outside (docker publish / E2B host), refused to every agent uid. */
export const GATEWAY_PORT = 7090;
const GATEWAY_SCRIPT = '/opt/juno/spaces/gateway.mjs';
const GATEWAY_PID = '/run/juno/spaces-gateway.pid';
const GATEWAY_LOG = '/run/juno/spaces-gateway.log';
const SPACES_FILE = '/etc/juno/spaces.json';
/** The key the gateway demands as `X-Juno-Gateway-Key`; root-only, so only the platform can open the way in from outside. */
const GATEWAY_KEY_FILE = '/etc/juno/gateway.key';
/** The ports apps may use; space_publish allocates from here. */
export const SPACE_PORTS = { first: 7100, last: 7999 } as const;
export const SPACE_ID = /^[a-z0-9]{8,64}$/;

export interface ListeningPort {
  port: number;
  uid: number;
  /** Bound to 127.0.0.1 or ::1 only (not 0.0.0.0, not a LAN address). */
  loopback: boolean;
}

export interface SpaceRegistration {
  agentId: string;
  spaceId: string;
  port: number;
  /** The computer's gateway key (derived by computerd); written root-only into the computer. */
  gatewayKey: string;
}

const LOOPBACK = new Set(['0100007F', '00000000000000000000000001000000', '0000000000000000FFFF00000100007F']);

/** Listening TCP sockets with their owner uid, from the text of /proc/net/tcp and /proc/net/tcp6 (header lines are skipped). */
export function parseListeners(procNetTcp: string): ListeningPort[] {
  const sockets: ListeningPort[] = [];
  for (const line of procNetTcp.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 8 || columns[3] !== '0A') continue;
    const [address = '', hexPort = ''] = (columns[1] ?? '').split(':');
    const port = Number.parseInt(hexPort, 16);
    const uid = Number(columns[7]);
    if (Number.isInteger(port) && Number.isInteger(uid)) sockets.push({ port, uid, loopback: LOOPBACK.has(address.toUpperCase()) });
  }
  return sockets;
}

/** Why the listeners on a port do not make it this agent's app, or undefined when they do. */
export function listenerProblem(port: number, onPort: readonly ListeningPort[], agentUid: number): string | undefined {
  if (onPort.length === 0) return `nothing is listening on port ${port}: start the app on its port (it must keep running), then publish again`;
  if (onPort.some((socket) => socket.uid !== agentUid)) return `port ${port} is held by a process that is not this agent's: the app must run as you on the port space_publish gave it`;
  if (onPort.some((socket) => !socket.loopback)) return `port ${port} is open beyond this computer: the app must listen on 127.0.0.1 only`;
  return undefined;
}

const PROC_NET_TCP = 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null';

async function sockets(root: SandboxRuntime): Promise<ListeningPort[]> {
  const result = await root.run(PROC_NET_TCP, { timeoutMs: 15_000 });
  return parseListeners(result.stdout);
}

/** Every listening port of the computer (used to pick a free port for a new app). */
export const listeningPorts = sockets;

const ROUTE_PY = [
  'import json,os,sys',
  'path,space,port,uid=sys.argv[1],sys.argv[2],int(sys.argv[3]),int(sys.argv[4])',
  'try:',
  '    routes=json.load(open(path)).get("routes",{})',
  'except Exception:',
  '    routes={}',
  // A port belongs to one space: a stale route that still names it is dropped.
  'routes={k:v for k,v in routes.items() if v.get("port")!=port or k==space}',
  'routes[space]={"port":port,"uid":uid}',
  'tmp=path+".tmp"',
  'fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)',
  'os.write(fd,json.dumps({"routes":routes}).encode())',
  'os.close(fd)',
  'os.replace(tmp,path)',
].join('\n');

/** Start the gateway if it does not answer (idempotent, root). Its pid file lives in the root-only /run/juno. */
export async function ensureGateway(root: SandboxRuntime, gatewayKey: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(gatewayKey)) throw failed('invalid gateway key');
  // The key travels through a root-only scratch file, never a command line, and is rewritten on every ensure.
  const scratch = `${ISOLATION_TMP}/gateway-key-${gatewayKey.slice(0, 8)}`;
  await root.run(`mkdir -p ${ISOLATION_TMP} && chmod 0700 ${ISOLATION_TMP}`, { timeoutMs: 15_000 });
  await root.writeText(scratch, gatewayKey);
  const installed = await root.run(`install -m 0600 -o root -g root ${scratch} ${GATEWAY_KEY_FILE}; status=$?; rm -f ${scratch}; exit $status`, { timeoutMs: 15_000 });
  if (installed.exitCode !== 0) throw failed(`could not install the gateway key: ${(installed.stderr || installed.stdout).trim().slice(0, 300)}`);
  const health = `curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:${GATEWAY_PORT}/__health`;
  const script = [
    'set -e',
    `{ command -v bun >/dev/null 2>&1 && [ -f ${GATEWAY_SCRIPT} ]; } || { echo "this computer's image has no Bun or no Spaces gateway: rebuild the image" >&2; exit 1; }`,
    'mkdir -p /run/juno /etc/juno && chmod 0700 /run/juno',
    firewallScript(rootOnlyPortRules([GATEWAY_PORT])),
    `if ${health} 2>/dev/null; then exit 0; fi`,
    `JUNO_SPACES_PIDFILE=${GATEWAY_PID} setsid nohup bun ${GATEWAY_SCRIPT} >>${GATEWAY_LOG} 2>&1 </dev/null &`,
    `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25; do ${health} 2>/dev/null && exit 0; sleep 0.2; done`,
    `echo "the Spaces gateway did not start: $(tail -n 5 ${GATEWAY_LOG} 2>/dev/null)" >&2; exit 1`,
  ].join('\n');
  // Not under the isolation lock: the gateway would inherit the lock's file descriptor and hold it for good.
  const result = await root.run(script, { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw failed(`could not start the Spaces gateway: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
}

/**
 * Wire one app: verify the listener (as the kernel sees it), write its route, restrict its port to root and its agent,
 * make sure the gateway runs. Throws a plain `failed` with the reason the agent should act on.
 */
export async function registerSpace(root: SandboxRuntime, input: SpaceRegistration): Promise<void> {
  if (!SPACE_ID.test(input.spaceId)) throw failed('invalid space id');
  if (!Number.isInteger(input.port) || input.port < SPACE_PORTS.first || input.port > SPACE_PORTS.last) {
    throw failed(`ports for apps are ${SPACE_PORTS.first}-${SPACE_PORTS.last}`);
  }
  const user = agentUser(input.agentId);
  const uidResult = await root.run(`id -u ${user}`, { timeoutMs: 15_000 });
  const agentUid = Number(uidResult.stdout.trim());
  if (uidResult.exitCode !== 0 || !Number.isInteger(agentUid) || agentUid <= 0) throw failed('this agent has no user in the computer yet');
  const problem = listenerProblem(input.port, (await sockets(root)).filter((socket) => socket.port === input.port), agentUid);
  if (problem !== undefined) throw failed(problem);
  const script = [
    'set -e',
    'mkdir -p /etc/juno',
    firewallScript(ownerOnlyPortRules(`JUNO_SPACE_${input.port}`, input.port, user)),
    `python3 -c ${shq(ROUTE_PY)} ${SPACES_FILE} ${input.spaceId} ${input.port} ${agentUid}`,
    `chmod 0600 ${SPACES_FILE}`,
  ].join('\n');
  await runLocked(root, script, 'wire the app');
  await ensureGateway(root, input.gatewayKey);
}

type WithRoot = <T>(binding: E2bBinding, signal: AbortSignal, fn: (root: SandboxRuntime) => Promise<T>) => Promise<T>;

/** The provider methods every provider shares: each is a root runtime call (`withRoot` resumes a paused computer first). */
export function spaceMethods(withRoot: WithRoot): Pick<ComputerProvider, 'listeningPorts' | 'registerSpace' | 'ensureSpaceGateway'> {
  return {
    listeningPorts: (binding, signal) => withRoot(binding, signal, listeningPorts),
    registerSpace: (binding, input, signal) => withRoot(binding, signal, (root) => registerSpace(root, input)),
    ensureSpaceGateway: (binding, gatewayKey, signal) => withRoot(binding, signal, (root) => ensureGateway(root, gatewayKey)),
  };
}
