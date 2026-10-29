// Shared fixture for the PH7 MCP suites: a real HTTP server that speaks streamable-transport JSON
// and SSE, plus in-process helpers. Kept outside the *.test.ts glob so the pinned entry composes
// the suites without registering them twice.
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { ToolContext, WakeEvent } from '../../../contracts/index.js';
import type { McpToolOutcome, SandboxStdioBridge, SandboxStdioChannel } from '../index.js';

export const NOW = '2026-10-08T00:00:00.000Z';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ServerState {
  instructions?: string;
  sessions: string[];
  protocolVersions: string[];
  cancelled: number[];
  /** The name of every tools/call the server received, in order. */
  calls: string[];
}

export function newState(): ServerState {
  return { sessions: [], protocolVersions: [], cancelled: [], calls: [] };
}

const TOOLS = [
  { name: 'echo', description: 'Echo the text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'big', description: 'Large result' },
  { name: 'fail', description: 'Always errors' },
  { name: 'slow', description: 'Never returns' },
  { name: 'image', description: 'Returns an image' },
  { name: 'structured', description: 'Returns structured content only' },
  { name: 'audio', description: 'Returns unsupported audio' },
  { name: 'huge', description: 'Returns a large text result' },
  { name: 'oversized', description: 'Schema exceeds the bound', inputSchema: { type: 'object', properties: { blob: { type: 'string', description: 'x'.repeat(20000) } } } },
];

/** The fixture MCP server: real JSON-RPC dispatch shared by the HTTP and stdio paths. */
export function handleMessage(
  message: Record<string, unknown>,
  state: ServerState,
  pages = false,
): Record<string, unknown> | null {
  const id = message.id;
  const method = message.method;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.2.3' }, ...(state.instructions === undefined ? {} : { instructions: state.instructions }) },
    };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'notifications/cancelled') {
    const params = isRecord(message.params) ? message.params : {};
    if (typeof params.requestId === 'number') state.cancelled.push(params.requestId);
    return null;
  }
  if (method === 'tools/list') {
    const params = isRecord(message.params) ? message.params : {};
    if (pages && params.cursor === 'p2') {
      return { jsonrpc: '2.0', id, result: { tools: [{ name: 'beta', description: 'Second page' }] } };
    }
    if (pages) return { jsonrpc: '2.0', id, result: { tools: [TOOLS[0]], nextCursor: 'p2' } };
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const params = isRecord(message.params) ? message.params : {};
    const name = params.name;
    const args = isRecord(params.arguments) ? params.arguments : {};
    state.calls.push(String(name));
    if (name === 'echo') return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'echo:' + String(args.text ?? '') }] } };
    if (name === 'big') return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Z'.repeat(30000) }] } };
    if (name === 'slow') return { slow: true };
    if (name === 'image') return { jsonrpc: '2.0', id, result: { content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] } };
    if (name === 'structured') return { jsonrpc: '2.0', id, result: { content: [], structuredContent: { verdict: 'ok', n: 3 } } };
    if (name === 'audio') return { jsonrpc: '2.0', id, result: { content: [{ type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }] } };
    if (name === 'huge') return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'H'.repeat(96000) }] } };
    if (name === 'fail') return { jsonrpc: '2.0', id, error: { code: -32001, message: 'fixture tool failure' } };
    return { jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool ' + String(name) } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } };
}

export interface Fixture {
  url: string;
  sseUrl: string;
  authUrl: string;
  errorUrl: string;
  wrongIdUrl: string;
  crlfUrl: string;
  openUrl: string;
  hangUrl: string;
  bigUrl: string;
  pagesUrl: string;
  slowListUrl: string;
  state: ServerState;
  close(): Promise<void>;
}

export async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

function sse(response: ServerResponse, payload: string, crlf = false, keepOpen = false): void {
  response.setHeader('content-type', 'text/event-stream');
  const frame = crlf ? 'event: message\r\ndata: ' + payload + '\r\n\r\n' : 'event: message\ndata: ' + payload + '\n\n';
  response.write(frame);
  if (!keepOpen) response.end();
}

export async function respond(request: IncomingMessage, response: ServerResponse, state: ServerState): Promise<void> {
  const url = request.url ?? '';
  if (url === '/mcp-error') {
    response.statusCode = 500;
    response.end('boom');
    return;
  }
  if (url === '/mcp-auth') {
    response.statusCode = 401;
    response.end('unauthorized');
    return;
  }
  if ((request.method ?? 'POST') !== 'POST') {
    // A session DELETE has no body; the local session still ends either way.
    response.statusCode = 204;
    response.end();
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(request));
  } catch {
    response.statusCode = 400;
    response.end();
    return;
  }
  if (!isRecord(parsed)) {
    response.statusCode = 400;
    response.end();
    return;
  }
  const session = request.headers['mcp-session-id'];
  if (typeof session === 'string') state.sessions.push(session);
  const version = request.headers['mcp-protocol-version'];
  if (typeof version === 'string') state.protocolVersions.push(version);
  if (url === '/mcp-slow-list' && parsed.method === 'tools/list') return; // hold discovery open
  if (url === '/mcp-hang' && parsed.method === 'notifications/cancelled') {
    const params = isRecord(parsed.params) ? parsed.params : {};
    if (typeof params.requestId === 'number') state.cancelled.push(params.requestId);
    return; // observed, but the server never answers the notification
  }
  const message = handleMessage(parsed, state, url === '/mcp-pages');
  if (message === null) {
    response.statusCode = 202;
    response.end();
    return;
  }
  if (message.slow === true) return; // hold the request open until the client cancels it
  if (url === '/mcp-wrongid' && parsed.method !== 'initialize' && typeof parsed.id === 'number') {
    message.id = parsed.id + 1000;
  }
  const payload = JSON.stringify(message);
  if (url === '/mcp-big' && parsed.method === 'tools/call') {
    sse(response, JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { content: [{ type: 'text', text: 'A'.repeat(50000) }] } }));
    return;
  }
  if (url === '/mcp-sse') {
    sse(response, payload);
    return;
  }
  if (url === '/mcp-crlf') {
    sse(response, payload, true);
    return;
  }
  if (url === '/mcp-open') {
    sse(response, payload, false, true);
    return;
  }
  response.setHeader('content-type', 'application/json');
  if (parsed.method === 'initialize') response.setHeader('mcp-session-id', 'sess-fixture-1');
  response.end(payload);
}

export async function startFixture(): Promise<Fixture> {
  const state = newState();
  const server = createServer((request, response) => {
    void respond(request, response, state);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const base = 'http://127.0.0.1:' + String(port);
  return {
    url: base + '/mcp',
    sseUrl: base + '/mcp-sse',
    authUrl: base + '/mcp-auth',
    errorUrl: base + '/mcp-error',
    wrongIdUrl: base + '/mcp-wrongid',
    crlfUrl: base + '/mcp-crlf',
    openUrl: base + '/mcp-open',
    hangUrl: base + '/mcp-hang',
    bigUrl: base + '/mcp-big',
    pagesUrl: base + '/mcp-pages',
    slowListUrl: base + '/mcp-slow-list',
    state,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

export function fakeStdioBridge(): SandboxStdioBridge {
  const state = newState();
  return {
    async open(): Promise<SandboxStdioChannel> {
      let handler: ((line: string) => void) | undefined;
      return {
        send(line: string): void {
          const parsed: unknown = JSON.parse(line);
          if (!isRecord(parsed)) return;
          const message = handleMessage(parsed, state);
          if (message === null || message.slow === true) return;
          queueMicrotask(() => handler?.(JSON.stringify(message)));
        },
        onMessage(next: (line: string) => void): void {
          handler = next;
        },
        async close(): Promise<void> {},
      };
    },
  };
}

/** A stdio bridge that answers with a fixed marker, so a test can tell which agent's session ran. */
export function markerStdioBridge(marker: string): SandboxStdioBridge {
  return {
    async open(): Promise<SandboxStdioChannel> {
      let handler: ((line: string) => void) | undefined;
      return {
        send(line: string): void {
          const parsed: unknown = JSON.parse(line);
          if (!isRecord(parsed)) return;
          const id = parsed.id;
          const method = parsed.method;
          let message: Record<string, unknown> | null = null;
          if (method === 'initialize') {
            message = { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'marker', version: '1' } } };
          } else if (method === 'tools/list') {
            message = { jsonrpc: '2.0', id, result: { tools: [{ name: 'echo', description: 'marker echo' }] } };
          } else if (method === 'tools/call') {
            message = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: marker }] } };
          } else if (method === 'server/discover') {
            // A legacy server answers the modern probe with method-not-found, which keeps the connect on initialize.
            message = { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } };
          }
          if (message === null) return;
          queueMicrotask(() => handler?.(JSON.stringify(message)));
        },
        onMessage(next: (line: string) => void): void {
          handler = next;
        },
        async close(): Promise<void> {},
      };
    },
  };
}

/** A stdio bridge that answers discovery but never a call, exposing its exit hook for a test. */
export function silentStdioBridge(): { bridge: SandboxStdioBridge; fireExit: () => Promise<void> } {
  let exit: (() => void) | undefined;
  const bridge: SandboxStdioBridge = {
    async open(): Promise<SandboxStdioChannel> {
      let handler: ((line: string) => void) | undefined;
      return {
        send(line: string): void {
          const parsed: unknown = JSON.parse(line);
          if (!isRecord(parsed)) return;
          const id = parsed.id;
          const method = parsed.method;
          if (method === 'initialize') {
            queueMicrotask(() => handler?.(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'silent', version: '1' } } })));
          } else if (method === 'tools/list') {
            queueMicrotask(() => handler?.(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [{ name: 'echo', description: 'silent echo' }] } })));
          } else if (method === 'server/discover') {
            queueMicrotask(() => handler?.(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })));
          }
        },
        onMessage(next: (line: string) => void): void {
          handler = next;
        },
        onExit(next: () => void): void {
          exit = next;
        },
        async close(): Promise<void> {},
      };
    },
  };
  return {
    bridge,
    fireExit: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      exit?.();
    },
  };
}

/** A stdio bridge that counts opens and id-bearing request sends, optionally stalling its open. */
export function countingStdioBridge(options: { openDelayMs?: number } = {}): {
  bridge: SandboxStdioBridge;
  counts: { opens: number; requests: number };
} {
  const counts = { opens: 0, requests: 0 };
  const bridge: SandboxStdioBridge = {
    async open(): Promise<SandboxStdioChannel> {
      counts.opens += 1;
      if ((options.openDelayMs ?? 0) > 0) await new Promise((resolve) => setTimeout(resolve, options.openDelayMs));
      let handler: ((line: string) => void) | undefined;
      return {
        send(line: string): void {
          const parsed: unknown = JSON.parse(line);
          if (!isRecord(parsed)) return;
          if (parsed.id !== undefined) counts.requests += 1;
          const id = parsed.id;
          const method = parsed.method;
          let message: Record<string, unknown> | null = null;
          if (method === 'initialize') message = { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'counted', version: '1' } } };
          else if (method === 'tools/list') message = { jsonrpc: '2.0', id, result: { tools: [{ name: 'echo', description: 'counted echo' }] } };
          else if (method === 'tools/call') message = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'counted' }] } };
          else if (method === 'server/discover') message = { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } };
          if (message === null) return;
          queueMicrotask(() => handler?.(JSON.stringify(message)));
        },
        onMessage(next: (line: string) => void): void {
          handler = next;
        },
        async close(): Promise<void> {},
      };
    },
  };
  return { bridge, counts };
}

export function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate() || Date.now() > deadline) resolve();
      else setTimeout(tick, 10);
    };
    tick();
  });
}

export function textOf(outcome: McpToolOutcome): string {
  return outcome.text;
}

export function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  const part = result.content[0];
  return part !== undefined && part.type === 'text' && typeof part.text === 'string' ? part.text : '';
}

export function toolContext(): ToolContext {
  const wake: WakeEvent = {
    id: 'wke-1',
    ownerId: 'owner-a',
    agentId: 'agent-a',
    sessionKey: 'agent-a:conv-a',
    conversationId: 'conv-a',
    kind: 'user_message',
    origin: { type: 'user', id: 'member-1' },
    trusted: true,
    priority: 'user',
    payload: {},
    at: NOW,
    status: 'accepted',
  };
  return {
    ownerId: 'owner-a',
    agentId: 'agent-a',
    conversationId: 'conv-a',
    runId: 'run-a',
    store: createMemoryStore(), blobs: createMemoryBlobStore(),
    enqueuer: new NoopEnqueuer(),
    wake,
    step: async (_name, fn) => fn(),
    signal: new AbortController().signal,
  };
}
