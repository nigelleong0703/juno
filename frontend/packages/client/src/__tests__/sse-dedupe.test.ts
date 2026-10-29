import { describe, expect, it } from 'vitest';
import { createEventStream } from '../http/sse.js';

const frame = (id: number, agentId: string): string => `id: ${id}\ndata: ${JSON.stringify({ type: 'agent.deleted', agentId })}\n\n`;

/** A response that delivers the given text and then ends, so the transport reconnects. */
function bodyThenEnd(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe('event stream dedupe', () => {
  it('delivers each event id once, even when a reconnect replays it', async () => {
    const delivered: string[] = [];
    let call = 0;
    const fetcher = async (): Promise<Response> => {
      call += 1;
      // The first connection delivers 1 and 2; the reconnect replays 2 and then sends 3.
      if (call === 1) return bodyThenEnd(frame(1, 'a') + frame(2, 'b'));
      if (call === 2) return bodyThenEnd(frame(2, 'b') + frame(3, 'c'));
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    };
    const stream = createEventStream({
      url: 'http://event-test/v1/events',
      getToken: () => 'token',
      fetch: fetcher,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    const stop = stream.subscribe((event) => {
      if (event.type === 'agent.deleted') delivered.push(event.agentId);
    });
    for (let i = 0; i < 50 && call < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    stop();
    expect(call).toBeGreaterThanOrEqual(3);
    expect(delivered).toEqual(['a', 'b', 'c']);
  });
});
