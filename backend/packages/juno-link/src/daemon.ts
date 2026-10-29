/**
 * juno-link: the daemon inside every computer (BACKEND §7.11). It runs as root from boot, dials OUT to computerd over a
 * WebSocket and serves what computerd asks over that one connection: shell commands, files, and byte streams to a few
 * loopback ports. The computer needs no inbound port; reconnects use exponential backoff.
 *
 * Everything here is written for Bun's `--compile` (no dependencies; the platform WebSocket) and runs unchanged under
 * Node, which is how the unit tests drive it. The token only travels in the first frame (`HELLO`), over TLS in production.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { connect as tcpConnect, type Socket } from 'node:net';
import { arch, homedir, release, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  CLOSE_BAD_DECLARATION,
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  Credit,
  FrameType,
  HIGH_WATER,
  MAX_CHUNK,
  MAX_FILE_BYTES,
  MAX_FRAME,
  PROTOCOL_VERSION,
  SILENCE_MS,
  STREAM_WINDOW,
  chunks,
  decodeFrame,
  encodeFrame,
  jsonFrame,
  isDesktopAction,
  parseControlBody,
  parseJson,
  readWindow,
  streamPortAllowed,
  windowFrame,
  type ControlBody,
  type DesktopRequest,
  type DeviceDeclaration,
  type ExecParams,
  type Frame,
  type HealthResult,
  type HelloBody,
  type HostInfo,
  type ReadFileParams,
  type RpcError,
  type RpcErrorCode,
  type WriteFileParams,
} from './protocol.js';
import { CUA_ACTIONS, runCuaDesktop, type CuaClient } from './cua.js';

export interface LinkConfig {
  /** `wss://computerd.example/v1/computer-link`, or `ws://host.docker.internal:8795/...` for local Docker. */
  url: string;
  id: string;
  token: string;
}

export interface DaemonOptions {
  /** Read afresh before every connection attempt; undefined means "not configured yet, keep waiting". */
  loadConfig(): LinkConfig | undefined;
  /** Where exec programs are written (root-only). */
  scratchDir?: string;
  shell?: string;
  allowPort?: (port: number) => boolean;
  /** Environment of the commands it runs. */
  childEnv?: NodeJS.ProcessEnv;
  backoff?: { minMs: number; maxMs: number };
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /**
   * A machine that is not a throwaway computer (someone's Mac) limits what the platform may touch: commands start in
   * (and `cwd` must be inside) one of these directories, and files are read and written only inside them. The first one is
   * the default working directory. Symlinks are resolved first, so a link inside a root cannot lead out of it.
   */
  roots?: string[];
  /** The link's state as the user would name it; `unauthorized` means the platform no longer accepts this token. */
  onStatus?: (status: LinkStatus) => void;
  /** Called whenever a command starts or ends, or the user stops/resumes the link. */
  onActivity?: (activity: LinkActivity) => void;
  /**
   * Optional desktop host RPC (a Mac that joined as a computer serves screen/input/audio through this; throwaway
   * computers leave it absent and the hub refuses desktop work with an update-needed message). The request input
   * is untrusted agent data passed through opaquely: `permissions` is an owner-only action with no
   * public agent path (the composition layer strips prompt-request fields and denies remote use), so this handler
   * must never prompt from any input field (including `request`); prompts happen only through owner IPC.
   * No Electron here: the host wires its own helper into this callback. It serves `browser`, `audio_*`, `permissions` and
   * `mac_apps`; `snapshot`, `act` and `verify` are the daemon's own, through `cua`.
   */
  desktop?: {
    handle(request: DesktopRequest, signal: AbortSignal): Promise<unknown>;
    /** Stop background work (e.g. audio recording); called on pause, daemon stop and disconnect. */
    stop?(): void;
  };
  /**
   * cua-driver for this Mac: the desktop app starts `cua-driver serve --embedded --socket <private path>` and passes
   * `createCuaCliClient({ socketPath })` (or its own client). Present = the daemon answers `snapshot`, `act` and `verify`
   * itself; Stop aborts the call in flight.
   */
  cua?: CuaClient;
  /**
   * What this device can do right now, read afresh at every connection (in the first frame) and again on `redeclare()`.
   * A Mac must supply it (the hub refuses a Mac's HELLO without one); only actions the user has actually granted belong in it.
   */
  device?(): DeviceDeclaration;
}

export type LinkStatus = 'connecting' | 'online' | 'offline' | 'unauthorized';

export interface LinkActivity {
  /** Commands running right now. */
  running: number;
  /** The newest running command's first line, for a menu to show. */
  command?: string;
  /** The user pressed Stop: new work is refused until `resume()`. */
  stopped: boolean;
}

export interface LinkDaemon {
  readonly bootId: string;
  /** The user's Stop: cancels every running command and refuses new work until `resume()`. */
  pause(): void;
  resume(): void;
  activity(): LinkActivity;
  /** Tell the hub the device's capabilities changed (a permission was granted or revoked); no-op while offline, the next connection declares afresh. */
  redeclare(): void;
  stop(): void;
}

export const STOPPED_MESSAGE = 'The user pressed Stop on this computer: the command was cancelled and nothing runs until they resume it.';

const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DESKTOP_MISSING_MESSAGE =
  'this computer needs an update before it can share its screen: the desktop helper is not installed (no desktop handler)';
/** Largest desktop result the frame bound accepts (header included); oversized results fail truthfully. */
const MAX_DESKTOP_RESULT_BYTES = MAX_FRAME - 5;

const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const KILL_GRACE_MS = 5_000;
const PIPE_GRACE_MS = 2_000;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 10_000;
const WATCHDOG_MS = 5_000;
const FLUSH_GRACE_MS = 3_000;

class RpcFailure extends Error {
  constructor(readonly code: RpcErrorCode, message: string) {
    super(message);
  }
}

// Not unref'd: between reconnect attempts this timer is the only thing keeping the daemon (PID 1 of the computer) alive;
// unref'd, a failed attempt while computerd restarts emptied the event loop, the process exited 0 and the computer stopped.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function startLinkDaemon(options: DaemonOptions): LinkDaemon {
  const bootId = randomUUID();
  const startedAt = Date.now();
  const log = options.log ?? (() => undefined);
  const scratch = options.scratchDir ?? '/run/juno-link';
  const shell = options.shell ?? '/bin/sh';
  const allowPort = options.allowPort ?? streamPortAllowed;
  const backoff = options.backoff ?? { minMs: 1_000, maxMs: 30_000 };
  const baseEnv = scrubbedEnv(options.childEnv ?? process.env);
  const roots = (options.roots ?? []).map((root) => resolve(root));
  const host: HostInfo = {
    platform: process.platform,
    arch: arch(),
    release: release(),
    user: userInfo().username,
    home: homedir(),
    ...(roots.length === 0 ? {} : { roots }),
    ...(options.desktop === undefined && options.cua === undefined ? {} : { desktop: true }),
  };
  let stopped = false;
  let userStopped = false;
  let current: WebSocket | undefined;
  /** Every running command or desktop operation of every connection, newest last: what Stop cancels and what the menu shows. */
  const running = new Map<AbortController, string>();
  const activity = (): LinkActivity => {
    const last = [...running.values()].pop();
    return { running: running.size, ...(last === undefined ? {} : { command: last }), stopped: userStopped };
  };
  const announce = () => options.onActivity?.(activity());
  const needAlive = () => {
    if (userStopped) throw new RpcFailure('stopped', STOPPED_MESSAGE);
  };
  /** A change the person made here that the hub has not heard (made while offline); sent first thing on the next connection. */
  let unsent: ControlBody | undefined;
  const sendControl = (body: ControlBody): boolean => {
    if (current?.readyState !== WebSocket.OPEN) return false;
    current.send(jsonFrame(FrameType.CONTROL, 0, body));
    return true;
  };
  /** Enter Stop: cancel everything running (what was cancelled is the first line of each), refuse new work. */
  const enterStop = (): string[] => {
    const cancelled = [...running.values()];
    userStopped = true;
    for (const ticket of [...running.keys()]) ticket.abort();
    stopDesktopBackground();
    announce();
    return cancelled;
  };
  const stopDesktopBackground = () => {
    try {
      options.desktop?.stop?.();
    } catch {
      // stopping background work must never break pause/disconnect
    }
  };
  /** The path itself, or its nearest existing ancestor, resolved through symlinks, must sit in a root. */
  async function inRoots(path: string): Promise<string> {
    if (roots.length === 0) return path;
    const absolute = isAbsolute(path) ? resolve(path) : resolve(roots[0] ?? '/', path);
    let probe = absolute;
    let tail = '';
    for (;;) {
      try {
        const real = join(await realpath(probe), tail);
        if (roots.some((root) => real === root || real.startsWith(root + sep))) return absolute;
        break;
      } catch {
        const parent = dirname(probe);
        if (parent === probe) break;
        tail = join(probe.slice(parent.length + 1), tail);
        probe = parent;
      }
    }
    throw new RpcFailure('denied', `${path} is outside the folders this computer allows (${roots.join(', ')})`);
  }

  /** One connection. Resolves when it closes: whether the hub spoke to us (so the backoff may reset) and whether another daemon took the link over. */
  function session(config: LinkConfig): Promise<{ heard: boolean; replaced: boolean; unauthorized: boolean }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(config.url);
      ws.binaryType = 'arraybuffer';
      current = ws;
      let heardAt = 0;
      let heard = false;
      /** The unsent control change this connection sent right after its HELLO. */
      let flushed: ControlBody | undefined;
      let flushedAt = 0;
      const requests = new Map<number, AbortController>();
      const writes = new Map<number, WriteState>();
      const streams = new Map<number, StreamState>();
      const connectTimer = setTimeout(() => ws.close(), CONNECT_TIMEOUT_MS);
      let watchdog: ReturnType<typeof setInterval> | undefined;

      const send = (frame: Uint8Array) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame);
      };
      /** Wait while the socket's send buffer is full. */
      const drained = async () => {
        while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > HIGH_WATER) await sleep(5);
      };
      const reply = (channel: number, body: unknown) => send(jsonFrame(FrameType.RESULT, channel, body));
      const fail = (channel: number, error: unknown) => reply(channel, { error: toRpcError(error) });

      ws.addEventListener('open', () => {
        clearTimeout(connectTimer);
        heardAt = Date.now();
        const device = options.device?.();
        const hello: HelloBody = { version: PROTOCOL_VERSION, id: config.id, token: config.token, bootId, ...(device === undefined ? {} : { device }) };
        send(jsonFrame(FrameType.HELLO, 0, hello));
        // Stop or resume pressed while offline: the hub hears it before anything it may push about the same thing.
        // It stays `unsent` until the hub answers (it was accepted), so a refused or dropped connection does not lose it.
        if (unsent !== undefined) {
          flushed = unsent;
          flushedAt = Date.now();
          send(jsonFrame(FrameType.CONTROL, 0, unsent));
        }
        // A long gap between two ticks means the whole machine was frozen (a suspended VM resumed): its socket is not to be trusted.
        let tickedAt = Date.now();
        watchdog = setInterval(() => {
          const now = Date.now();
          const frozen = now - tickedAt > 3 * WATCHDOG_MS;
          tickedAt = now;
          if (frozen || now - heardAt > SILENCE_MS) ws.close();
        }, WATCHDOG_MS);
        watchdog.unref?.();
      });

      ws.addEventListener('message', (event) => {
        heardAt = Date.now();
        if (!heard) options.onStatus?.('online');
        heard = true;
        if (flushed !== undefined && unsent === flushed) unsent = undefined;
        let frame: Frame;
        try {
          frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
        } catch (error) {
          log('bad frame; dropping the link', { error: String(error) });
          ws.close();
          return;
        }
        void handle(frame).catch((error: unknown) => log('frame handler failed', { error: String(error) }));
      });

      async function handle(frame: Frame): Promise<void> {
        const { channel } = frame;
        switch (frame.type) {
          case FrameType.PING:
            return send(encodeFrame(FrameType.PONG, 0));
          case FrameType.RPC: {
            const controller = new AbortController();
            requests.set(channel, controller);
            try {
              await rpc(channel, parseJson(frame.payload), controller.signal);
            } catch (error) {
              fail(channel, error);
            } finally {
              requests.delete(channel);
            }
            return;
          }
          case FrameType.CANCEL:
            return void requests.get(channel)?.abort();
          case FrameType.CONTROL: {
            // Stop pressed on another client: do exactly what the local button does and tell the hub what it cancelled. A hub never resumes a Mac.
            const body = parseControlBody(parseJson(frame.payload));
            // (A push right after this connection announced its own change is the hub answering from before it heard that change.)
            if (body?.holder !== 'stopped' || userStopped || unsent !== undefined || (flushed !== undefined && Date.now() - flushedAt < FLUSH_GRACE_MS)) return;
            sendControl({ holder: 'stopped', cancelled: enterStop() });
            return;
          }
          case FrameType.DATA: {
            const write = writes.get(channel);
            if (write) write.queue = write.queue.then(() => write.append(frame.payload));
            else streams.get(channel)?.fromHub(frame.payload);
            return;
          }
          case FrameType.OPEN:
            return openStream(channel, parseJson(frame.payload));
          case FrameType.WINDOW:
            return streams.get(channel)?.credit.give(readWindow(frame.payload));
          case FrameType.END:
            streams.get(channel)?.socket.end();
            return;
          case FrameType.CLOSE:
            streams.get(channel)?.socket.destroy();
            return;
          default:
            return;
        }
      }

      async function rpc(channel: number, request: unknown, signal: AbortSignal): Promise<void> {
        const call = asRecord(request);
        const params = asRecord(call?.['params'] ?? {});
        if (call === undefined || params === undefined) throw new RpcFailure('bad_request', 'malformed request');
        switch (call['method']) {
          case 'health': {
            const health: HealthResult = { ok: true, bootId, version: PROTOCOL_VERSION, uptimeMs: Date.now() - startedAt, host };
            return reply(channel, { result: health });
          }
          case 'exec':
            needAlive();
            return reply(channel, { result: await exec(channel, params as unknown as ExecParams, signal) });
          case 'readFile':
            needAlive();
            return reply(channel, { result: await readFile(channel, params as unknown as ReadFileParams) });
          case 'writeFile':
            needAlive();
            return reply(channel, { result: await writeFileRpc(channel, params as unknown as WriteFileParams) });
          case 'desktop':
            needAlive();
            return reply(channel, { result: await desktopRpc(params, signal) });
          default:
            throw new RpcFailure('bad_request', `unknown method ${String(call['method'])}`);
        }
      }

      /**
       * One desktop operation through the host's handler. The raw record is parsed here: a bounded agent id,
       * an exact allowed action via the protocol type guard, and an object input via asRecord; nothing else
       * reaches the handler, and there is no method/eval passthrough (the input is data the handler
       * interprets). Tracked in `running` so Stop and disconnect cancel it, and the menu shows it while it runs.
       *
       * Owner-only semantics: `permissions` has no public agent path — the composition layer
       * strips prompt-request fields and denies remote use before it reaches the host. The input below is
       * untrusted agent data: the handler must never prompt from any input field (including `request`);
       * prompts happen only through owner IPC.
       */
      async function desktopRpc(params: unknown, signal: AbortSignal) {
        const body = asRecord(params);
        const agentId = body?.['agentId'];
        const action = body?.['action'];
        const input = body === undefined ? undefined : asRecord(body['input']);
        if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) throw new RpcFailure('bad_request', 'desktop needs an agentId');
        if (!isDesktopAction(action)) throw new RpcFailure('bad_request', `unknown desktop action ${String(action)}`);
        if (input === undefined) throw new RpcFailure('bad_request', 'desktop needs an object input');
        const cua = CUA_ACTIONS.has(action) ? options.cua : undefined;
        const desktop = options.desktop;
        if (CUA_ACTIONS.has(action) ? cua === undefined : desktop === undefined) throw new RpcFailure('denied', DESKTOP_MISSING_MESSAGE);
        const ticket = new AbortController();
        const linked = new AbortController();
        const onAbort = () => linked.abort();
        ticket.signal.addEventListener('abort', onAbort, { once: true });
        signal.addEventListener('abort', onAbort, { once: true });
        running.set(ticket, `desktop ${action}`);
        announce();
        try {
          const request: DesktopRequest = { agentId, action, input };
          const result = cua === undefined ? await desktop?.handle(request, linked.signal) : await runCuaDesktop(cua, request, linked.signal);
          if (userStopped && ticket.signal.aborted) throw new RpcFailure('stopped', STOPPED_MESSAGE);
          if (linked.signal.aborted) throw new RpcFailure('cancelled', 'the desktop operation was cancelled');
          const encoded = new TextEncoder().encode(JSON.stringify({ result }));
          if (encoded.length + 5 > MAX_FRAME) {
            throw new RpcFailure('too_large', `the desktop result is ${encoded.length} bytes; the limit is ${MAX_DESKTOP_RESULT_BYTES}`);
          }
          return result;
        } catch (error) {
          if (error instanceof RpcFailure) throw error;
          if (userStopped && ticket.signal.aborted) throw new RpcFailure('stopped', STOPPED_MESSAGE);
          if (linked.signal.aborted) throw new RpcFailure('cancelled', 'the desktop operation was cancelled');
          throw error;
        } finally {
          signal.removeEventListener('abort', onAbort);
          ticket.signal.removeEventListener('abort', onAbort);
          if (running.delete(ticket)) announce();
        }
      }

      /** A program as root: written to a 0600 file in a 0700 directory and run by the shell, so it never shows in argv. */
      async function exec(channel: number, params: ExecParams, signal: AbortSignal) {
        if (typeof params.command !== 'string') throw new RpcFailure('bad_request', 'exec needs a command');
        const cwd = await inRoots(typeof params.cwd === 'string' && params.cwd !== '' ? params.cwd : roots[0] ?? '/');
        if (!existsSync(cwd)) throw new RpcFailure('not_found', `working directory ${cwd} does not exist`);
        const timeoutMs = Number.isFinite(params.timeoutMs) && (params.timeoutMs ?? 0) > 0 ? Number(params.timeoutMs) : DEFAULT_EXEC_TIMEOUT_MS;
        const env: NodeJS.ProcessEnv = { ...baseEnv };
        for (const [name, value] of Object.entries(params.envs ?? {})) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === 'string') env[name] = value;
        await mkdir(scratch, { recursive: true, mode: 0o700 });
        const file = join(scratch, `exec-${randomUUID()}.sh`);
        await writeFile(file, params.command, { mode: 0o600 });
        const ticket = new AbortController();
        try {
          const child = spawn(shell, [file], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
          running.set(ticket, params.command.trim().split('\n')[0]?.slice(0, 200) ?? '');
          announce();
          let timedOut = false;
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          const killGroup = (signalName: NodeJS.Signals) => {
            try {
              if (child.pid !== undefined) process.kill(-child.pid, signalName);
            } catch {
              // already gone
            }
          };
          const stop = (why: 'timeout' | 'cancel') => {
            if (why === 'timeout') timedOut = true;
            killGroup('SIGTERM');
            killTimer ??= setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
          };
          ticket.signal.addEventListener('abort', () => stop('cancel'), { once: true });
          const timer = setTimeout(() => stop('timeout'), timeoutMs);
          const onAbort = () => stop('cancel');
          signal.addEventListener('abort', onAbort, { once: true });
          const spawned = new Promise<void>((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
          });
          await spawned;
          const pump = async (stream: NodeJS.ReadableStream, fd: number) => {
            for await (const piece of stream) {
              const bytes = piece instanceof Uint8Array ? piece : new TextEncoder().encode(String(piece));
              for (const part of chunks(bytes)) {
                const payload = new Uint8Array(part.length + 1);
                payload[0] = fd;
                payload.set(part, 1);
                await drained();
                send(encodeFrame(FrameType.DATA, channel, payload));
              }
            }
          };
          const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, sig) => resolve({ code, signal: sig })));
          const pipes = Promise.all([pump(child.stdout, 1), pump(child.stderr, 2)]).catch(() => undefined);
          const { code, signal: killedBy } = await exited;
          await Promise.race([pipes, sleep(PIPE_GRACE_MS)]);
          child.stdout.destroy();
          child.stderr.destroy();
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          signal.removeEventListener('abort', onAbort);
          if (userStopped && ticket.signal.aborted) throw new RpcFailure('stopped', STOPPED_MESSAGE);
          if (signal.aborted && !timedOut) throw new RpcFailure('cancelled', 'the command was cancelled');
          const exitCode = timedOut ? 124 : code ?? 128 + (killedBy === 'SIGKILL' ? 9 : killedBy === 'SIGTERM' ? 15 : 1);
          return { exitCode, timedOut };
        } finally {
          if (running.delete(ticket)) announce();
          await rm(file, { force: true });
        }
      }

      async function readFile(channel: number, params: ReadFileParams) {
        if (typeof params.path !== 'string' || params.path === '') throw new RpcFailure('bad_request', 'readFile needs a path');
        const limit = Math.min(params.maxBytes ?? MAX_FILE_BYTES, MAX_FILE_BYTES);
        const path = await inRoots(params.path);
        const handle = await open(path, constants.O_RDONLY).catch((error: unknown) => {
          throw ioFailure(error, params.path);
        });
        try {
          const size = (await handle.stat()).size;
          if (size > limit) throw new RpcFailure('too_large', `${params.path} is ${size} bytes; the limit is ${limit}`);
          const buffer = new Uint8Array(MAX_CHUNK);
          for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, MAX_CHUNK, null);
            if (bytesRead === 0) break;
            await drained();
            send(encodeFrame(FrameType.DATA, channel, buffer.slice(0, bytesRead)));
          }
          return { size };
        } finally {
          await handle.close();
        }
      }

      async function writeFileRpc(channel: number, params: WriteFileParams) {
        if (typeof params.path !== 'string' || params.path === '' || !Number.isInteger(params.size) || params.size < 0 || params.size > MAX_FILE_BYTES) {
          throw new RpcFailure('bad_request', 'writeFile needs a path and a size');
        }
        // The state must exist before the first await: the file's bytes follow the request at once.
        const state = createWrite(params, inRoots(params.path));
        writes.set(channel, state);
        try {
          return await state.done;
        } finally {
          writes.delete(channel);
        }
      }

      /** Bytes arrive as DATA frames after the request; `done` settles once `size` of them are on disk. */
      function createWrite(params: WriteFileParams, target: Promise<string>): WriteState {
        let finish: (value: { size: number }) => void = () => undefined;
        let fail: (error: unknown) => void = () => undefined;
        const done = new Promise<{ size: number }>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
        done.catch(() => undefined);
        const opened = (async () => {
          const path = await target;
          await mkdir(dirname(path), { recursive: true });
          return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, params.mode ?? 0o644);
        })();
        let written = 0;
        const settle = async (error?: unknown) => {
          const handle = await opened.catch(() => undefined);
          await handle?.close().catch(() => undefined);
          if (error === undefined) finish({ size: written });
          else fail(ioFailure(error, params.path));
        };
        const state: WriteState = {
          done,
          queue: opened.then(() => undefined, (error: unknown) => settle(error)),
          async append(payload) {
            try {
              await (await opened).write(payload);
              written += payload.length;
              if (written >= params.size) await settle();
            } catch (error) {
              await settle(error);
            }
          },
          abort: () => settle(new Error('the link closed before the file was complete')),
        };
        if (params.size === 0) void opened.then(() => settle(), () => undefined);
        return state;
      }

      function openStream(channel: number, request: unknown): void {
        const port = asRecord(request)?.['port'];
        if (typeof port !== 'number' || !allowPort(port)) {
          return send(encodeFrame(FrameType.CLOSE, channel, new TextEncoder().encode('port is not allowed')));
        }
        const socket = tcpConnect({ host: '127.0.0.1', port, allowHalfOpen: true });
        const state: StreamState = {
          socket,
          credit: new Credit(STREAM_WINDOW),
          fromHub(payload) {
            const flushed = socket.write(payload);
            if (flushed) send(windowFrame(channel, payload.length));
            else socket.once('drain', () => send(windowFrame(channel, payload.length)));
          },
        };
        streams.set(channel, state);
        socket.once('connect', () => {
          send(encodeFrame(FrameType.OPENED, channel));
          void forward(channel, socket, state.credit);
        });
        socket.once('error', (error) => {
          send(encodeFrame(FrameType.CLOSE, channel, new TextEncoder().encode(error.message)));
          socket.destroy();
        });
        socket.once('close', () => {
          state.credit.close();
          streams.delete(channel);
          send(encodeFrame(FrameType.CLOSE, channel));
        });
      }

      /** Socket -> hub, one chunk at a time, only as much as the hub has granted. */
      async function forward(channel: number, socket: Socket, credit: Credit): Promise<void> {
        try {
          for await (const piece of socket) {
            const bytes = piece as Uint8Array;
            for (let at = 0; at < bytes.length; ) {
              const n = await credit.take(Math.min(MAX_CHUNK, bytes.length - at));
              if (n === 0) return;
              await drained();
              send(encodeFrame(FrameType.DATA, channel, bytes.subarray(at, at + n)));
              at += n;
            }
          }
          send(encodeFrame(FrameType.END, channel));
        } catch {
          // the socket closed; its close handler tells the hub
        }
      }

      ws.addEventListener('close', (event) => {
        clearTimeout(connectTimer);
        if (watchdog) clearInterval(watchdog);
        for (const controller of requests.values()) controller.abort();
        for (const stream of streams.values()) stream.socket.destroy();
        for (const write of writes.values()) void write.abort();
        stopDesktopBackground();
        if (current === ws) current = undefined;
        if (event.code === CLOSE_BAD_DECLARATION) log('the hub refused this device: its declaration is missing or invalid; update the app', { reason: event.reason });
        resolve({ heard, replaced: event.code === CLOSE_REPLACED, unauthorized: event.code === CLOSE_UNAUTHORIZED });
      });
      ws.addEventListener('error', () => ws.close());
    });
  }

  void (async () => {
    let delay = backoff.minMs;
    while (!stopped) {
      const config = options.loadConfig();
      if (config === undefined) {
        await sleep(1_000);
        continue;
      }
      let outcome = { heard: false, replaced: false, unauthorized: false };
      options.onStatus?.('connecting');
      try {
        outcome = await session(config);
      } catch (error) {
        log('link attempt failed', { error: String(error) });
      }
      if (stopped) break;
      options.onStatus?.(outcome.unauthorized ? 'unauthorized' : 'offline');
      // Replaced by a newer connection of this computer: if that is another daemon, do not fight it at full speed.
      delay = outcome.replaced ? backoff.maxMs : outcome.heard ? backoff.minMs : Math.min(backoff.maxMs, delay * 2);
      await sleep(delay * (0.75 + Math.random() * 0.5));
    }
  })();

  return {
    bootId,
    pause() {
      if (userStopped) return;
      const body: ControlBody = { holder: 'stopped', cancelled: enterStop() };
      if (!sendControl(body)) unsent = body;
    },
    resume() {
      if (!userStopped) return;
      userStopped = false;
      announce();
      const body: ControlBody = { holder: 'agent' };
      if (!sendControl(body)) unsent = body;
    },
    activity,
    redeclare() {
      const device = options.device?.();
      if (device !== undefined && current?.readyState === WebSocket.OPEN) current.send(jsonFrame(FrameType.DECLARE, 0, device));
    },
    stop() {
      stopped = true;
      stopDesktopBackground();
      current?.close();
    },
  };
}

interface WriteState {
  done: Promise<{ size: number }>;
  queue: Promise<unknown>;
  append(payload: Uint8Array): Promise<void>;
  abort(): Promise<void>;
}

interface StreamState {
  socket: Socket;
  credit: Credit;
  fromHub(payload: Uint8Array): void;
}

function scrubbedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) if (!name.startsWith('JUNO_LINK_') && value !== undefined) env[name] = value;
  env['PATH'] ??= DEFAULT_PATH;
  return env;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function ioFailure(error: unknown, path: string): RpcFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (error instanceof RpcFailure) return error;
  if (code === 'ENOENT') return new RpcFailure('not_found', `${path}: no such file or directory`);
  if (code === 'EACCES' || code === 'EPERM') return new RpcFailure('denied', `${path}: permission denied`);
  return new RpcFailure('io', `${path}: ${error instanceof Error ? error.message : String(error)}`);
}

function toRpcError(error: unknown): RpcError {
  if (error instanceof RpcFailure) return { code: error.code, message: error.message };
  if (typeof error === 'object' && error !== null && 'code' in error) return { code: 'internal', message: error instanceof Error ? error.message : String(error) };
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) };
}
