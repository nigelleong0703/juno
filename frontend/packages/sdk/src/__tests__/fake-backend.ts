/**
 * A fake Juno server for the SDK tests: JSON routes keyed by `METHOD /path`, plus one live
 * `GET /v1/events` stream the test can push frames into. It drives the real client transport and SSE
 * code through the injected fetch, the same path `packages/client` tests use.
 */

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

export type Route = (call: RecordedCall) => Response | Promise<Response>;

export interface FakeBackend {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
  /** Resolves once the SDK has opened the live event stream. Emit only after this. */
  streamOpen: Promise<void>;
  /** Pushes one `AgentEvent` frame to every open stream. */
  emit(event: unknown): void;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export function fakeBackend(routes: Record<string, Route>): FakeBackend {
  const encoder = new TextEncoder();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const calls: RecordedCall[] = [];
  let frameId = 1;
  let markOpen: () => void = () => {};
  const streamOpen = new Promise<void>((resolve) => {
    markOpen = resolve;
  });

  const openStream = (): Response => {
    let own: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        own = controller;
        streams.add(controller);
        markOpen();
      },
      cancel() {
        if (own) streams.delete(own);
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/v1/events') return openStream();
    if (method === 'GET' && url.pathname === '/v1/events/cursor') return json({ after: 0 });

    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const call: RecordedCall = { method, path: url.pathname + url.search, body };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return apiError(404, 'NOT_FOUND', `no fake route for ${method} ${url.pathname}`);
    return route(call);
  };

  const emit = (event: unknown): void => {
    const frame = encoder.encode(`id: ${frameId}\ndata: ${JSON.stringify(event)}\n\n`);
    frameId += 1;
    for (const controller of streams) {
      try {
        controller.enqueue(frame);
      } catch {
        streams.delete(controller);
      }
    }
  };

  return { fetch, calls, streamOpen, emit };
}
