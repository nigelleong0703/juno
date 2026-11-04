/**
 * Spaces in the computer (BACKEND 5.12), the root half: what computerd does so an agent's app can be reached.
 *
 * The agent's app listens on a loopback port as the agent's Linux user, inside the agent's network namespace (BACKEND 7.9), so no
 * other agent can reach it. Before the platform wires a route to it, root asks the kernel's socket table of THAT namespace
 * (/proc/net/tcp*) who really holds the port; nothing the agent wrote (a port file, a claim in a tool call) is believed. Then root
 * writes the route into /etc/juno/spaces.json (root-only) and makes sure the gateway process (files/spaces/gateway.mjs, port 7090,
 * root, in the root namespace) and the namespace bridge are up. The bridge (`BRIDGE_PY`) is root too: for every route it listens on
 * the same port on root's loopback while the app is listening in the agent's namespace, and hands each connection over by entering
 * that namespace. The gateway therefore sees a root-owned loopback listener, which is why a route names uid 0. Root never reads or
 * runs anything the agent can write.
 */
import type { E2bBinding } from '@agent-desktop/contracts';
import { failed } from './errors.js';
import { ISOLATION_TMP, agentNetnsPath, agentUser, inAgentNetns } from './isolation-user.js';
import { runLocked } from './locked.js';
import type { ComputerProvider } from './provider.js';
import type { SandboxRuntime } from './runtime.js';
import { shq } from './shq.js';

/** The gateway's port inside every computer; reachable from outside (docker publish / E2B host), never from an agent (its namespace has no way to root's loopback). */
export const GATEWAY_PORT = 7090;
const GATEWAY_SCRIPT = '/opt/juno/spaces/gateway.mjs';
const GATEWAY_PID = '/run/juno/spaces-gateway.pid';
const GATEWAY_LOG = '/run/juno/spaces-gateway.log';
const BRIDGE_SCRIPT = '/run/juno/netns-bridge.py';
const BRIDGE_PID = '/run/juno/netns-bridge.pid';
const BRIDGE_LOG = '/run/juno/netns-bridge.log';
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

/** The listening sockets of one agent's namespace. */
async function agentSockets(root: SandboxRuntime, agentId: string): Promise<ListeningPort[]> {
  const result = await root.run(`${inAgentNetns(agentId)} sh -c ${shq(PROC_NET_TCP)}`, { timeoutMs: 15_000 });
  return parseListeners(result.stdout);
}

/** Every port in use anywhere in the computer: root's own and each agent's namespace (used to pick a free port for a new app). */
export async function listeningPorts(root: SandboxRuntime): Promise<ListeningPort[]> {
  const everywhere = `${PROC_NET_TCP}; for ns in /run/netns/*; do [ -e "$ns" ] && nsenter --net="$ns" sh -c ${shq(PROC_NET_TCP)}; done; true`;
  const result = await root.run(everywhere, { timeoutMs: 15_000 });
  return parseListeners(result.stdout);
}

const ROUTE_PY = [
  'import json,os,sys',
  'path,space,port,uid,netns=sys.argv[1],sys.argv[2],int(sys.argv[3]),int(sys.argv[4]),sys.argv[5]',
  'try:',
  '    routes=json.load(open(path)).get("routes",{})',
  'except Exception:',
  '    routes={}',
  // A port belongs to one space: a stale route that still names it is dropped.
  'routes={k:v for k,v in routes.items() if v.get("port")!=port or k==space}',
  'routes[space]={"port":port,"uid":uid,"netns":netns}',
  'tmp=path+".tmp"',
  'fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)',
  'os.write(fd,json.dumps({"routes":routes}).encode())',
  'os.close(fd)',
  'os.replace(tmp,path)',
].join('\n');

/**
 * The namespace bridge (root, root namespace). For every route with a `netns`, while that namespace has a listener on the route's port,
 * root's loopback listens on the same port; a connection is handed over by a thread that enters the namespace (`setns`) and dials
 * 127.0.0.1 there. When the app stops listening, the root-side listener goes away, so the gateway's own check ("is the port still held")
 * keeps meaning what it did: an app that exited, or one an agent replaced with another agent's listener (which lives in another
 * namespace), is not served. The routes file is re-read every half second.
 */
const BRIDGE_PY = [
  'import json,os,select,socket,sys,threading,time',
  'ROUTES="/etc/juno/spaces.json"; NEWNET=0x40000000',
  'def listening(ns,port):',
  '    found=[]',
  '    def look():',
  '        try:',
  '            fd=os.open(ns,os.O_RDONLY)',
  '        except OSError:',
  '            return',
  '        try:',
  '            os.setns(fd,NEWNET)',
  '            for name in ("tcp","tcp6"):',
  '                try:',
  '                    rows=open("/proc/thread-self/net/"+name).read().split("\\n")[1:]',
  '                except OSError:',
  '                    continue',
  '                for row in rows:',
  '                    c=row.split()',
  '                    if len(c)>3 and c[3]=="0A" and int(c[1].rsplit(":",1)[1],16)==port:',
  '                        found.append(1)',
  '        except OSError:',
  '            pass',
  '        finally:',
  '            os.close(fd)',
  '    t=threading.Thread(target=look); t.start(); t.join()',
  '    return bool(found)',
  'def pump(a,b):',
  '    open_=[a,b]',
  '    try:',
  '        while open_:',
  '            ready,_,_=select.select(open_,[],[],30)',
  '            for s in ready:',
  '                data=s.recv(65536)',
  '                other=b if s is a else a',
  '                if not data:',
  '                    open_.remove(s)',
  '                    try:',
  '                        other.shutdown(socket.SHUT_WR)',
  '                    except OSError:',
  '                        pass',
  '                else:',
  '                    other.sendall(data)',
  '    except OSError:',
  '        pass',
  '    finally:',
  '        a.close(); b.close()',
  'def hand_over(client,ns,port):',
  '    try:',
  '        fd=os.open(ns,os.O_RDONLY)',
  '        os.setns(fd,NEWNET)',
  '        os.close(fd)',
  '        upstream=socket.create_connection(("127.0.0.1",port),5)',
  '    except OSError:',
  '        client.close(); return',
  '    pump(client,upstream)',
  'def accept_loop(server,ns,port):',
  '    while True:',
  '        try:',
  '            client,_=server.accept()',
  '        except OSError:',
  '            return',
  '        threading.Thread(target=hand_over,args=(client,ns,port),daemon=True).start()',
  'open(os.environ.get("JUNO_BRIDGE_PIDFILE","/run/juno/netns-bridge.pid"),"w").write(str(os.getpid()))',
  'servers={}',
  'while True:',
  '    try:',
  '        routes=json.load(open(ROUTES)).get("routes",{})',
  '    except Exception:',
  '        routes={}',
  '    want={}',
  '    for r in routes.values():',
  '        if isinstance(r.get("netns"),str) and isinstance(r.get("port"),int) and listening(r["netns"],r["port"]):',
  '            want[r["port"]]=r["netns"]',
  '    for port in list(servers):',
  '        if want.get(port)!=servers[port][0]:',
  '            s=servers.pop(port)[1]',
  // close() alone leaves a socket that another thread is blocked in accept() on listening; shutdown wakes that thread and ends it.
  '            try:',
  '                s.shutdown(socket.SHUT_RDWR)',
  '            except OSError:',
  '                pass',
  '            s.close()',
  '    for port,ns in want.items():',
  '        if port in servers:',
  '            continue',
  '        s=socket.socket()',
  '        s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)',
  '        try:',
  '            s.bind(("127.0.0.1",port)); s.listen(64)',
  '        except OSError:',
  '            s.close(); continue',
  '        servers[port]=(ns,s)',
  '        threading.Thread(target=accept_loop,args=(s,ns,port),daemon=True).start()',
  '    time.sleep(0.5)',
].join('\n');

/** Start the gateway and the bridge if they are not running (idempotent, root). Their pid files live in the root-only /run/juno. */
export async function ensureGateway(root: SandboxRuntime, gatewayKey: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(gatewayKey)) throw failed('invalid gateway key');
  // The key travels through a root-only scratch file, never a command line, and is rewritten on every ensure.
  const scratch = `${ISOLATION_TMP}/gateway-key-${gatewayKey.slice(0, 8)}`;
  await root.run(`mkdir -p ${ISOLATION_TMP} /run/juno && chmod 0700 ${ISOLATION_TMP} /run/juno`, { timeoutMs: 15_000 });
  await root.writeText(scratch, gatewayKey);
  const installed = await root.run(`install -m 0600 -o root -g root ${scratch} ${GATEWAY_KEY_FILE}; status=$?; rm -f ${scratch}; exit $status`, { timeoutMs: 15_000 });
  if (installed.exitCode !== 0) throw failed(`could not install the gateway key: ${(installed.stderr || installed.stdout).trim().slice(0, 300)}`);
  await root.writeText(BRIDGE_SCRIPT, BRIDGE_PY);
  const health = `curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:${GATEWAY_PORT}/__health`;
  const script = [
    'set -e',
    `{ command -v bun >/dev/null 2>&1 && [ -f ${GATEWAY_SCRIPT} ]; } || { echo "this computer's image has no Bun or no Spaces gateway: rebuild the image" >&2; exit 1; }`,
    'mkdir -p /run/juno /etc/juno && chmod 0700 /run/juno',
    // The bridge is a process of this boot: a pid file from an earlier boot names no live bridge.
    `if ! { [ -f ${BRIDGE_PID} ] && kill -0 "$(cat ${BRIDGE_PID})" 2>/dev/null && grep -q netns-bridge "/proc/$(cat ${BRIDGE_PID})/cmdline" 2>/dev/null; }; then`,
    `  JUNO_BRIDGE_PIDFILE=${BRIDGE_PID} setsid nohup python3 ${BRIDGE_SCRIPT} >>${BRIDGE_LOG} 2>&1 </dev/null &`,
    'fi',
    `if ${health} 2>/dev/null; then exit 0; fi`,
    `JUNO_SPACES_PIDFILE=${GATEWAY_PID} setsid nohup bun ${GATEWAY_SCRIPT} >>${GATEWAY_LOG} 2>&1 </dev/null &`,
    `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25; do ${health} 2>/dev/null && exit 0; sleep 0.2; done`,
    `echo "the Spaces gateway did not start: $(tail -n 5 ${GATEWAY_LOG} 2>/dev/null)" >&2; exit 1`,
  ].join('\n');
  // Not under the isolation lock: the gateway would inherit the lock's file descriptor and hold it for good.
  const result = await root.run(script, { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw failed(`could not start the Spaces gateway: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
}

/** Wait until root's loopback listens on the app's port (the bridge opens it within half a second of the app listening). */
async function waitForBridge(root: SandboxRuntime, port: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await root.run(PROC_NET_TCP, { timeoutMs: 15_000 });
    if (parseListeners(result.stdout).some((socket) => socket.port === port && socket.uid === 0)) return;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw failed(`the app on port ${port} could not be bridged to the gateway`);
}

/**
 * Wire one app: verify the listener (as the kernel sees it, inside the agent's namespace), write its route, make sure the gateway and
 * the bridge run. Throws a plain `failed` with the reason the agent should act on.
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
  const problem = listenerProblem(input.port, (await agentSockets(root, input.agentId)).filter((socket) => socket.port === input.port), agentUid);
  if (problem !== undefined) throw failed(problem);
  const script = [
    'set -e',
    'mkdir -p /etc/juno',
    // The gateway checks the listener it dials: the bridge, root's (uid 0).
    `python3 -c ${shq(ROUTE_PY)} ${SPACES_FILE} ${input.spaceId} ${input.port} 0 ${agentNetnsPath(input.agentId)}`,
    `chmod 0600 ${SPACES_FILE}`,
  ].join('\n');
  await runLocked(root, script, 'wire the app');
  await ensureGateway(root, input.gatewayKey);
  await waitForBridge(root, input.port);
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
