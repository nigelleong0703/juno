import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../contracts.js';
import { createHttpClient } from '../http/client.js';
import { createEventStream, type EventStreamScheduler } from '../http/sse.js';

const encoder = new TextEncoder();

const statusFrame = (id: number, status: 'idle' | 'working', agentId = 'stream-agent'): string =>
  `id: ${id}\r\ndata: ${JSON.stringify({ type: 'agent.status', agentId, status })}\r\n\r\n`;

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
};

interface Attempt {
  url: string;
  signal: RequestInit['signal'];
  headers: Headers;
}

const record = (input: string | URL | Request, init: RequestInit = {}): Attempt => ({
  url: String(input),
  signal: init.signal,
  headers: new Headers(init.headers),
});

/** A body stream that enqueues `chunks`; closes at once unless `close` is false (a live stream). */
const streamOf = (chunks: Uint8Array[], close = true): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (close) controller.close();
    },
  });

describe('HTTP event stream', () => {
  it('reassembles split UTF-8 frames, reconnects with Last-Event-ID and aborts on unsubscribe', async () => {
    const attempts: Attempt[] = [];
    const delivered: AgentEvent[] = [];
    const frame = statusFrame(11, 'idle', 'агент-泊');
    const bytes = encoder.encode(frame);
    // Split inside a multi-byte character so streaming decode is exercised.
    const cut = bytes.findIndex((byte, index) => index > 0 && (byte & 0xc0) === 0x80);

    const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      attempts.push(record(url, init));
      const chunks =
        attempts.length === 1
          ? [bytes.slice(0, cut), bytes.slice(cut, cut + 3), bytes.slice(cut + 3)]
          : [encoder.encode(statusFrame(12, 'working'))];
      return new Response(streamOf(chunks, attempts.length === 1), { status: 200 });
    };

    const stream = createEventStream({
      url: 'http://event-test/v1/events',
      getToken: () => 'stream-token',
      fetch: fetcher,
    });
    const stop = stream.subscribe((event) => delivered.push(event));

    await waitFor(() => delivered.length === 2);

    expect(attempts[0]?.url).toBe('http://event-test/v1/events');
    expect(attempts[0]?.headers.get('Authorization')).toBe('Bearer stream-token');
    expect(attempts[0]?.headers.get('Accept')).toBe('text/event-stream');
    expect(attempts[1]?.headers.get('Last-Event-ID')).toBe('11');
    expect(attempts[0]?.signal?.aborted).toBe(false);
    expect(delivered.map((event) => (event.type === 'agent.status' ? event.agentId : ''))).toEqual([
      'агент-泊',
      'stream-agent',
    ]);

    const live = attempts[attempts.length - 1];
    stop();
    expect(live?.signal?.aborted).toBe(true);

    // Nothing reconnect-related must fire after the last unsubscribe.
    const after = attempts.length;
    await flush();
    expect(attempts.length).toBe(after);
  });

  it('drops malformed and unknown frames, and an event:reset clears the resume cursor', async () => {
    const attempts: Attempt[] = [];
    const delivered: AgentEvent[] = [];
    let resets = 0;
    const first =
      statusFrame(7, 'idle') + 'data: {not json}\n\n' + 'data: {"type":"agent.teleported"}\n\n';

    const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      attempts.push(record(url, init));
      if (attempts.length === 1) {
        const body = streamOf([encoder.encode(first)]);
        return new Response(body, { status: 200 });
      }
      if (attempts.length === 2) {
        const body = streamOf([encoder.encode('event: reset\n\n')]);
        return new Response(body, { status: 200 });
      }
      return new Response(streamOf([encoder.encode(statusFrame(1, 'working'))], false), {
        status: 200,
      });
    };

    const stream = createEventStream({
      url: 'http://event-test/v1/events',
      getToken: () => 'stream-token',
      fetch: fetcher,
      onReset: () => {
        resets += 1;
      },
    });
    const stop = stream.subscribe((event) => delivered.push(event));

    await waitFor(() => delivered.length === 2);

    expect(delivered.map((event) => (event.type === 'agent.status' ? event.status : ''))).toEqual([
      'idle',
      'working',
    ]);
    expect(attempts[1]?.headers.get('Last-Event-ID')).toBe('7');
    // After a reset the client must restart from the beginning, not from its old cursor.
    expect(attempts[2]?.headers.has('Last-Event-ID')).toBe(false);
    // The reset is opaque to subscribers (not an AgentEvent) but reported to the caller.
    expect(resets).toBe(1);
    expect(delivered.every((event) => event.type === 'agent.status')).toBe(true);

    stop();
  });

  it('shares one connection across subscribers and closes it when the last leaves', async () => {
    const attempts: Attempt[] = [];
    const first: AgentEvent[] = [];
    const second: AgentEvent[] = [];

    const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      attempts.push(record(url, init));
      return new Response(streamOf([encoder.encode(statusFrame(3, 'working'))], false), {
        status: 200,
      });
    };

    const stream = createEventStream({
      url: 'http://event-test/v1/events',
      getToken: () => 'stream-token',
      fetch: fetcher,
    });
    const stopFirst = stream.subscribe((event) => first.push(event));
    const stopSecond = stream.subscribe((event) => second.push(event));

    await waitFor(() => first.length === 1 && second.length === 1);
    expect(attempts).toHaveLength(1);

    stopFirst();
    expect(attempts[0]?.signal?.aborted).toBe(false);
    expect(second).toHaveLength(1);

    stopSecond();
    expect(attempts[0]?.signal?.aborted).toBe(true);
  });

  it('backs off exponentially, caps the delay and resets after a healthy frame', async () => {
    const delays: number[] = [];
    const delivered: AgentEvent[] = [];
    let queued: (() => void) | null = null;
    let cancelled = 0;
    // The silence watchdog's timer is not part of the backoff under test: it gets its own handle.
    const IDLE = 1e9;
    const scheduler: EventStreamScheduler = {
      schedule: (handler, delayMs) => {
        if (delayMs === IDLE) return 'idle';
        delays.push(delayMs);
        queued = handler;
        return handler;
      },
      cancel: (handle) => {
        if (handle === 'idle') return;
        cancelled += 1;
        queued = null;
      },
    };

    const behaviour: Array<'reject' | 'frame'> = ['reject', 'reject', 'frame', 'reject', 'reject'];
    let call = 0;
    const fetcher = async (): Promise<Response> => {
      const mode = behaviour[call];
      call += 1;
      if (mode !== 'frame') throw new Error('offline');
      return new Response(streamOf([encoder.encode(statusFrame(5, 'idle'))]), { status: 200 });
    };

    const stream = createEventStream({
      url: 'http://event-test/v1/events',
      getToken: () => 'stream-token',
      fetch: fetcher,
      reconnectDelayMs: 100,
      maxReconnectDelayMs: 400,
      scheduler,
      idleTimeoutMs: IDLE,
    });
    const stop = stream.subscribe((event) => delivered.push(event));

    const fire = async (): Promise<void> => {
      const handler = queued;
      queued = null;
      expect(handler).not.toBeNull();
      if (handler) handler();
      await flush();
    };

    await flush();
    expect(delays).toEqual([100]);
    await fire();
    expect(delays).toEqual([100, 200]);
    await fire();
    expect(delivered).toHaveLength(1);
    expect(delays).toEqual([100, 200, 100]); // a delivered frame resets the backoff
    await fire();
    expect(delays).toEqual([100, 200, 100, 200]);
    await fire();
    expect(delays).toEqual([100, 200, 100, 200, 400]); // capped at maxReconnectDelayMs

    stop();
    expect(cancelled).toBe(1);
  });
});

describe('HTTP event stream starting cursor', () => {
  it('resumes from the cursor on the first connect and on a reconnect before any frame', async () => {
    const attempts: Attempt[] = [];
    const delivered: AgentEvent[] = [];
    let queued: (() => void) | null = null;
    const scheduler: EventStreamScheduler = {
      schedule: (handler) => {
        queued = handler;
        return handler;
      },
      cancel: () => {
        queued = null;
      },
    };
    const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      attempts.push(record(url, init));
      if (attempts.length === 1) throw new Error('offline'); // fails before any frame arrives
      return new Response(streamOf([encoder.encode(statusFrame(201, 'working'))], false), { status: 200 });
    };

    const stream = createEventStream({
      url: 'http://event-test/v1/events',
      getToken: () => 'stream-token',
      fetch: fetcher,
      initialCursor: () => Promise.resolve(200),
      scheduler,
    });
    const stop = stream.subscribe((event) => delivered.push(event));

    await waitFor(() => attempts.length === 1);
    expect(attempts[0]?.headers.get('Last-Event-ID')).toBe('200');

    const retry = queued as (() => void) | null;
    expect(retry).not.toBeNull();
    if (retry) retry();
    await waitFor(() => delivered.length === 1);
    expect(attempts[1]?.headers.get('Last-Event-ID')).toBe('200');
    stop();
  });

  it('createHttpClient fetches the cursor first, then streams from it with the same token', async () => {
    const calls: Attempt[] = [];
    const delivered: AgentEvent[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push(record(url, init));
      if (String(url).endsWith('/v1/events/cursor')) return Response.json({ after: 800 });
      return new Response(streamOf([encoder.encode(statusFrame(801, 'working'))], false), { status: 200 });
    };
    const client = createHttpClient({ baseUrl: 'http://event-test', getToken: () => 'tok', fetch: fetcher });
    const stop = client.subscribe((event) => delivered.push(event));
    await waitFor(() => delivered.length === 1);

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/v1/events/cursor', '/v1/events']);
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer tok');
    expect(calls[0]?.headers.has('Last-Event-ID')).toBe(false);
    expect(calls[1]?.headers.get('Last-Event-ID')).toBe('800');
    expect(calls[1]?.headers.get('Authorization')).toBe('Bearer tok');
    stop();
  });

  it('starts from the beginning when the cursor request fails', async () => {
    const attempts: Attempt[] = [];
    const delivered: AgentEvent[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      attempts.push(record(url, init));
      return new Response(streamOf([encoder.encode(statusFrame(3, 'idle'))], false), { status: 200 });
    };
    const stream = createEventStream({
      url: 'http://event-test/v1/events',
      getToken: () => 'stream-token',
      fetch: fetcher,
      initialCursor: () => Promise.reject(new Error('cursor unavailable')),
    });
    const stop = stream.subscribe((event) => delivered.push(event));
    await waitFor(() => delivered.length === 1);
    expect(attempts[0]?.headers.has('Last-Event-ID')).toBe(false);
    stop();
  });
});
