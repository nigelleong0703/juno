import { describe, expect, it } from 'vitest';
import { createEventStream, type EventStreamScheduler } from '../http/sse.js';

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('event stream connection state', () => {
  it('is down while reconnecting and up again once a response opens', async () => {
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
    let call = 0;
    const fetcher = async (): Promise<Response> => {
      call += 1;
      if (call === 1) throw new Error('offline');
      // A live body that never closes: the stream stays connected.
      const body = new ReadableStream<Uint8Array>({ start() {} });
      return new Response(body, { status: 200 });
    };

    const stream = createEventStream({
      url: 'http://event-test/v1/events',
      getToken: () => 'token',
      fetch: fetcher,
      scheduler,
    });
    const seen: boolean[] = [];
    const unlisten = stream.subscribeConnection((next) => seen.push(next));
    expect(stream.isConnected()).toBe(true);

    const stop = stream.subscribe(() => {});
    await flush();
    expect(stream.isConnected()).toBe(false);
    expect(seen).toEqual([false]);

    const retry = queued as (() => void) | null;
    expect(retry).not.toBeNull();
    (retry as (() => void) | null)?.();
    await flush();
    expect(stream.isConnected()).toBe(true);
    expect(seen).toEqual([false, true]);

    unlisten();
    stop();
  });
});
