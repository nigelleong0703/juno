// Responses-over-WebSocket transport for OpenAI's own endpoint (ChatGPT sign-in and API keys).
//
// It is a `fetch` replacement handed to pi-ai: pi-ai builds the very same request body it would POST,
// this module sends it as a `response.create` frame on a socket kept per (session, token) and hands the
// frames back as the SSE stream the OpenAI client already parses. Nothing above it changes.
//
// The gain is the delta: when the next request is exactly the previous input + the previous output + new
// items, only the new items go out with `previous_response_id` (the server keeps the connection-local
// state even with store:false), which is what makes follow-up steps start in ~2 s instead of 3-5 s.
// Anything else (pruning batch, compaction, other model/tools/instructions, a new socket) sends the full
// input, so a delta can only ever be a pure shortcut. See docs/BACKEND.md section 3.6.
import { createHash } from 'node:crypto';
import WebSocket from 'ws';

export interface WsCallInfo {
  transport: 'ws' | 'http';
  /** True when only new items were sent with previous_response_id. */
  delta: boolean;
  deltaItems?: number;
  /** Why a WebSocket attempt was given up for HTTP (no content, no credentials). */
  fallback?: string;
}

export interface WsCall {
  fetch: typeof fetch;
  info(): WsCallInfo;
}

export interface ResponsesWsOptions {
  idleMs?: number;
  connectTimeoutMs?: number;
  /** The socket URL for a request URL, or undefined when this endpoint is not served over WebSocket. */
  endpoint?: (requestUrl: string) => string | undefined;
}

type Item = Record<string, unknown>;

/** What the server holds for the last finished response on one socket. */
interface SocketState {
  responseId: string;
  /** Hash of the canonical request fields other than input (model, instructions, tools, reasoning, ...). */
  rest: string;
  /** Hash of each input item the response was produced from. */
  inputHashes: string[];
  /** The output items the response produced. */
  output: Item[];
}

interface Entry {
  socket: WebSocket;
  tokenHash: string;
  busy: boolean;
  state: SocketState | undefined;
  idle: NodeJS.Timeout | undefined;
}

const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_CONNECT_MS = 10_000;
/** After a socket failure the session stays on HTTP for this long, so a retry never meets the same fault. */
const HTTP_ONLY_MS = 120_000;
const FORWARDED_HEADERS = /^(authorization|user-agent|session[-_]id|thread-id|x-client-request-id|openai-.*|chatgpt-.*)$/i;
const TERMINAL = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error']);

/** Only OpenAI's own Responses endpoint has the socket; every other endpoint keeps plain HTTP. */
export function defaultEndpoint(requestUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'api.openai.com' || !url.pathname.endsWith('/responses')) return undefined;
  return 'wss://' + url.host + url.pathname;
}

function isRecord(value: unknown): value is Item {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (!isRecord(value)) return JSON.stringify(value) ?? 'null';
  const record = value;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}

function hashOf(value: unknown): string {
  return createHash('sha1').update(canonical(value)).digest('base64');
}

function textOf(item: Item): string {
  const content = item.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
}

/**
 * Whether a replayed input item stands for an output item the server produced. pi-ai rebuilds items from
 * its transcript (adds status/annotations, may drop an unusable id), so identity fields decide, not bytes.
 */
export function sameOutputItem(output: Item, replayed: Item): boolean {
  const type = output.type ?? 'message';
  if ((replayed.type ?? 'message') !== type) return false;
  if (type === 'message') return output.role === replayed.role && textOf(output) === textOf(replayed) && (output.id === undefined || replayed.id === undefined || output.id === replayed.id);
  if (type === 'function_call') return output.call_id === replayed.call_id && output.name === replayed.name && output.arguments === replayed.arguments;
  if (type === 'reasoning') return output.id === replayed.id && (output.encrypted_content === undefined || output.encrypted_content === replayed.encrypted_content);
  return output.id !== undefined && output.id === replayed.id;
}

export type DeltaDecision = { delta: false } | { delta: true; previousResponseId: string; input: Item[] };

/** The delta rule: next input must be previous input + previous output + at least one new item, everything else equal. */
export function decideDelta(state: SocketState | undefined, rest: string, input: Item[]): DeltaDecision {
  if (state === undefined || state.rest !== rest) return { delta: false };
  const prefix = state.inputHashes.length;
  if (input.length < prefix + state.output.length + 1) return { delta: false };
  for (let i = 0; i < prefix; i++) {
    if (hashOf(input[i]) !== state.inputHashes[i]) return { delta: false };
  }
  for (let j = 0; j < state.output.length; j++) {
    const replayed = input[prefix + j];
    const produced = state.output[j];
    if (replayed === undefined || produced === undefined || !sameOutputItem(produced, replayed)) return { delta: false };
  }
  return { delta: true, previousResponseId: state.responseId, input: input.slice(prefix + state.output.length) };
}

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function isItems(value: unknown): value is Item[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'object' && item !== null);
}

interface Parsed {
  rest: string;
  input: Item[];
  body: Record<string, unknown>;
}

function parseBody(body: unknown): Parsed | undefined {
  if (typeof body !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const record = parsed;
  if (!isItems(record.input) || record.previous_response_id !== undefined) return undefined;
  const { input, stream: _stream, background: _background, ...others } = record;
  return { rest: hashOf(others), input: record.input, body: { ...others } };
}

export interface ResponsesWsTransport {
  /** The fetch for one model call; `httpFetch` is the existing path used for anything not served by the socket. */
  forCall(call: { sessionKey: string | undefined; httpFetch: typeof fetch | undefined }): WsCall;
  close(): void;
}

export function createResponsesWsTransport(options: ResponsesWsOptions = {}): ResponsesWsTransport {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const connectMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_MS;
  const endpointOf = options.endpoint ?? defaultEndpoint;
  const sockets = new Map<string, Entry>();
  const httpOnlyUntil = new Map<string, number>();

  function drop(key: string, entry: Entry): void {
    if (entry.idle) clearTimeout(entry.idle);
    if (sockets.get(key) === entry) sockets.delete(key);
    entry.socket.removeAllListeners();
    entry.socket.on('error', () => undefined);
    entry.socket.terminate();
  }

  function armIdle(key: string, entry: Entry): void {
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = setTimeout(() => drop(key, entry), idleMs);
    entry.idle.unref();
  }

  function connect(url: string, headers: Record<string, string>): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers, handshakeTimeout: connectMs });
      socket.once('open', () => resolve(socket));
      socket.once('error', (error) => reject(error));
      socket.once('unexpected-response', (_req, res) => {
        res.resume();
        reject(new Error('handshake ' + String(res.statusCode)));
      });
    });
  }

  function forCall(call: { sessionKey: string | undefined; httpFetch: typeof fetch | undefined }): WsCall {
    let info: WsCallInfo = { transport: 'http', delta: false };
    const http: typeof fetch = (input, init) => (call.httpFetch ?? fetch)(input, init);

    async function viaSocket(key: string, url: string, init: RequestInit, parsed: Parsed): Promise<Response | string> {
      const signal = init.signal ?? undefined;
      const headers = new Headers(init.headers);
      const authorization = headers.get('authorization');
      if (authorization === null) return 'no-authorization';
      const forwarded: Record<string, string> = {};
      headers.forEach((value, name) => {
        if (FORWARDED_HEADERS.test(name)) forwarded[name] = value;
      });
      const tokenHash = hashOf(authorization);
      let entry = sockets.get(key);
      if (entry?.busy) return 'busy';
      if (entry !== undefined && (entry.tokenHash !== tokenHash || entry.socket.readyState !== WebSocket.OPEN)) {
        drop(key, entry);
        entry = undefined;
      }
      signal?.throwIfAborted();
      if (entry === undefined) {
        const socket = await connect(url, forwarded);
        entry = { socket, tokenHash, busy: false, state: undefined, idle: undefined };
        sockets.set(key, entry);
        // While idle nobody else listens: a server-side close or error just forgets the socket.
        const created = entry;
        socket.on('error', () => undefined);
        socket.on('close', () => drop(key, created));
      }
      const live = entry;
      if (live.idle) clearTimeout(live.idle);
      live.busy = true;
      const decision = decideDelta(live.state, parsed.rest, parsed.input);
      const frame = JSON.stringify({
        type: 'response.create',
        ...parsed.body,
        input: decision.delta ? decision.input : parsed.input,
        ...(decision.delta ? { previous_response_id: decision.previousResponseId } : {}),
      });
      live.state = undefined;
      const inputHashes = parsed.input.map(hashOf);
      const encoder = new TextEncoder();
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      let started = false;
      let finished = false;
      let responseId = '';
      // The finished output items, from output_item.done (response.completed may carry them empty).
      const produced = new Map<number, Item>();

      const finish = (error?: Error): void => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        live.socket.off('message', onMessage);
        live.socket.off('close', onClose);
        live.socket.off('error', onError);
        live.busy = false;
        if (error) {
          drop(key, live);
          httpOnlyUntil.set(key, Date.now() + HTTP_ONLY_MS);
          if (started) streamController?.error(error);
        } else {
          armIdle(key, live);
          streamController?.close();
        }
      };
      let firstEvent: ((value: Response | string) => void) | undefined;
      const first = new Promise<Response | string>((resolve) => {
        firstEvent = resolve;
      });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          // The consumer gave up (stop): the response is still running upstream, so the socket cannot be reused.
          if (!finished) {
            finished = true;
            signal?.removeEventListener('abort', onAbort);
            drop(key, live);
          }
        },
      });

      function onAbort(): void {
        const error = abortError();
        if (!started) {
          finished = true;
          drop(key, live);
          firstEvent?.('aborted');
          return;
        }
        finish(error);
        // An abort is the user's stop, not a socket fault: do not push the session onto HTTP.
        httpOnlyUntil.delete(key);
      }
      function onError(error: Error): void {
        if (!started) {
          finished = true;
          drop(key, live);
          httpOnlyUntil.set(key, Date.now() + HTTP_ONLY_MS);
          firstEvent?.('socket-error');
          return;
        }
        finish(error);
      }
      function onClose(): void {
        onError(new Error('Responses socket closed mid-response'));
      }
      function onMessage(raw: WebSocket.RawData): void {
        const text = raw.toString();
        let event: { type?: string; output_index?: number; item?: unknown; response?: { id?: string; output?: unknown } };
        try {
          event = JSON.parse(text);
        } catch {
          return;
        }
        const type = event.type ?? 'message';
        if (!started) {
          if (type === 'error') {
            // An error before any output (stale previous_response_id, 4xx, rate limit) is retried over HTTP,
            // whose status-coded error the harness already classifies.
            finished = true;
            signal?.removeEventListener('abort', onAbort);
            live.socket.off('message', onMessage);
            live.socket.off('close', onClose);
            live.socket.off('error', onError);
            live.busy = false;
            drop(key, live);
            firstEvent?.('error-event');
            return;
          }
          started = true;
          firstEvent?.(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
        }
        if (type === 'response.created' && typeof event.response?.id === 'string') responseId = event.response.id;
        streamController?.enqueue(encoder.encode('event: ' + type + '\ndata: ' + text + '\n\n'));
        if (type === 'response.output_item.done' && typeof event.output_index === 'number' && isRecord(event.item)) produced.set(event.output_index, event.item);
        if (!TERMINAL.has(type)) return;
        if (type === 'response.completed' && responseId !== '') {
          const output = [...produced.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
          live.state = { responseId, rest: parsed.rest, inputHashes, output: output.length > 0 ? output : isItems(event.response?.output) ? event.response.output : [] };
        }
        finish();
      }

      signal?.addEventListener('abort', onAbort, { once: true });
      live.socket.on('message', onMessage);
      live.socket.on('close', onClose);
      live.socket.on('error', onError);
      live.socket.send(frame, (error) => {
        if (error) onError(error);
      });
      const result = await first;
      if (result === 'aborted') throw abortError();
      if (typeof result !== 'string') {
        info = { transport: 'ws', delta: decision.delta, ...(decision.delta ? { deltaItems: decision.input.length } : {}) };
      }
      return result;
    }

    const wsFetch: typeof fetch = async (input, init) => {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const key = call.sessionKey;
      const url = endpointOf(requestUrl);
      const parsed = init?.method?.toUpperCase() === 'POST' ? parseBody(init.body) : undefined;
      if (key === undefined || url === undefined || parsed === undefined || init === undefined) return http(input, init);
      if ((httpOnlyUntil.get(key) ?? 0) > Date.now()) {
        info = { transport: 'http', delta: false, fallback: 'cooldown' };
        return http(input, init);
      }
      let outcome: Response | string;
      try {
        outcome = await viaSocket(key, url, init, parsed);
      } catch (error) {
        if (init.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        httpOnlyUntil.set(key, Date.now() + HTTP_ONLY_MS);
        outcome = 'connect:' + (error instanceof Error ? error.message.slice(0, 80) : 'failed');
      }
      if (typeof outcome !== 'string') return outcome;
      info = { transport: 'http', delta: false, fallback: outcome };
      return http(input, init);
    };

    return { fetch: wsFetch, info: () => info };
  }

  return {
    forCall,
    close() {
      for (const [key, entry] of [...sockets]) drop(key, entry);
    },
  };
}
