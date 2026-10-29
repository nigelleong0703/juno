import { describe, expect, it } from 'vitest';
import { createEventStream, type EventStreamScheduler } from '../http/sse.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Timers held by delay so the test fires exactly the one it means. */
function fakeScheduler() {
  const timers = new Map<symbol, { handler: () => void; delayMs: number }>();
  const scheduler: EventStreamScheduler = {
    schedule: (handler, delayMs) => {
      const id = Symbol('timer');
      timers.set(id, { handler, delayMs });
      return id;
    },
    cancel: (handle) => {
      timers.delete(handle as symbol);
    },
  };
  const fire = (delayMs: number): boolean => {
    for (const [id, timer] of timers) {
      if (timer.delayMs !== delayMs) continue;
      timers.delete(id);
      timer.handler();
      return true;
    }
    return false;
  };
  return { scheduler, fire, pending: () => [...timers.values()].map((t) => t.delayMs) };
}

const frame = (id: number) =>
  new TextEncoder().encode(`id: ${id}\ndata: ${JSON.stringify({ type: 'agent.deleted', agentId: 'agt-1' })}\n\n`);

describe('event stream silence watchdog', () => {
  it('drops a stream that goes silent and resumes from the cursor', async () => {
    const { scheduler, fire, pending } = fakeScheduler();
    const lastEventIds: Array<string | null> = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      lastEventIds.push(new Headers(init?.headers).get('Last-Event-ID'));
      // One event, then silence forever: what a client sees behind a proxy after the server went away.
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(frame(41)); } });
      return new Response(body, { status: 200 });
    };
    const stream = createEventStream({ url: 'http://event-test/v1/events', getToken: () => 't', fetch: fetcher, scheduler, idleTimeoutMs: 45_000 });
    const types: string[] = [];
    const stop = stream.subscribe((event) => types.push(event.type));
    await flush();
    expect(types).toEqual(['agent.deleted']);
    expect(pending()).toContain(45_000);

    expect(fire(45_000)).toBe(true); // silent past the limit
    await flush();
    expect(stream.isConnected()).toBe(false);
    const retry = pending().find((delay) => delay !== 45_000);
    expect(retry).toBeDefined();
    fire(retry as number);
    await flush();
    expect(lastEventIds).toEqual([null, '41']);
    expect(stream.isConnected()).toBe(true);
    stop();
  });

  it('keeps a stream that only sends heartbeats', async () => {
    const { scheduler, fire, pending } = fakeScheduler();
    let calls = 0;
    let push: ((chunk: Uint8Array) => void) | null = null;
    const fetcher = async (): Promise<Response> => {
      calls += 1;
      const body = new ReadableStream<Uint8Array>({ start(controller) { push = (chunk) => controller.enqueue(chunk); } });
      return new Response(body, { status: 200 });
    };
    const stream = createEventStream({ url: 'http://event-test/v1/events', getToken: () => 't', fetch: fetcher, scheduler, idleTimeoutMs: 45_000 });
    const stop = stream.subscribe(() => {});
    await flush();
    (push as ((chunk: Uint8Array) => void) | null)?.(new TextEncoder().encode(': heartbeat\n\n'));
    await flush();
    // The heartbeat re-armed the watchdog: exactly one live idle timer, and no reconnect happened.
    expect(pending().filter((delay) => delay === 45_000)).toHaveLength(1);
    expect(calls).toBe(1);
    expect(stream.isConnected()).toBe(true);
    void fire;
    stop();
  });
});
