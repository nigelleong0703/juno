/**
 * The wire format of the computer link (BACKEND §7.11), shared by the in-computer daemon (`daemon.ts`, compiled with
 * `bun build --compile`) and computerd's hub. One WebSocket per computer carries binary frames
 *
 *     [type u8][channel u32 big-endian][payload]
 *
 * The daemon dials out; computerd is the only side that makes requests:
 *  - control: `RPC` (JSON `{method, params}`) on a fresh channel id, answered by one `RESULT` (JSON `{result}` or
 *    `{error}`). `exec` and `readFile` stream `DATA` frames on the request's channel before their result, `writeFile`
 *    receives them after the request; `CANCEL` aborts a running request.
 *  - streams: `OPEN {port}` asks the daemon to connect to 127.0.0.1:<port> (whitelisted ports only), then `DATA` both
 *    ways. Each direction has a credit window (`WINDOW` frames) so a slow reader never makes the other side buffer
 *    without bound. `END` is a half-close, `CLOSE` tears the stream down.
 *
 * Frames are bounded: a data frame carries at most MAX_CHUNK bytes and no frame exceeds MAX_FRAME.
 */

export const PROTOCOL_VERSION = 1;
/** Payload bytes of one DATA frame. */
export const MAX_CHUNK = 32 * 1024;
/** Largest frame (header included) either side accepts; JSON frames (an `exec` program) are the big ones. */
export const MAX_FRAME = 1024 * 1024;
/** Bytes a sender may have unacknowledged on one stream. */
export const STREAM_WINDOW = 256 * 1024;
/** Socket send buffer above which a sender waits (WebSocket `bufferedAmount`). */
export const HIGH_WATER = 1024 * 1024;
/** Largest file `readFile` returns in one call. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const PING_INTERVAL_MS = 15_000;
/** The daemon reconnects when it has heard nothing (no ping) for this long. */
export const SILENCE_MS = 50_000;
/** Close code for a failed HELLO. */
export const CLOSE_UNAUTHORIZED = 4401;
/** Close code for a link replaced by a newer connection of the same computer. */
export const CLOSE_REPLACED = 4409;
/** Close code for a missing or invalid device declaration (a Mac must say what it can do; see `DeviceDeclaration`). */
export const CLOSE_BAD_DECLARATION = 4426;

export const FrameType = {
  /** daemon -> hub, first frame: `HelloBody`. */
  HELLO: 1,
  /** hub -> daemon: JSON `RpcRequest`; channel = request id. */
  RPC: 2,
  /** daemon -> hub: JSON `{result}` or `{error}`; channel = request id. */
  RESULT: 3,
  /** Stream bytes; for `exec` the first payload byte is the fd (1 stdout, 2 stderr). */
  DATA: 4,
  /** hub -> daemon: JSON `{port}`. */
  OPEN: 5,
  OPENED: 6,
  /** Half-close: the sender will write no more. */
  END: 7,
  /** Teardown; payload is an optional UTF-8 reason. */
  CLOSE: 8,
  /** Credit: payload is a u32 byte count. */
  WINDOW: 9,
  /** hub -> daemon: abort the request on this channel. */
  CANCEL: 10,
  PING: 11,
  PONG: 12,
  /** daemon -> hub: JSON `DeviceDeclaration`, replacing the one in HELLO (permissions granted or revoked while connected). */
  DECLARE: 13,
  /**
   * Both ways, JSON `ControlBody`: the person's Stop. daemon -> hub when they press Stop or resume on this computer (Stop carries what it cancelled);
   * hub -> daemon when Stop was pressed on another client (the daemon then cancels what runs and refuses new work). The hub never sends `agent`:
   * a Mac is resumed only on the Mac itself.
   */
  CONTROL: 14,
} as const;
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];
const KNOWN = new Set<number>(Object.values(FrameType));

export interface Frame {
  type: FrameTypeValue;
  channel: number;
  payload: Uint8Array;
}

export class ProtocolError extends Error {}

export function encodeFrame(type: FrameTypeValue, channel: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length + 5 > MAX_FRAME) throw new ProtocolError(`frame of ${payload.length + 5} bytes exceeds ${MAX_FRAME}`);
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, channel);
  out.set(payload, 5);
  return out;
}

export function decodeFrame(raw: Uint8Array): Frame {
  if (raw.length < 5) throw new ProtocolError('frame shorter than its header');
  if (raw.length > MAX_FRAME) throw new ProtocolError('frame too large');
  const type = raw[0] ?? 0;
  if (!KNOWN.has(type)) throw new ProtocolError(`unknown frame type ${type}`);
  const channel = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(1);
  return { type: type as FrameTypeValue, channel, payload: raw.subarray(5) };
}

export function jsonFrame(type: FrameTypeValue, channel: number, value: unknown): Uint8Array {
  return encodeFrame(type, channel, new TextEncoder().encode(JSON.stringify(value)));
}

export function parseJson(payload: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new ProtocolError('payload is not JSON');
  }
}

export function windowFrame(channel: number, credit: number): Uint8Array {
  const body = new Uint8Array(4);
  new DataView(body.buffer).setUint32(0, credit);
  return encodeFrame(FrameType.WINDOW, channel, body);
}

export function readWindow(payload: Uint8Array): number {
  if (payload.length !== 4) throw new ProtocolError('bad window frame');
  return new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0);
}

/** Split bytes into frame-sized pieces. */
export function* chunks(data: Uint8Array, size = MAX_CHUNK): Generator<Uint8Array> {
  for (let at = 0; at < data.length; at += size) yield data.subarray(at, Math.min(data.length, at + size));
}

export interface HelloBody {
  version: number;
  /** The computer's link id (the hub derives the expected token from it). */
  id: string;
  token: string;
  /** Changes whenever the daemon process starts: a cold start of the computer is a new boot id, a pause/resume is not. */
  bootId: string;
  /** What this device can do right now. Required from a Mac (the hub refuses its HELLO without one); optional for a sandbox. */
  device?: DeviceDeclaration;
}

/** What a device can do. A Mac declares only what the user has actually granted; the hub refuses the rest. */
export const DEVICE_ACTIONS = ['files', 'shell', 'desktop', 'browser', 'audio', 'apps'] as const;
export type DeviceAction = (typeof DEVICE_ACTIONS)[number];

export interface DeviceDeclaration {
  /** Stable across reconnects and restarts of the app on this device. */
  deviceId: string;
  /** What the owner sees ("Robin's MacBook Pro"). */
  name: string;
  /** e.g. `macOS 15.2`. */
  osVersion: string;
  /**
   * `files` and `shell` (commands and files inside the shared folder), `desktop` (cua-driver is running with Screen
   * Recording and Accessibility granted: snapshot, act, verify on other apps), `browser` (the Chrome extension bridge is connected),
   * `audio` (system audio capture works), `apps` (Mail, Calendar and Reminders helpers work). Not granted = not listed.
   */
  actions: DeviceAction[];
}

const DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Strict: unknown actions, a bad id or empty text make the whole declaration invalid (undefined), never a partial one. */
export function parseDeviceDeclaration(value: unknown): DeviceDeclaration | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const deviceId: unknown = Reflect.get(value, 'deviceId');
  const name: unknown = Reflect.get(value, 'name');
  const osVersion: unknown = Reflect.get(value, 'osVersion');
  const actions: unknown = Reflect.get(value, 'actions');
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return undefined;
  if (typeof name !== 'string' || name.trim() === '' || name.length > 80) return undefined;
  if (typeof osVersion !== 'string' || osVersion.trim() === '' || osVersion.length > 80) return undefined;
  if (!Array.isArray(actions)) return undefined;
  const known = new Set<DeviceAction>();
  for (const action of actions) {
    const match = DEVICE_ACTIONS.find((candidate) => candidate === action);
    if (match === undefined) return undefined;
    known.add(match);
  }
  return { deviceId, name: name.trim(), osVersion: osVersion.trim(), actions: DEVICE_ACTIONS.filter((action) => known.has(action)) };
}

export interface ExecParams {
  /** A full POSIX shell program. It reaches the shell through a root-only file, never argv. */
  command: string;
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
}
export interface ExecResult {
  exitCode: number;
  timedOut: boolean;
}
export interface ReadFileParams {
  path: string;
  maxBytes?: number;
}
export interface WriteFileParams {
  path: string;
  /** Bytes that follow as DATA frames. */
  size: number;
  /** Octal mode for a new file; default 0644. */
  mode?: number;
}
export interface HealthResult {
  ok: true;
  bootId: string;
  version: number;
  uptimeMs: number;
  /** What the daemon knows about the machine it runs on (a Mac that joined as a computer needs it to name its home). */
  host?: HostInfo;
}
export interface HostInfo {
  platform: string;
  arch: string;
  /** Kernel release, e.g. `25.0.0` on macOS. */
  release: string;
  user: string;
  home: string;
  /** The only directories files and commands may touch; absent for a computer that has no such limit. */
  roots?: string[];
  /** Present when the daemon serves the optional desktop host RPC (cua-driver or a host handler); absent otherwise. */
  desktop?: boolean;
}

/**
 * The only desktop operations the hub may ask the daemon for; anything else is refused. `snapshot`, `act` and `verify` are
 * served by the daemon itself through cua-driver; the rest go to the host's `desktop.handle`.
 */
export type DesktopAction =
  | 'snapshot'
  | 'act'
  | 'verify'
  | 'browser'
  | 'audio_start'
  | 'audio_stop'
  | 'permissions'
  /** Mail, Calendar and Reminders on the Mac: `{ tool, args }` (computerd names the tools it allows). */
  | 'mac_apps';

/** `snapshot`: one app's window, narrowed. The screenshot is small and only sent when asked (or when the tree is empty). */
export interface MacSnapshotInput {
  app: string;
  query?: string;
  screenshot?: boolean;
}
/** One step of `act`: a cua-driver action tool and its arguments (a token from the last snapshot, or a role/name, or x/y). */
export interface MacActStep {
  tool: string;
  args?: Record<string, unknown>;
  wait_for?: Record<string, unknown>;
  expect?: Array<Record<string, unknown>>;
  timeout_ms?: number;
}
/** `act`: steps run in order and stop at the first failure. `foreground` delivers them with the app brought to the front. */
export interface MacActInput {
  app: string;
  steps: MacActStep[];
  foreground?: boolean;
}
/** `verify`: deterministic predicates about the app's window (cua-driver `verify_state` `expect`). */
export interface MacVerifyInput {
  app: string;
  expect: Array<Record<string, unknown>>;
}
/** What the three answer with: text for the model, a small picture sometimes, and whether the app only takes this input in front. */
export interface MacDesktopResult {
  ok: boolean;
  text: string;
  /** cua-driver refused a background delivery (`background_unavailable`): retry `act` with `foreground: true` after the owner agrees. */
  needsForeground?: boolean;
  image?: { mimeType: string; data: string };
}

export interface DesktopRequest {
  agentId: string;
  action: DesktopAction;
  /**
   * Opaque arguments for the host. Untrusted agent data: the host must never treat any field
   * (including `request`) as authorization to prompt — prompts happen only through owner IPC.
   * `permissions` is an owner-only action with no public agent path; the composition
   * layer strips prompt-request fields and denies remote use before it reaches the host.
   */
  input: Record<string, unknown>;
}

/** Type guard for the only desktop operations the hub may ask the daemon for. */
export function isDesktopAction(value: unknown): value is DesktopAction {
  switch (value) {
    case 'snapshot':
    case 'act':
    case 'verify':
    case 'browser':
    case 'audio_start':
    case 'audio_stop':
    case 'permissions':
    case 'mac_apps':
      return true;
    default:
      return false;
  }
}

export type RpcRequest =
  | { method: 'exec'; params: ExecParams }
  | { method: 'readFile'; params: ReadFileParams }
  | { method: 'writeFile'; params: WriteFileParams }
  | { method: 'desktop'; params: DesktopRequest }
  | { method: 'health'; params?: Record<string, never> };

/** `stopped`: the person pressed Stop on this computer (a pause, not a refusal of the action itself). */
export type RpcErrorCode = 'bad_request' | 'not_found' | 'denied' | 'stopped' | 'io' | 'timeout' | 'too_large' | 'cancelled' | 'internal';

/** The person's Stop state of a computer (`FrameType.CONTROL`). `cancelled` is the first line of each command Stop killed, never input text. */
export interface ControlBody {
  holder: 'stopped' | 'agent';
  cancelled?: string[];
}

export function parseControlBody(value: unknown): ControlBody | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const body = value as Record<string, unknown>;
  if (body['holder'] !== 'stopped' && body['holder'] !== 'agent') return undefined;
  const cancelled = Array.isArray(body['cancelled']) ? body['cancelled'].filter((line): line is string => typeof line === 'string').slice(0, 20).map((line) => line.slice(0, 200)) : undefined;
  return { holder: body['holder'], ...(cancelled && cancelled.length > 0 ? { cancelled } : {}) };
}
export interface RpcError {
  code: RpcErrorCode;
  message: string;
}
export type RpcResponse = { result: unknown } | { error: RpcError };

/**
 * The only ports the daemon connects a stream to, all on 127.0.0.1: VNC (5900+N), the read-only VNC (5990+N), websockify
 * (6080+N), its read-only twin (6090+N) for display N in 1..MAX_DISPLAYS, and the Spaces gateway. Chromium's debugging
 * port (9222+N) is deliberately absent: it never leaves the computer.
 */
export const GATEWAY_STREAM_PORT = 7090;
export const MAX_DISPLAYS = 8;
export function streamPortAllowed(port: number): boolean {
  if (!Number.isInteger(port)) return false;
  if (port === GATEWAY_STREAM_PORT) return true;
  return [5900, 5990, 6080, 6090].some((base) => port > base && port <= base + MAX_DISPLAYS);
}

/** Resolves with the size of a credit pool: `take(n)` waits until n bytes of credit exist, `give(n)` adds credit. */
export class Credit {
  private available: number;
  private waiters: Array<() => void> = [];
  private closed = false;
  constructor(initial: number) {
    this.available = initial;
  }
  give(n: number): void {
    this.available += n;
    const waiting = this.waiters;
    this.waiters = [];
    for (const wake of waiting) wake();
  }
  close(): void {
    this.closed = true;
    this.give(0);
  }
  /** Take up to `max` bytes (at least 1); resolves 0 once closed. */
  async take(max: number): Promise<number> {
    while (this.available <= 0) {
      if (this.closed) return 0;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.closed) return 0;
    const n = Math.min(max, this.available);
    this.available -= n;
    return n;
  }
}
