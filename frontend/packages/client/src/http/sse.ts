/**
 * Fetch-based Server-Sent Events transport for the live event stream (`GET /v1/events`).
 *
 * One connection is shared by every subscriber. It opens lazily on the first `subscribe` and is
 * aborted, with any pending reconnect timer cleared, when the last subscriber unsubscribes.
 *
 * Frames are decoded incrementally, so a UTF-8 sequence or an SSE frame may be split across network
 * chunks; `\n` and `\r\n` line endings are both accepted. Every `data:` payload is validated with
 * `agentEventSchema` before it reaches a subscriber, so malformed or unknown frames are dropped. A
 * delivered frame records its `id` as the resume cursor, which is sent back as `Last-Event-ID` on
 * reconnect. An `event: reset` frame (the server can no longer replay from our cursor) clears the
 * cursor so the next attempt restarts from the beginning.
 *
 * Contract notes for callers:
 * - Frames whose `data:` is not valid JSON, or does not match a known `AgentEvent`, are dropped
 *   silently: no subscriber sees them and the cursor does not advance past them.
 * - The schema is intentionally `AgentEvent` as-is; this transport never widens it (delta frames
 *   emitted by the server are therefore dropped until the client contract gains them).
 * - `event: reset` clears the resume cursor and calls `onReset` (if provided) so the caller can
 *   refetch state; it is not delivered to subscribers because it is not an `AgentEvent`.
 */

import { agentEventSchema, type EventHandler, type Unsubscribe } from '../contracts.js';
import { softenUiDocs } from './ui-docs.js';

/** Timer hooks; tests inject a deterministic scheduler. */
export interface EventStreamScheduler {
  schedule(handler: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface EventStreamOptions {
  /** Absolute URL of the SSE endpoint. */
  url: string;
  getToken: () => Promise<string> | string;
  fetch: typeof globalThis.fetch;
  /** Sent as `x-juno-client` so the server knows which app the user has open (agent presence). */
  clientKind?: 'web' | 'desktop' | 'ios';
  /** First reconnect delay; doubles on each consecutive failure. Defaults to 100 ms. */
  reconnectDelayMs?: number;
  /** Upper bound for the reconnect delay. Defaults to 5000 ms. */
  maxReconnectDelayMs?: number;
  /** Optional transport diagnostics (network failures, non-2xx responses, throwing handlers). */
  onError?: (error: unknown) => void;
  /** Called when the server sends `event: reset` (its replay window no longer covers our cursor). */
  onReset?: () => void;
  /**
   * Starting cursor, resolved once before the first connect (memoized: later reconnects reuse it). Resolve
   * it from `GET /v1/events/cursor` so the stream replays only what the REST snapshot does not cover. `null`
   * or a rejection means "from the beginning" (the server replays its retained log).
   */
  initialCursor?: () => Promise<number | null>;
  scheduler?: EventStreamScheduler;
  /**
   * An open stream that delivers nothing (not even the server's 15 s heartbeat) for this long is treated as
   * dead and reconnected with the resume cursor. A half-open connection (sleep, network change, a proxy that
   * keeps the client side open after the server went away) otherwise looks connected forever and silently
   * stops delivering. Defaults to 45 s (three heartbeats).
   */
  idleTimeoutMs?: number;
}

export interface EventStream {
  subscribe(handler: EventHandler): Unsubscribe;
  /** The server reset its replay window; cached state must be rebuilt from the next replay. */
  subscribeReset(listener: () => void): Unsubscribe;
  isConnected(): boolean;
  subscribeConnection(listener: (connected: boolean) => void): Unsubscribe;
}

/**
 * The byte-stream surface readBody uses, structural so the Node and DOM stream
 * types both fit without casts: only getReader/read/cancel/releaseLock are read.
 */
export interface SseStreamBody {
  getReader(): SseStreamReader;
}

export interface SseStreamReader {
  read(): Promise<{ done: boolean; value: Uint8Array | undefined }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

/** How many delivered event ids are remembered for dedupe (oldest forgotten first). */
const RECENT_EVENT_IDS = 500;
const DEFAULT_RECONNECT_DELAY_MS = 100;
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 5000;
/** Keep the exponential factor finite even after a long offline stretch. */
const MAX_BACKOFF_EXPONENT = 16;

/** A blank line terminates a frame; accept LF, CRLF and lone CR. */
const FRAME_BOUNDARY = /\r\n\r\n|\n\n|\r\r/;
const LINE_BREAK = /\r\n|\n|\r/;
const NUMERIC_ID = /^\d+$/;

/**
 * Timer implementation backed by the ambient `setTimeout`/`clearTimeout`. The transport keeps at
 * most one retry timer outstanding, so a single per-instance slot is enough; the returned handle is
 * opaque to callers (`unknown`) so the type works under both DOM and Node global timer types.
 */
function createDefaultScheduler(): EventStreamScheduler {
  return {
    schedule: (handler, delayMs) => setTimeout(handler, delayMs),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

interface SseFrame {
  event: string | null;
  data: string;
  id: string | null;
}

/** Parse one SSE frame (the text between two blank lines). Returns null for comment-only frames. */
function parseFrame(raw: string): SseFrame | null {
  let event: string | null = null;
  let id: string | null = null;
  const dataLines: string[] = [];
  let sawField = false;

  for (const line of raw.split(LINE_BREAK)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    sawField = true;
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') dataLines.push(value);
  }

  return sawField ? { event, data: dataLines.join('\n'), id } : null;
}

export function createEventStream(opts: EventStreamOptions): EventStream {
  const fetch_ = opts.fetch;
  const reconnectDelayMs = opts.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const maxReconnectDelayMs = opts.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
  const scheduler = opts.scheduler ?? createDefaultScheduler();
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  const handlers = new Set<EventHandler>();
  const resetListeners = new Set<() => void>();
  let running = false;
  let attempt = 0;
  let lastEventId: number | null = null;
  // Insertion-ordered: the first entry is the oldest id remembered.
  const recentEventIds = new Set<number>();
  let controller: AbortController | null = null;
  let activeReader: SseStreamReader | null = null;
  let retryTimer: unknown = null;
  let cursorReady: Promise<void> | null = null;
  // Starts true: no banner before a stream has ever been asked for, or after an intentional stop.
  let connected = true;
  const connectionListeners = new Set<(next: boolean) => void>();
  const setConnected = (next: boolean): void => {
    if (connected === next) return;
    connected = next;
    for (const listener of [...connectionListeners]) listener(next);
  };

  const report = (error: unknown): void => {
    if (opts.onError) opts.onError(error);
  };

  /**
   * Seeds the resume cursor once. Only fills an empty cursor, so a frame received before this settles
   * (impossible today, but cheap to be correct about) is never overwritten by an older value.
   */
  const resolveInitialCursor = (): Promise<void> => {
    if (!opts.initialCursor) return Promise.resolve();
    return opts.initialCursor().then(
      (after) => {
        if (lastEventId === null && after !== null && after > 0) lastEventId = after;
      },
      (error: unknown) => {
        report(error);
      },
    );
  };

  const deliver = (event: Parameters<EventHandler>[0]): void => {
    for (const handler of [...handlers]) {
      try {
        handler(event);
      } catch (error) {
        // One misbehaving subscriber must not stop delivery to the others.
        report(error);
      }
    }
  };

  const deliverReset = (): void => {
    for (const listener of [...resetListeners]) {
      try {
        listener();
      } catch (error) {
        report(error);
      }
    }
    if (opts.onReset) opts.onReset();
  };

  const handleFrame = (raw: string): void => {
    const frame = parseFrame(raw);
    if (!frame) return;

    if (frame.event === 'reset') {
      // The server cannot replay from our cursor any more: restart from the beginning and
      // accept ids it replays after the reset, including ids seen before it.
      lastEventId = null;
      recentEventIds.clear();
      deliverReset();
      return;
    }
    if (frame.data === '') return;

    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      return; // malformed JSON is not an AgentEvent
    }
    const parsed = agentEventSchema.safeParse(softenUiDocs(payload));
    if (!parsed.success) return; // unknown/!invalid frames never reach subscribers

    if (frame.id !== null && NUMERIC_ID.test(frame.id)) {
      const id = Number(frame.id);
      // A replay that overlaps the live stream (or a duplicate after a reconnect) must not be applied twice.
      if (recentEventIds.has(id)) return;
      recentEventIds.add(id);
      if (recentEventIds.size > RECENT_EVENT_IDS) recentEventIds.delete(recentEventIds.values().next().value as number);
      lastEventId = id;
    }
    attempt = 0; // a healthy frame resets the backoff
    deliver(parsed.data);
  };

  /** Split `buffer` on frame boundaries, handling every complete frame and returning the tail. */
  const drainFrames = (buffer: string): string => {
    let rest = buffer;
    for (;;) {
      const match = FRAME_BOUNDARY.exec(rest);
      if (!match) return rest;
      const raw = rest.slice(0, match.index);
      rest = rest.slice(match.index + match[0].length);
      handleFrame(raw);
    }
  };

  const readBody = async (
    body: SseStreamBody,
    signal: AbortSignal,
  ): Promise<void> => {
    const reader = body.getReader();
    activeReader = reader;
    const onAbort = (): void => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', onAbort);
    const decoder = new TextDecoder();
    let buffer = '';
    // Silence watchdog: any bytes (frames or heartbeat comments) re-arm it; silence past the limit drops the
    // stream so the reconnect below resumes from the cursor.
    let idleTimer: unknown = null;
    const armIdle = (): void => {
      if (idleTimer !== null) scheduler.cancel(idleTimer);
      idleTimer = scheduler.schedule(() => {
        idleTimer = null;
        report(new Error(`event stream silent for ${idleTimeoutMs} ms; reconnecting`));
        void reader.cancel().catch(() => {});
      }, idleTimeoutMs);
    };
    armIdle();

    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        armIdle();
        buffer += decoder.decode(chunk.value, { stream: true });
        buffer = drainFrames(buffer);
      }
      buffer += decoder.decode();
      drainFrames(buffer);
    } catch {
      // Abort or transport failure; the reconnect logic decides what happens next.
    } finally {
      if (idleTimer !== null) scheduler.cancel(idleTimer);
      signal.removeEventListener('abort', onAbort);
      if (activeReader === reader) activeReader = null;
      try {
        reader.releaseLock();
      } catch {
        // Already released by cancel().
      }
    }
  };

  const clearRetry = (): void => {
    if (retryTimer !== null) {
      scheduler.cancel(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleReconnect = (): void => {
    if (!running || handlers.size === 0 || retryTimer !== null) return;
    setConnected(false);
    attempt += 1;
    const exponent = Math.min(attempt - 1, MAX_BACKOFF_EXPONENT);
    const delay = Math.min(reconnectDelayMs * 2 ** exponent, maxReconnectDelayMs);
    retryTimer = scheduler.schedule(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };

  const connect = async (): Promise<void> => {
    if (!running || handlers.size === 0) return;

    const abort = new AbortController();
    controller = abort;

    let token: string;
    try {
      token = await opts.getToken();
    } catch (error) {
      if (controller === abort) controller = null;
      report(error);
      scheduleReconnect();
      return;
    }
    if (!running) {
      if (controller === abort) controller = null;
      return;
    }

    cursorReady ??= resolveInitialCursor();
    await cursorReady;
    if (!running || abort.signal.aborted) {
      if (controller === abort) controller = null;
      return;
    }

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
    };
    if (lastEventId !== null) headers['Last-Event-ID'] = String(lastEventId);
    if (opts.clientKind) headers['x-juno-client'] = opts.clientKind;

    let response: Response;
    try {
      response = await fetch_(opts.url, { method: 'GET', headers, signal: abort.signal });
    } catch (error) {
      if (controller === abort) controller = null;
      if (abort.signal.aborted) return;
      report(error);
      scheduleReconnect();
      return;
    }

    if (!response.ok || !response.body) {
      if (controller === abort) controller = null;
      abort.abort();
      report(new Error(`event stream responded HTTP ${response.status}`));
      scheduleReconnect();
      return;
    }

    setConnected(true);
    await readBody(response.body, abort.signal);
    if (controller === abort) controller = null;
    if (!running || abort.signal.aborted) return;
    scheduleReconnect();
  };

  const start = (): void => {
    if (running) return;
    running = true;
    attempt = 0;
    void connect();
  };

  const stop = (): void => {
    running = false;
    attempt = 0;
    clearRetry();
    setConnected(true);
    if (activeReader) void activeReader.cancel().catch(() => {});
    if (controller) {
      controller.abort();
      controller = null;
    }
  };

  const subscribe = (handler: EventHandler): Unsubscribe => {
    handlers.add(handler);
    if (handlers.size === 1) start();
    return () => {
      if (!handlers.delete(handler)) return;
      if (handlers.size === 0) stop();
    };
  };

  const subscribeConnection = (listener: (next: boolean) => void): Unsubscribe => {
    connectionListeners.add(listener);
    return () => {
      connectionListeners.delete(listener);
    };
  };

  const subscribeReset = (listener: () => void): Unsubscribe => {
    resetListeners.add(listener);
    return () => {
      resetListeners.delete(listener);
    };
  };

  return { subscribe, subscribeReset, isConnected: () => connected, subscribeConnection };
}
