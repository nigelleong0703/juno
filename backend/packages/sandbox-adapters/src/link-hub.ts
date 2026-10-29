/**
 * computerd's end of the computer link (BACKEND §7.11). Every computer runs `juno-link`, which dials OUT to the hub; the
 * hub is the only side that asks for anything. One link per computer (a newer connection replaces the older one), the
 * link id and its token are minted by computerd at create (`tokenFor`), and everything the platform does inside a computer
 * (commands as root, files, byte streams to whitelisted loopback ports) goes through a `LinkConnection`.
 *
 * `juno-link/protocol` is the wire format. Streams are Node `Duplex` objects with a credit window, so a slow reader
 * on either side holds the other back instead of growing a buffer.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Duplex } from 'node:stream';
import type { WebSocket, RawData } from 'ws';
import {
  CLOSE_BAD_DECLARATION,
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  Credit,
  FrameType,
  HIGH_WATER,
  MAX_CHUNK,
  MAX_FRAME,
  MAX_FILE_BYTES,
  PING_INTERVAL_MS,
  PROTOCOL_VERSION,
  ProtocolError,
  SILENCE_MS,
  STREAM_WINDOW,
  chunks,
  decodeFrame,
  encodeFrame,
  jsonFrame,
  parseControlBody,
  parseDeviceDeclaration,
  parseJson,
  readWindow,
  windowFrame,
  type ControlBody,
  type DesktopRequest,
  type DeviceDeclaration,
  type ExecParams,
  type ExecResult,
  type Frame,
  type HealthResult,
  type HelloBody,
  type RpcRequest,
} from 'juno-link/protocol';
import { ComputerdError, aborted, failed, notAllowed, unavailable } from './errors.js';

export interface ExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface LinkConnection {
  readonly id: string;
  /** Changes when the daemon process restarts (a cold start of the computer); constant across pause and resume. */
  readonly bootId: string;
  readonly open: boolean;
  exec(params: ExecParams, signal?: AbortSignal): Promise<ExecOutput>;
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array, signal?: AbortSignal, mode?: number): Promise<void>;
  health(signal?: AbortSignal): Promise<HealthResult>;
  /** What the device declared in its HELLO or last DECLARE; undefined for a sandbox daemon, which declares nothing. */
  device(): DeviceDeclaration | undefined;
  /** One desktop operation on the host (screen/input/audio); fails when the host has no desktop helper. */
  desktop(params: DesktopRequest, signal?: AbortSignal): Promise<unknown>;
  /** A byte stream to 127.0.0.1:<port> inside the computer; only the whitelisted ports open. */
  openStream(port: number, signal?: AbortSignal): Promise<LinkStream>;
}

export interface LinkHub {
  /** The token the computer with this link id must present; derived, so nothing is stored. */
  tokenFor(linkId: string): string;
  /** Take over an upgraded WebSocket: wait for the HELLO, check it, register the link. */
  accept(socket: WebSocket): void;
  get(linkId: string): LinkConnection | undefined;
  /** The link once it is (or already was) up; fails `unavailable` after `timeoutMs`. */
  waitFor(linkId: string, timeoutMs: number, signal?: AbortSignal): Promise<LinkConnection>;
  /** Cut the link of a computer whose connection may be dead (after a resume); its daemon dials in again. */
  drop(linkId: string): void;
  /** Tell a connected Mac the person pressed Stop elsewhere; it cancels what runs and replies with what it cancelled. False when it is offline. */
  sendStop(linkId: string): boolean;
  /** Ids with a live link (for tests and diagnostics). */
  linked(): string[];
  close(): void;
}

export interface LinkHubOptions {
  /** Service secret the per-computer tokens are derived from. */
  secret: string;
  log?: (fields: Record<string, unknown>, message: string) => void;
  helloTimeoutMs?: number;
  /** A link id the platform has withdrawn (an unpaired Mac) is refused even though its token still derives from the secret. */
  withdrawn?(linkId: string): boolean;
  /** A link that must say what it can do (a Mac): its HELLO is refused with `CLOSE_BAD_DECLARATION` when it carries no declaration. */
  requireDeclaration?(linkId: string): boolean;
  /** The person's Stop or resume, pressed on the computer itself (`FrameType.CONTROL`); computerd writes it to the control gateway. */
  onControl?(linkId: string, body: ControlBody): void;
  /** Who holds the computer in the control gateway right now, asked when it connects (so a Stop made elsewhere while it was away reaches it). */
  controlOf?(linkId: string): 'agent' | 'user' | 'stopped' | undefined | Promise<'agent' | 'user' | 'stopped' | undefined>;
}

const LINK_ID = /^[A-Za-z0-9-]{8,64}$/;
const OPEN_TIMEOUT_MS = 15_000;
const MAX_EXEC_OUTPUT = 32 * 1024 * 1024;
const MAX_WRITE_BYTES = MAX_FILE_BYTES;

export function createLinkHub(options: LinkHubOptions): LinkHub {
  const log = options.log ?? (() => undefined);
  const sessions = new Map<string, Session>();
  const waiters = new Map<string, Set<(connection: LinkConnection) => void>>();
  const tokenFor = (linkId: string) => createHmac('sha256', options.secret).update(`link:${linkId}`).digest('hex');
  const digest = (value: string) => createHash('sha256').update(value).digest();

  function register(session: Session): void {
    const previous = sessions.get(session.id);
    sessions.set(session.id, session);
    if (previous) previous.close(CLOSE_REPLACED, 'replaced by a newer link');
    for (const wake of waiters.get(session.id) ?? []) wake(session);
    waiters.delete(session.id);
    log({ linkId: session.id, bootId: session.bootId }, 'computer link up');
    session.onClosed(() => {
      if (sessions.get(session.id) === session) sessions.delete(session.id);
      log({ linkId: session.id }, 'computer link down');
    });
  }

  return {
    tokenFor,
    accept(socket) {
      socket.binaryType = 'nodebuffer';
      const timer = setTimeout(() => socket.close(CLOSE_UNAUTHORIZED, 'no hello'), options.helloTimeoutMs ?? 10_000);
      socket.once('close', () => clearTimeout(timer));
      socket.once('message', (raw: RawData) => {
        clearTimeout(timer);
        let parsed: ParsedHello | undefined;
        try {
          const frame = decodeFrame(toBytes(raw));
          if (frame.type === FrameType.HELLO) parsed = parseHello(parseJson(frame.payload));
        } catch {
          parsed = undefined;
        }
        const hello = parsed?.hello;
        if (hello === undefined || !LINK_ID.test(hello.id) || hello.version !== PROTOCOL_VERSION || options.withdrawn?.(hello.id) === true || !timingSafeEqual(digest(hello.token), digest(tokenFor(hello.id)))) {
          log({}, 'computer link refused');
          socket.close(CLOSE_UNAUTHORIZED, 'unauthorized');
          return;
        }
        // Authenticated, so the refusal can say why: a Mac that does not declare what it can do is an app that needs updating.
        if (parsed?.badDevice === true || (hello.device === undefined && options.requireDeclaration?.(hello.id) === true)) {
          log({ linkId: hello.id }, 'computer link refused: device declaration missing or invalid');
          socket.close(CLOSE_BAD_DECLARATION, 'device declaration missing or invalid');
          return;
        }
        const session = new Session(socket, hello.id, hello.bootId, (body) => options.onControl?.(hello.id, body), hello.device);
        register(session);
        // The first frame the daemon hears: it knows now that it was accepted.
        session.send(encodeFrame(FrameType.PING, 0));
        // A Stop pressed on a phone while this Mac was away: it learns it now (a daemon with its own unsent change keeps that instead).
        void Promise.resolve(options.controlOf?.(hello.id)).then((holder) => {
          if (holder === 'stopped') session.send(jsonFrame(FrameType.CONTROL, 0, { holder: 'stopped' } satisfies ControlBody));
        }, () => undefined);
      });
    },
    get: (linkId) => sessions.get(linkId),
    sendStop(linkId) {
      const session = sessions.get(linkId);
      if (!session) return false;
      session.send(jsonFrame(FrameType.CONTROL, 0, { holder: 'stopped' } satisfies ControlBody));
      return true;
    },
    waitFor(linkId, timeoutMs, signal) {
      const up = sessions.get(linkId);
      if (up) return Promise.resolve(up);
      return new Promise<LinkConnection>((resolve, reject) => {
        const set = waiters.get(linkId) ?? new Set();
        waiters.set(linkId, set);
        const done = (connection: LinkConnection) => {
          cleanup();
          resolve(connection);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(unavailable(`the computer's link is not connected (waited ${Math.round(timeoutMs / 1000)}s); it may be starting, stopped or unable to reach computerd`));
        }, timeoutMs);
        const onAbort = () => {
          cleanup();
          reject(aborted('waiting for the computer link was cancelled'));
        };
        function cleanup() {
          clearTimeout(timer);
          set.delete(done);
          signal?.removeEventListener('abort', onAbort);
        }
        set.add(done);
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    drop(linkId) {
      sessions.get(linkId)?.terminate();
    },
    linked: () => [...sessions.keys()],
    close() {
      for (const session of sessions.values()) session.close(1001, 'computerd stopping');
      sessions.clear();
    },
  };
}

interface ParsedHello {
  hello: HelloBody;
  /** The HELLO carried a `device` that is not a valid declaration. */
  badDevice: boolean;
}

function parseHello(value: unknown): ParsedHello | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const version: unknown = Reflect.get(value, 'version');
  const id: unknown = Reflect.get(value, 'id');
  const token: unknown = Reflect.get(value, 'token');
  const bootId: unknown = Reflect.get(value, 'bootId');
  if (typeof version !== 'number' || typeof id !== 'string' || typeof token !== 'string' || typeof bootId !== 'string') return undefined;
  const sent: unknown = Reflect.get(value, 'device');
  const device = sent === undefined ? undefined : parseDeviceDeclaration(sent);
  return { hello: { version, id, token, bootId, ...(device === undefined ? {} : { device }) }, badDevice: sent !== undefined && device === undefined };
}

function toBytes(raw: RawData): Uint8Array {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
}

interface Pending {
  onData?(payload: Uint8Array): void;
  settle(response: unknown): void;
  drop(error: Error): void;
  /** Error to fail with when the link drops mid-request (defaults to the shared drop error). */
  dropError?: Error;
}

/** Desktop actions that only read state: safe to retry deliberately after an unknown outcome. */
const DESKTOP_READ_ONLY = new Set(['screenshot', 'permissions']);

/** After-dispatch failure text: the Mac may already have acted, so the outcome is unknown. */
function desktopLostMessage(action: string): string {
  const retry = DESKTOP_READ_ONLY.has(action)
    ? 'read-only actions (screenshot, permissions) can be retried deliberately once the Mac is back'
    : 'inspect the Mac (take a screenshot) before retrying: a click, keypress, typed text or browser input may already have happened';
  return (
    `the Mac went offline during desktop '${action}': the outcome is unknown. ` +
    `${retry}; nothing was run on the sandbox instead, and the request is not resent automatically.`
  );
}

/** One live link. */
class Session implements LinkConnection {
  open = true;
  private next = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly streams = new Map<number, LinkStream>();
  private readonly closedCallbacks: Array<() => void> = [];
  private heardAt = Date.now();
  private readonly pinger: ReturnType<typeof setInterval>;

  constructor(
    private readonly socket: WebSocket,
    readonly id: string,
    readonly bootId: string,
    private readonly onControl: (body: ControlBody) => void,
    private declared?: DeviceDeclaration,
  ) {
    socket.on('message', (raw: RawData) => this.onMessage(raw));
    socket.once('close', () => this.onClose());
    socket.on('error', () => socket.terminate());
    this.pinger = setInterval(() => {
      if (Date.now() - this.heardAt > SILENCE_MS) return socket.terminate();
      this.send(encodeFrame(FrameType.PING, 0));
    }, PING_INTERVAL_MS);
    this.pinger.unref();
  }

  onClosed(callback: () => void): void {
    this.closedCallbacks.push(callback);
  }

  device(): DeviceDeclaration | undefined {
    return this.declared;
  }

  close(code: number, reason: string): void {
    this.socket.close(code, reason);
  }

  terminate(): void {
    this.socket.terminate();
  }

  send(frame: Uint8Array): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(frame);
  }

  /** Wait while the socket's send buffer is full. */
  async drained(): Promise<void> {
    while (this.open && this.socket.bufferedAmount > HIGH_WATER) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  private nextChannel(): number {
    const channel = this.next;
    this.next = this.next >= 0xffffffff ? 1 : this.next + 1;
    return channel;
  }

  private onMessage(raw: RawData): void {
    this.heardAt = Date.now();
    let frame: Frame;
    try {
      const bytes = toBytes(raw);
      if (bytes.length > MAX_FRAME) throw new ProtocolError('frame too large');
      frame = decodeFrame(bytes);
    } catch {
      this.socket.close(1002, 'bad frame');
      return;
    }
    const { channel } = frame;
    switch (frame.type) {
      case FrameType.RESULT:
        return this.pending.get(channel)?.settle(parseJson(frame.payload));
      case FrameType.DATA:
        return this.pending.has(channel) ? this.pending.get(channel)?.onData?.(frame.payload) : this.streams.get(channel)?.fromLink(frame.payload);
      case FrameType.OPENED:
        return this.streams.get(channel)?.opened();
      case FrameType.END:
        return this.streams.get(channel)?.remoteEnd();
      case FrameType.CLOSE:
        return this.streams.get(channel)?.remoteClose(new TextDecoder().decode(frame.payload));
      case FrameType.WINDOW:
        return this.streams.get(channel)?.credit.give(readWindow(frame.payload));
      case FrameType.PING:
        return this.send(encodeFrame(FrameType.PONG, 0));
      case FrameType.DECLARE: {
        // A new declaration replaces the old one whole; an invalid one drops the link (the device declares again on reconnect).
        const next = parseDeviceDeclaration(parseJson(frame.payload));
        if (next === undefined) return this.close(CLOSE_BAD_DECLARATION, 'device declaration invalid');
        this.declared = next;
        return;
      }
      case FrameType.CONTROL: {
        const body = parseControlBody(parseJson(frame.payload));
        if (body !== undefined) this.onControl(body);
        return;
      }
      default:
        return;
    }
  }

  private onClose(): void {
    this.open = false;
    clearInterval(this.pinger);
    const error = unavailable('the computer link dropped');
    for (const pending of this.pending.values()) pending.drop(pending.dropError ?? error);
    this.pending.clear();
    for (const stream of this.streams.values()) stream.remoteClose('the computer link dropped');
    this.streams.clear();
    for (const callback of this.closedCallbacks) callback();
  }

  /** Send a request; `onData` sees its streamed frames; resolves with the daemon's `result`. */
  private call(
    request: RpcRequest,
    signal: AbortSignal | undefined,
    onData?: (payload: Uint8Array) => void,
    deadlineMs?: number,
    dropError?: Error,
  ): { channel: number; done: Promise<unknown> } {
    if (!this.open) return { channel: 0, done: Promise.reject(unavailable('the computer link is down')) };
    const channel = this.nextChannel();
    const done = new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(channel);
      };
      const onAbort = () => {
        this.send(encodeFrame(FrameType.CANCEL, channel));
        finish();
        reject(aborted('the computer request was cancelled'));
      };
      this.pending.set(channel, {
        ...(onData ? { onData } : {}),
        ...(dropError === undefined ? {} : { dropError }),
        settle: (response) => {
          finish();
          const body = typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : {};
          const error = body['error'];
          if (typeof error === 'object' && error !== null) {
            const { code, message } = error as { code?: string; message?: string };
            // Stop on the Mac is a pause the agent waits out (user_control), not a refusal of the action (not_allowed).
            reject(
              code === 'cancelled' ? aborted(message ?? 'cancelled')
                : code === 'stopped' ? new ComputerdError('user_control', message ?? 'the user stopped this computer', { surface: 'mac', holder: 'stopped' })
                  : code === 'denied' ? notAllowed(message ?? 'denied') : failed(message ?? 'the computer refused the request'),
            );
          } else resolve(body['result']);
        },
        drop: (error) => {
          finish();
          reject(error);
        },
      });
      if (deadlineMs !== undefined) {
        timer = setTimeout(() => {
          this.send(encodeFrame(FrameType.CANCEL, channel));
          finish();
          reject(unavailable('the computer did not answer in time'));
        }, deadlineMs);
      }
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.send(jsonFrame(FrameType.RPC, channel, request));
    });
    return { channel, done };
  }

  async exec(params: ExecParams, signal?: AbortSignal): Promise<ExecOutput> {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let total = 0;
    const onData = (payload: Uint8Array) => {
      if (total >= MAX_EXEC_OUTPUT) return;
      total += payload.length;
      (payload[0] === 2 ? err : out).push(Buffer.from(payload.subarray(1)));
    };
    const timeoutMs = params.timeoutMs ?? 120_000;
    const result = (await this.call({ method: 'exec', params }, signal, onData, timeoutMs + 30_000).done) as ExecResult;
    if (result.timedOut) throw unavailable(`the command timed out after ${timeoutMs}ms (its process group was killed)`);
    return { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exitCode: result.exitCode, timedOut: false };
  }

  async readFile(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const parts: Buffer[] = [];
    await this.call({ method: 'readFile', params: { path } }, signal, (payload) => parts.push(Buffer.from(payload)), 120_000).done;
    return Buffer.concat(parts);
  }

  async writeFile(path: string, data: Uint8Array, signal?: AbortSignal, mode?: number): Promise<void> {
    if (data.length > MAX_WRITE_BYTES) throw failed(`${path} is larger than the ${MAX_WRITE_BYTES} byte file limit`);
    const call = this.call({ method: 'writeFile', params: { path, size: data.length, ...(mode === undefined ? {} : { mode }) } }, signal, undefined, 120_000);
    const sending = (async () => {
      for (const piece of chunks(data, MAX_CHUNK)) {
        await this.drained();
        this.send(encodeFrame(FrameType.DATA, call.channel, piece));
      }
    })();
    await Promise.all([call.done, sending]);
  }

  async health(signal?: AbortSignal): Promise<HealthResult> {
    return (await this.call({ method: 'health' }, signal, undefined, 15_000).done) as HealthResult;
  }

  async desktop(params: DesktopRequest, signal?: AbortSignal): Promise<unknown> {
    // Offline before dispatch: nothing was sent, so nothing ran. Never fall back to the sandbox silently and
    // never resend automatically: the caller retries deliberately once the Mac is back.
    if (!this.open) {
      throw unavailable(
        `the Mac is offline: desktop '${params.action}' was not sent and did not run. ` +
          'Reconnect the Mac then retry deliberately; nothing ran on the sandbox instead.',
      );
    }
    // Lost after dispatch (drop or deadline): the Mac may already have acted, so the outcome is unknown.
    // Mutating input (click/type/browser) must be inspected before any retry; read-only actions
    // (screenshot/permissions) can be retried deliberately.
    const dropError = unavailable(desktopLostMessage(params.action));
    try {
      return await this.call({ method: 'desktop', params }, signal, undefined, 60_000, dropError).done;
    } catch (error) {
      // Sent but never answered: same unknown outcome as a mid-request drop (no automatic resend).
      if (error instanceof Error && error.message.includes('did not answer in time')) throw dropError;
      throw error;
    }
  }

  openStream(port: number, signal?: AbortSignal): Promise<LinkStream> {
    if (!this.open) return Promise.reject(unavailable('the computer link is down'));
    const channel = this.nextChannel();
    const stream = new LinkStream(this, channel, () => this.streams.delete(channel));
    this.streams.set(channel, stream);
    this.send(jsonFrame(FrameType.OPEN, channel, { port }));
    return stream.whenOpen(OPEN_TIMEOUT_MS, signal);
  }
}

/** A Duplex over one link stream; looks enough like a socket for `http.request({ createConnection })` and `ws`. */
export class LinkStream extends Duplex {
  readonly credit = new Credit(STREAM_WINDOW);
  private owed = 0;
  private opening: { resolve(stream: LinkStream): void; reject(error: Error): void } | undefined;
  private finished = false;

  constructor(private readonly session: Session, private readonly channel: number, private readonly forget: () => void) {
    super({ allowHalfOpen: true });
  }

  whenOpen(timeoutMs: number, signal?: AbortSignal): Promise<LinkStream> {
    return new Promise<LinkStream>((resolve, reject) => {
      const timer = setTimeout(() => fail(unavailable('the computer did not open the stream in time')), timeoutMs);
      const fail = (error: Error) => {
        clearTimeout(timer);
        this.destroy();
        reject(error);
      };
      this.opening = {
        resolve: (stream) => {
          clearTimeout(timer);
          resolve(stream);
        },
        reject: fail,
      };
      const onAbort = () => fail(aborted('opening the stream was cancelled'));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  opened(): void {
    this.opening?.resolve(this);
    this.opening = undefined;
  }

  fromLink(payload: Uint8Array): void {
    const size = payload.length;
    if (this.push(Buffer.from(payload))) this.session.send(windowFrame(this.channel, size));
    else this.owed += size;
  }

  remoteEnd(): void {
    this.push(null);
  }

  remoteClose(reason: string): void {
    this.finished = true;
    this.credit.close();
    if (this.opening) {
      this.opening.reject(unavailable(`could not reach the computer's port: ${reason || 'refused'}`));
      this.opening = undefined;
    }
    this.push(null);
    this.destroy();
  }

  override _read(): void {
    if (this.owed > 0) {
      const grant = this.owed;
      this.owed = 0;
      this.session.send(windowFrame(this.channel, grant));
    }
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void (async () => {
      for (const piece of chunks(chunk)) {
        let sent = 0;
        while (sent < piece.length) {
          const n = await this.credit.take(piece.length - sent);
          if (n === 0) throw unavailable('the stream is closed');
          await this.session.drained();
          this.session.send(encodeFrame(FrameType.DATA, this.channel, piece.subarray(sent, sent + n)));
          sent += n;
        }
      }
    })().then(() => callback(), (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.session.send(encodeFrame(FrameType.END, this.channel));
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.credit.close();
    if (!this.finished) this.session.send(encodeFrame(FrameType.CLOSE, this.channel));
    this.finished = true;
    this.forget();
    callback(error);
  }

  // Socket-shaped no-ops: http.request and ws call these on whatever createConnection returned.
  setTimeout(): this {
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

/**
 * `createConnection` for `http.request` and `ws`: those want a socket synchronously or through a callback, and a link
 * stream takes a round trip to open, so this hands over the callback form.
 */
export function streamConnector(open: () => Promise<Duplex>): (options: unknown, callback: (error: Error | null, stream?: Duplex) => void) => undefined {
  return (_options, callback) => {
    open().then((stream) => callback(null, stream), (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
    return undefined;
  };
}
