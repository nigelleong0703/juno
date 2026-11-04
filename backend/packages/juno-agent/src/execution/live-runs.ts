/**
 * Live run output: the in-process channel a model attempt's streamed text travels on. It is a harness service, not storage: nothing
 * here is written to the database, and a consumer that connects late gets the durable reply item instead of a replay.
 *
 * One process (`AGENTD_ROLE=all`) hands text from the run loop to the HTTP stream through one `LiveRuns` hub, in memory. When the
 * roles are split, the worker publishes into a `coalescingLive` sink whose flush crosses to the coordinator (EventBus.publishLive /
 * subscribeLive), and the coordinator relays what arrives into its own hub. Consumers are the same either way: the voice bridge's
 * run stream today, a text chat's token display later (it filters by conversation and run like any other subscriber).
 */
import type { LiveRunEvent } from '../contracts/events.js';

/** What the run loop needs: publish only, never awaited, never throwing. */
export interface LiveRunSink {
  publish(event: LiveRunEvent): void;
}

/** Which live events a subscriber wants. A run id alone is not enough: every owner's runs share the hub. */
export interface LiveRunFilter {
  ownerId: string;
  conversationId: string;
  runId: string;
}

export interface LiveRuns extends LiveRunSink {
  /** Delivers matching events synchronously, in publish order; returns the unsubscribe. */
  subscribe(filter: LiveRunFilter, onEvent: (event: LiveRunEvent) => void): () => void;
}

/** Most text kept per run for a late subscriber; the oldest deltas of the current attempt go first. */
const REPLAY_MAX_BYTES = 64 * 1024;
/** A run's buffer is dropped this long after its last event (a finished turn, a finished run, or a run that vanished). */
const REPLAY_TTL_MS = 30_000;

interface RunBuffer {
  events: LiveRunEvent[];
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}

const runKey = (scope: LiveRunFilter): string => scope.ownerId + '\0' + scope.conversationId + '\0' + scope.runId;

/**
 * The in-process hub. A subscriber that throws never affects the publisher or another subscriber. It keeps, per run, the events of
 * the CURRENT attempt since its last reset (bounded) and replays them synchronously to a subscriber that joins mid-run, before live
 * delivery, so a stream opened after the run started (the consumer learns the run id only once the run is admitted) loses no text.
 * A reset starts the buffer over, so a late subscriber after a retry sees only the new attempt. Nothing is persisted.
 */
export function createLiveRuns(onError?: (error: unknown) => void): LiveRuns {
  const subscribers = new Set<{ filter: LiveRunFilter; onEvent: (event: LiveRunEvent) => void }>();
  const buffers = new Map<string, RunBuffer>();

  const remember = (event: LiveRunEvent): void => {
    const key = runKey(event);
    const previous = buffers.get(key);
    if (previous !== undefined) clearTimeout(previous.timer);
    const timer = setTimeout(() => { buffers.delete(key); }, REPLAY_TTL_MS);
    timer.unref();
    const buffer: RunBuffer = event.type === 'run.text.reset' || previous === undefined ? { events: [], bytes: 0, timer } : { ...previous, timer };
    buffer.events.push(event);
    if (event.type === 'run.text.delta') {
      buffer.bytes += Buffer.byteLength(event.text, 'utf8');
      // Over the bound: drop the oldest deltas, keeping the reset (which names the attempt) at the front.
      while (buffer.bytes > REPLAY_MAX_BYTES && buffer.events.length > 1) {
        const oldest = buffer.events.findIndex((kept) => kept.type === 'run.text.delta');
        if (oldest < 0) break;
        const [dropped] = buffer.events.splice(oldest, 1);
        if (dropped?.type === 'run.text.delta') buffer.bytes -= Buffer.byteLength(dropped.text, 'utf8');
      }
    }
    buffers.set(key, buffer);
  };

  const deliver = (onEvent: (event: LiveRunEvent) => void, event: LiveRunEvent): void => {
    try {
      onEvent(event);
    } catch (error) {
      onError?.(error);
    }
  };

  return {
    publish(event) {
      remember(event);
      for (const subscriber of [...subscribers]) {
        const { filter } = subscriber;
        if (event.ownerId !== filter.ownerId || event.conversationId !== filter.conversationId || event.runId !== filter.runId) continue;
        deliver(subscriber.onEvent, event);
      }
    },
    subscribe(filter, onEvent) {
      for (const event of buffers.get(runKey(filter))?.events ?? []) deliver(onEvent, event);
      const subscriber = { filter, onEvent };
      subscribers.add(subscriber);
      return () => { subscribers.delete(subscriber); };
    },
  };
}

export interface CoalescingOptions {
  /** Receives one batch per flush, in order. A rejection is reported to `onError` and the batch is dropped (live text is not storage). */
  send(batch: LiveRunEvent[]): Promise<void>;
  /** Flush at most this often (default 50 ms). */
  flushMs?: number;
  /** Flush as soon as the pending text reaches this many bytes (default 4096). */
  flushBytes?: number;
  onError?: (error: unknown) => void;
}

const sameAttempt = (a: LiveRunEvent, b: LiveRunEvent): boolean =>
  a.ownerId === b.ownerId && a.conversationId === b.conversationId && a.runId === b.runId && a.attempt === b.attempt;

/**
 * The cross-process publisher: buffers events and sends them in batches, merging consecutive text deltas of one attempt into one
 * delta so a token stream costs a few messages per second instead of one per token. Order is kept; a `reset` or `end` is never merged.
 * Flushes serialize, so batches arrive in order.
 */
export function coalescingLive(options: CoalescingOptions): LiveRunSink & { flush(): Promise<void>; stop(): Promise<void> } {
  const flushMs = options.flushMs ?? 50;
  const flushBytes = options.flushBytes ?? 4096;
  let pending: LiveRunEvent[] = [];
  let pendingBytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    if (batch.length === 0) return chain;
    chain = chain.then(() => options.send(batch)).catch((error: unknown) => options.onError?.(error));
    return chain;
  };

  return {
    publish(event) {
      const last = pending[pending.length - 1];
      if (event.type === 'run.text.delta' && last?.type === 'run.text.delta' && sameAttempt(last, event)) {
        pending[pending.length - 1] = { ...last, text: last.text + event.text };
      } else {
        pending.push(event);
      }
      if (event.type === 'run.text.delta') pendingBytes += Buffer.byteLength(event.text, 'utf8');
      // The end of a turn is the moment the consumer waits on, so it never sits in the buffer.
      if (pendingBytes >= flushBytes || event.type === 'run.text.end') void flush();
      else if (timer === undefined) timer = setTimeout(() => { void flush(); }, flushMs);
    },
    flush,
    async stop() { await flush(); },
  };
}
