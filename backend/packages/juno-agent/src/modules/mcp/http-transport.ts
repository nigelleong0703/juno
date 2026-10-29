// Streamable-HTTP MCP transport: one POST per JSON-RPC message, a JSON or SSE response body, the
// session id echoed back on legacy requests, bounded bodies and timeouts, and matching by request id so
// an unrelated notification or a mismatched response never resolves the wrong call. Modern (2026-07-28)
// requests carry Mcp-Method / Mcp-Name routing headers and no session. listen() reads the long-lived
// notification streams: a modern subscriptions/listen, or the legacy GET stream.
import { guardedFetch } from '../tools/net/guardedFetch.js';
import { MCP_MODERN_VERSION, McpAuthError, McpProtocolError, buildNotification, buildRequest, encodeHeaderValue, parseFrame, parseResult, subscriptionParams } from './protocol.js';
import type { McpListenOptions, McpNotificationHandler, McpRequestOptions, McpTransport } from './transport.js';
import { platformKeyHeaders } from './platform-keys.js';
import { parseChallenge } from './challenge.js';

export interface HttpTransportOptions {
  url: string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  notifyTimeoutMs?: number;
  /** Bearer header source for OAuth-authorized servers; asked on every request, so refresh happens here. */
  authorize?: () => Promise<string>;
  /** Fixed extra headers (the owner's API key for a connector that takes one). */
  headers?: Record<string, string>;
}

const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_NOTIFY_TIMEOUT_MS = 5_000;

/** The next SSE frame boundary, tolerating both LF and CRLF line endings. */
function nextBoundary(buffer: string): { index: number; length: number } | null {
  const crlf = buffer.indexOf('\r\n\r\n');
  const lf = buffer.indexOf('\n\n');
  if (crlf < 0 && lf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function sseData(frame: string): string | null {
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return data.length === 0 ? null : data.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads SSE frames until `onData` returns true or the stream ends; aborting `signal` cancels the stream. */
async function readFrames(response: Response, signal: AbortSignal, maxBytes: number, onData: (data: string) => boolean): Promise<void> {
  const reader = response.body?.getReader();
  if (reader === undefined) return;
  const stop = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > maxBytes) throw new McpProtocolError(-32000, 'MCP stream frame exceeded the size bound');
      let boundary = nextBoundary(buffer);
      while (boundary !== null) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = sseData(frame);
        if (data !== null && onData(data)) return;
        boundary = nextBoundary(buffer);
      }
    }
  } finally {
    signal.removeEventListener('abort', stop);
    await reader.cancel().catch(() => undefined);
  }
}

export class HttpMcpTransport implements McpTransport {
  readonly kind = 'http';
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private modern = false;
  private closed = false;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly notifyTimeoutMs: number;
  private readonly authorize: (() => Promise<string>) | undefined;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: HttpTransportOptions) {
    this.url = options.url;
    this.fetchImpl = options.fetchImpl ?? guardedFetch;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.notifyTimeoutMs = options.notifyTimeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS;
    this.authorize = options.authorize;
    this.extraHeaders = options.headers ?? {};
  }

  get session(): string | undefined {
    return this.sessionId;
  }

  setProtocolVersion(version: string | undefined): void {
    this.protocolVersion = version;
    this.modern = version === MCP_MODERN_VERSION;
  }

  async request(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
    options: McpRequestOptions = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('MCP request timed out')), this.timeoutMs);
    const outer = options.signal;
    const onAbort = () => controller.abort(outer?.reason);
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await this.send(buildRequest(id, method, params), controller.signal, { ...this.routingHeaders(method, params), ...options.headers });
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) return parseResult(await this.readSse(response, id));
      return this.parseJsonResponse(await this.readBody(response), id);
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onAbort);
    }
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('MCP notification timed out')), this.notifyTimeoutMs);
    try {
      const response = await this.send(buildNotification(method, params), controller.signal);
      await response.body?.cancel().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Modern: a POST subscriptions/listen whose SSE response carries the acknowledgement and the opted-in
   * notifications until the server closes it or its own response arrives. Legacy (no filter): a GET for the
   * server's standalone stream, which a server without one answers 405 (resolves false).
   */
  async listen(options: McpListenOptions, onNotification: McpNotificationHandler, signal: AbortSignal): Promise<boolean> {
    if (this.closed || signal.aborted) return false;
    const modern = options.subscribe !== undefined;
    const init: RequestInit = modern
      ? {
          method: 'POST',
          headers: await this.headers(this.routingHeaders('subscriptions/listen', {})),
          body: buildRequest(options.id, 'subscriptions/listen', subscriptionParams(options.subscribe ?? {})),
        }
      : { method: 'GET', headers: { ...(await this.headers()), accept: 'text/event-stream' } };
    init.signal = signal;
    const response = await this.fetchImpl(this.url, init);
    const session = response.headers.get('mcp-session-id');
    if (session !== null && !this.modern) this.sessionId = session;
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpAuthError(response.status, parseChallenge(response.headers.get('www-authenticate')));
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !contentType.includes('text/event-stream')) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    await readFrames(response, signal, this.maxBytes, (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(data);
      } catch {
        return false;
      }
      if (!isRecord(frame)) return false;
      if (typeof frame.method === 'string' && frame.id === undefined) {
        onNotification(frame.method, isRecord(frame.params) ? frame.params : {});
        return false;
      }
      // The subscription's own response (its result or error) is the graceful end of a modern stream.
      return modern && frame.id !== undefined && String(frame.id) === String(options.id);
    });
    return true;
  }

  async close(): Promise<void> {
    const session = this.sessionId;
    this.closed = true;
    this.sessionId = undefined;
    if (session === undefined) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('MCP session delete timed out')), this.notifyTimeoutMs);
    try {
      // A server that cannot delete a session answers 405; the local session still ends either way.
      await this.fetchImpl(this.url, { method: 'DELETE', headers: { 'mcp-session-id': session }, signal: controller.signal });
    } catch {
      // ignore: a failed delete just means the session ends locally
    } finally {
      clearTimeout(timer);
    }
  }

  private async headers(routing: Record<string, string> = {}): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId !== undefined) headers['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion !== undefined) headers['mcp-protocol-version'] = this.protocolVersion;
    if (this.authorize !== undefined) headers.authorization = await this.authorize();
    return { ...headers, ...routing, ...this.extraHeaders, ...platformKeyHeaders(this.url) };
  }

  /** Modern requests name their method (and target) in headers so an intermediary can route without the body. */
  private routingHeaders(method: string, params: Record<string, unknown>): Record<string, string> {
    if (!this.modern) return {};
    const name = method === 'tools/call' || method === 'prompts/get' ? params['name'] : method === 'resources/read' ? params['uri'] : undefined;
    return { 'Mcp-Method': method, ...(typeof name === 'string' ? { 'Mcp-Name': encodeHeaderValue(name) } : {}) };
  }

  private async send(body: string, signal: AbortSignal | undefined, routing: Record<string, string> = {}): Promise<Response> {
    if (this.closed) throw new McpProtocolError(-32000, 'MCP transport is closed');
    const init: RequestInit = { method: 'POST', headers: await this.headers(routing), body };
    if (signal !== undefined) init.signal = signal;
    const response = await this.fetchImpl(this.url, init);
    // Modern servers mint no session, so one they send is neither stored nor echoed.
    const session = response.headers.get('mcp-session-id');
    if (session !== null && !this.modern) this.sessionId = session;
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpAuthError(response.status, parseChallenge(response.headers.get('www-authenticate')));
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpProtocolError(response.status, 'MCP server returned HTTP ' + String(response.status));
    }
    return response;
  }

  /** Only the response whose id matches this request resolves it; error frames must match too. */
  private parseJsonResponse(raw: string, id: number | string): unknown {
    const frame = parseFrame(raw);
    if (frame.id === undefined || String(frame.id) !== String(id)) {
      throw new McpProtocolError(-32000, 'MCP response id mismatch for request ' + String(id));
    }
    if (frame.error !== undefined) throw new McpProtocolError(frame.error.code, frame.error.message);
    return frame.result;
  }

  private async readBody(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) return '';
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > this.maxBytes) throw new McpProtocolError(-32000, 'MCP response exceeded the size bound');
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private async readSse(response: Response, id: number | string): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) throw new McpProtocolError(-32700, 'MCP SSE response had no body');
    const decoder = new TextDecoder();
    let buffer = '';
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > this.maxBytes) throw new McpProtocolError(-32000, 'MCP response exceeded the size bound');
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = nextBoundary(buffer);
        while (boundary !== null) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          const data = sseData(frame);
          if (data !== null) {
            const parsed = parseFrame(data);
            if (String(parsed.id) === String(id) && parsed.error !== undefined) {
              throw new McpProtocolError(parsed.error.code, parsed.error.message);
            }
            if (parsed.id !== undefined && String(parsed.id) === String(id)) return data;
          }
          boundary = nextBoundary(buffer);
        }
      }
    } finally {
      // Release the stream as soon as the matching response arrives, instead of waiting for it to end.
      await reader.cancel().catch(() => undefined);
    }
    throw new McpProtocolError(-32000, 'MCP SSE response ended before the matching message');
  }
}
