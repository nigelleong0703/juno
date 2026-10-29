// Fake MCP server for the version, tool-list freshness and HTTP request-metadata tests: a real HTTP endpoint that
// answers server/discover (modern) or initialize (legacy), keeps its tool list mutable, and pushes
// notifications/tools/list_changed on the stream the client opened (subscriptions/listen, or the legacy GET).
// Kept outside the *.test.ts glob; the test file imports it.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const MODERN = '2026-07-28';

export interface FreshTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface FreshServerOptions {
  era: 'modern' | 'legacy';
  /** Modern: the ttlMs every tools/list states (default 60 s). */
  ttlMs?: number;
  /** Declare tools.listChanged and open a notification stream on request. */
  listChanged?: boolean;
  /** Modern: the versions server/discover offers (default just 2026-07-28). Without 2026 the server speaks legacy. */
  discoverVersions?: string[];
  /** Never answer server/discover (the probe must time out and fall back to initialize). */
  silentDiscover?: boolean;
}

export interface SeenRequest {
  method: string;
  protocolVersion: string | undefined;
  routing: string | undefined;
  name: string | undefined;
  hasMeta: boolean;
  /** The Mcp-Param-* headers of the request, keyed by lowercased header name. */
  params: Record<string, string>;
}

export interface FreshServer {
  url: string;
  /** Requests received per method. */
  calls: Record<string, number>;
  /** Headers and `_meta` of every request, in arrival order. */
  seen: SeenRequest[];
  /** Notification streams open right now. */
  readonly streams: number;
  /** Modern requests that arrived without `_meta` (refused). */
  readonly missingMeta: number;
  setTools(tools: FreshTool[]): void;
  close(): Promise<void>;
}

interface OpenStream {
  res: ServerResponse;
  subscriptionId?: number | string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export async function startFreshServer(options: FreshServerOptions): Promise<FreshServer> {
  let tools: FreshTool[] = [
    { name: 'echo', description: 'Echo the text' },
    { name: 'ping', description: 'Ping the server' },
  ];
  const streams = new Set<OpenStream>();
  const versions = options.discoverVersions ?? [MODERN];
  // Modern behaviour applies only when the server is modern AND offers the 2026 revision.
  const modern = options.era === 'modern' && versions.includes(MODERN);
  const capabilities = options.listChanged === true ? { tools: { listChanged: true } } : { tools: {} };
  const calls: Record<string, number> = {};
  const seen: SeenRequest[] = [];
  let missingMeta = 0;

  const rpcResult = (id: unknown, result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const rpcError = (id: unknown, code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message } });
  const send = (res: ServerResponse, body: unknown): void => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  const listBody = (): Record<string, unknown> => ({
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema ?? { type: 'object', properties: {} } })),
  });

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET') {
        if (!modern && options.listChanged === true) {
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          const stream: OpenStream = { res: response };
          streams.add(stream);
          response.on('close', () => streams.delete(stream));
          return;
        }
        response.statusCode = 405;
        response.end();
        return;
      }
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.end();
        return;
      }
      const parsed: unknown = JSON.parse(await readBody(request));
      if (!isRecord(parsed)) {
        response.statusCode = 400;
        response.end();
        return;
      }
      const method = typeof parsed.method === 'string' ? parsed.method : '';
      const id = parsed.id;
      const params = isRecord(parsed.params) ? parsed.params : {};
      calls[method] = (calls[method] ?? 0) + 1;
      const meta = params['_meta'];
      const hasMeta = isRecord(meta) && typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string';
      const header = (name: string): string | undefined => {
        const value = request.headers[name];
        return typeof value === 'string' ? value : undefined;
      };
      const paramHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (key.startsWith('mcp-param-') && typeof value === 'string') paramHeaders[key] = value;
      }
      seen.push({ method, protocolVersion: header('mcp-protocol-version'), routing: header('mcp-method'), name: header('mcp-name'), hasMeta, params: paramHeaders });
      if (modern && method !== 'server/discover' && !hasMeta) {
        missingMeta += 1;
        send(response, rpcError(id, -32602, 'missing _meta'));
        return;
      }
      // A server that never answers the probe: the client must give up on it after its probe timeout.
      if (method === 'server/discover' && options.silentDiscover === true) return;
      if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
        response.statusCode = 202;
        response.end();
        return;
      }
      if (method === 'server/discover') {
        if (options.era !== 'modern') {
          send(response, rpcError(id, -32601, 'method not found'));
          return;
        }
        send(response, rpcResult(id, {
          resultType: 'complete',
          supportedVersions: versions,
          capabilities,
          instructions: 'Use the tools with care.',
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fresh', version: '2' } },
        }));
        return;
      }
      if (method === 'initialize') {
        if (modern) {
          send(response, rpcError(id, -32601, 'method not found'));
          return;
        }
        response.setHeader('mcp-session-id', 'fresh-session-1');
        send(response, rpcResult(id, {
          protocolVersion: '2025-06-18',
          capabilities,
          serverInfo: { name: 'fresh-legacy', version: '1' },
          instructions: 'Legacy guidance.',
        }));
        return;
      }
      if (method === 'tools/list') {
        send(response, rpcResult(id, modern ? { ...listBody(), ttlMs: options.ttlMs ?? 60_000, cacheScope: 'private' } : listBody()));
        return;
      }
      if (method === 'tools/call') {
        const name = String(params['name']);
        if (!tools.some((tool) => tool.name === name)) {
          send(response, rpcError(id, -32602, 'Unknown tool: ' + name));
          return;
        }
        if (name === 'ask') {
          // A multi round-trip interim result: this client does not answer those and must say so.
          send(response, rpcResult(id, { resultType: 'input_required', inputRequests: {} }));
          return;
        }
        send(response, rpcResult(id, { content: [{ type: 'text', text: 'ran ' + name }] }));
        return;
      }
      if (method === 'subscriptions/listen' && modern) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const stream: OpenStream = { res: response, subscriptionId: typeof id === 'number' || typeof id === 'string' ? id : undefined };
        streams.add(stream);
        response.write('data: ' + JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/subscriptions/acknowledged',
          params: { _meta: { 'io.modelcontextprotocol/subscriptionId': id }, notifications: { toolsListChanged: true } },
        }) + '\n\n');
        response.on('close', () => streams.delete(stream));
        return;
      }
      send(response, rpcError(id, -32601, 'method not found'));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: 'http://127.0.0.1:' + String(port) + '/mcp',
    calls,
    seen,
    get streams() {
      return streams.size;
    },
    get missingMeta() {
      return missingMeta;
    },
    setTools(next: FreshTool[]): void {
      tools = next;
      for (const stream of streams) {
        const frame = modern
          ? { jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: { 'io.modelcontextprotocol/subscriptionId': stream.subscriptionId } } }
          : { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };
        stream.res.write('data: ' + JSON.stringify(frame) + '\n\n');
      }
    },
    close(): Promise<void> {
      for (const stream of streams) stream.res.end();
      streams.clear();
      server.closeAllConnections();
      return new Promise<void>((done) => server.close(() => done()));
    },
  };
}
