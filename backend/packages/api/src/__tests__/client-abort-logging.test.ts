/**
 * Client disconnects are expected: when a browser drops an SSE stream (for example on logout) the
 * gateway aborts the upstream body and the handler surfaces an AbortError. That must not be logged
 * as a server error with a stack. Any other failure keeps the error log and the 500 response.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const logger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@agent-desktop/log', () => ({
  createLogger: () => logger,
}));

import { createApiApp } from '../server.js';
import type { ApiAuth } from '../server.js';

const auth: ApiAuth = {
  info: { mode: 'account', providers: ['credential'] },
  handle: async () => new Response('auth', { status: 200 }),
  resolve: async () => null,
};

/** A gateway whose test route throws `failure` (after an optional side effect, such as an abort). */
function appThrowing(failure: () => unknown): ReturnType<typeof createApiApp> {
  const app = createApiApp({ auth, agentdUrl: 'http://127.0.0.1:8788', internalToken: 'service-token' });
  app.get('/test/fail', () => {
    throw failure();
  });
  return app;
}

describe('client-abort error logging', () => {
  beforeEach(() => {
    logger.error.mockClear();
    logger.debug.mockClear();
  });

  it('treats any error raised after the request signal aborted as a client disconnect', async () => {
    const controller = new AbortController();
    const app = appThrowing(() => {
      controller.abort();
      return new Error('stream closed by peer');
    });
    const res = await app.request('/test/fail', { signal: controller.signal });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(499);
  });

  it('keeps error logging and the 500 response for other failures', async () => {
    const boom = new Error('database exploded');
    const app = appThrowing(() => boom);
    const res = await app.request('/test/fail');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[0]).toMatchObject({ err: boom });
    expect(logger.debug).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'database exploded' } });
  });
});

describe('E56: forwarded body after a client disconnect', () => {
  it('ends the forwarded stream quietly when the client aborted mid-body', async () => {
    const { quietOnClientAbort } = await import('../proxy.js');
    const client = new AbortController();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: one\n\n'));
      },
      pull(controller) {
        client.abort();
        controller.error(new DOMException('This operation was aborted', 'AbortError'));
      },
    });
    const text = await new Response(quietOnClientAbort(upstream, client.signal)).text();
    expect(text).toBe('data: one\n\n');
  });

  it('still errors the stream for a non-abort upstream failure', async () => {
    const { quietOnClientAbort } = await import('../proxy.js');
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('upstream reset'));
      },
    });
    await expect(new Response(quietOnClientAbort(upstream, new AbortController().signal)).text()).rejects.toThrow('upstream reset');
  });
});
