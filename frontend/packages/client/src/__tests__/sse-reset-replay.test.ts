import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../contracts.js';
import { createEventStream } from '../http/sse.js';

const encoder = new TextEncoder();

const frame = (id: number, status: 'idle' | 'working') =>
  `id: ${id}\n` +
  `data: ${JSON.stringify({ type: 'agent.status', agentId: 'agent-1', status })}\n\n`;

const streamOf = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const end = Date.now() + 2000;
  while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
};

describe('SSE reset recovery', () => {
  it('reports reset, clears replay dedupe, and accepts the same id from the new replay window', async () => {
    const delivered: AgentEvent[] = [];
    const attempts: Headers[] = [];
    let resets = 0;
    const fetcher = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      attempts.push(new Headers(init?.headers));
      if (attempts.length === 1) return new Response(streamOf(frame(7, 'idle') + 'event: reset\n\n'));
      return new Response(streamOf(frame(7, 'working')));
    };
    const stream = createEventStream({
      url: 'http://reset-test/v1/events',
      getToken: () => 'token',
      fetch: fetcher,
      reconnectDelayMs: 1,
    });
    const stopReset = stream.subscribeReset(() => {
      resets += 1;
    });
    const stop = stream.subscribe((event) => delivered.push(event));

    await waitFor(() => delivered.length === 2);
    expect(resets).toBe(1);
    expect(delivered.map((event) => (event.type === 'agent.status' ? event.status : ''))).toEqual([
      'idle',
      'working',
    ]);
    expect(attempts[1]!.has('Last-Event-ID')).toBe(false);

    stopReset();
    stop();
  });
});
