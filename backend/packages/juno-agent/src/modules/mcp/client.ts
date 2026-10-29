// One MCP session: protocol negotiation (a modern server/discover probe, else the legacy initialize
// handshake), paged tool discovery with an explicit truncation flag, a freshness-aware tool list (ttlMs,
// list_changed notifications, a re-list before a call that finds no such tool), authorized invocation
// with cancellation, bounded results, and a truthful connection status instead of assuming success.
import {
  MCP_CLIENT_INFO,
  MCP_MODERN_VERSION,
  MCP_PROTOCOL_VERSION,
  McpAuthError,
  McpProtocolError,
  TOOLS_LIST_CHANGED,
  declaresToolListChanged,
  modernMeta,
  parseCallResult,
  parseDiscoverResult,
  parseInitializeResult,
  mcpHeaderParams,
  mirroredHeaders,
  parseToolsPage,
} from './protocol.js';
import type { McpCallToolResult, McpDiscoverResult, McpHeaderParam, McpTool } from './protocol.js';
import type { McpRequestOptions, McpTransport } from './transport.js';

export type McpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface McpConnectionStatus {
  state: McpConnectionState;
  detail?: string;
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
}

export interface McpClientOptions {
  maxTools?: number;
  maxResultChars?: number;
  /** Back-off before reopening a notification stream that ended (default 30 s). */
  listenRetryMs?: number;
  /** How long the server/discover probe may take before the legacy handshake is tried instead (default 5 s). */
  probeTimeoutMs?: number;
}

export interface McpRefreshOptions extends McpCallOptions {
  /**
   * The run turn asking (for example `runId:stepId`). A connection re-lists at most once per turn, so a list whose
   * ttl is 0 is not fetched on every access. Absent: no per-turn limit.
   */
  turn?: string;
}

export interface McpToolOutcome {
  text: string;
  /** Real carried content: text, base64 images and resources (bounded). */
  parts: McpOutcomePart[];
  /** Bounded JSON of structuredContent, when the server sent it. */
  structured?: string;
  /** Media the runtime cannot carry (audio, unknown binary); never hidden behind a placeholder. */
  unsupported: string[];
  isError: boolean;
  truncated: boolean;
  /** Full text up to the transport cap, for the artifact capture boundary; not for display. */
  fullText?: string;
}

export type McpOutcomePart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'resource'; uri: string; text: string };

export interface McpToolDiscovery {
  tools: McpTool[];
  /** True when discovery stopped at a bound instead of exhausting the server's catalog. */
  truncated: boolean;
}

export interface McpCallOptions {
  signal?: AbortSignal;
}

const DEFAULT_MAX_TOOLS = 200;
const DEFAULT_MAX_RESULT_CHARS = 20_000;
const MAX_TOOL_PAGES = 20;
const MAX_IMAGES = 8;
const MAX_IMAGE_CHARS = 1_000_000;
const MAX_STRUCTURED_CHARS = 4_000;
const MAX_FULL_CHARS = 1_000_000;
/** Freshness of a tool list whose server states no ttlMs (2026 servers must; legacy servers never do). */
const DEFAULT_LIST_TTL_MS = 10 * 60_000;
/** Back-off before retrying a failed re-list, and before reopening a stream that ended. */
const RETRY_MS = 30_000;
/** The modern probe must answer within this, or the connect falls back to the legacy handshake. */
const PROBE_TIMEOUT_MS = 5_000;

const BASE64 = /^[A-Za-z0-9+/=\s]+$/;

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedJson(value: unknown, max: number): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? '';
  } catch {
    return '(structured content could not be serialized)';
  }
  return json.length > max ? json.slice(0, max) + '…' : json;
}

/** Live server guidance (initialize.instructions or discover's instructions), trimmed; empty or missing stays undefined. */
function normalizeInstructions(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Resolves after `ms`, or at once when `signal` aborts first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Two tool lists are the same when they carry the same tools in the same order (the server orders deterministically). */
function sameTools(left: readonly McpTool[], right: readonly McpTool[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class McpCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpCancelledError';
  }
}

export class McpConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConnectionError';
  }
}

/** A call named a tool the server no longer offers (checked against a fresh list, not a stale one). */
export class McpToolRemovedError extends Error {
  constructor(name: string) {
    super('this app no longer offers ' + JSON.stringify(name) + '; search again with tool_search');
    this.name = 'McpToolRemovedError';
  }
}

/** A short, non-secret reason for the connection state; a rejected credential is named truthfully. */
export function mcpErrorDetail(error: unknown): string {
  if (error instanceof McpAuthError) return 'unauthorized';
  if (error instanceof McpProtocolError) return 'protocol-' + String(error.code);
  if (error instanceof Error) return error.message;
  return 'unknown error';
}

export class McpClient {
  private readonly createTransport: () => McpTransport;
  private transport: McpTransport | undefined;
  private readonly maxTools: number;
  private readonly maxResultChars: number;
  private readonly listenRetryMs: number;
  private readonly probeTimeoutMs: number;
  private nextId = 1;
  private status: McpConnectionStatus = { state: 'disconnected' };
  private tools: McpTool[] = [];
  private truncatedTools = false;
  /** True once a tools/list has succeeded on this connection (the list may still be empty). */
  private listed = false;
  /** Which handshake this session settled on; undefined until connected. */
  private era: 'modern' | 'legacy' | undefined;
  private serverInstructionsValue: string | undefined;
  private listChanged = false;
  /** Monotonic time (ms since epoch) after which the cached tool list must be re-listed. */
  private expiresAt = 0;
  /** Set by a list_changed notification: the list is stale whatever its ttl says. */
  private stale = false;
  /** The run turn of the last re-list attempt; a turn re-lists at most once. */
  private refreshedTurn: string | undefined;
  private refreshing: Promise<boolean> | undefined;
  private watch: AbortController | undefined;
  private pendingConnect: Promise<McpConnectionStatus> | undefined;

  constructor(createTransport: () => McpTransport, options: McpClientOptions = {}) {
    this.createTransport = createTransport;
    this.maxTools = options.maxTools ?? DEFAULT_MAX_TOOLS;
    this.maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
    this.listenRetryMs = options.listenRetryMs ?? RETRY_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  }

  getStatus(): McpConnectionStatus {
    return { ...this.status };
  }

  discoveredTools(): McpTool[] {
    return [...this.tools];
  }

  toolsTruncated(): boolean {
    return this.truncatedTools;
  }

  /** Server usage guidance from the live handshake; undefined when the server sent none. */
  serverInstructions(): string | undefined {
    return this.serverInstructionsValue;
  }

  /** Concurrent callers share one handshake; a failed attempt is discarded so a retry is fresh. */
  async connect(options: McpCallOptions = {}): Promise<McpConnectionStatus> {
    if (this.status.state === 'connected') return this.getStatus();
    if (this.pendingConnect !== undefined) return this.pendingConnect;
    const run = this.initialize(options);
    this.pendingConnect = run;
    try {
      return await run;
    } finally {
      if (this.pendingConnect === run) this.pendingConnect = undefined;
    }
  }

  private async initialize(options: McpCallOptions): Promise<McpConnectionStatus> {
    this.status = { state: 'connecting' };
    // Never carry guidance or a watch across handshakes: a new attempt starts with none, a failure keeps none.
    this.serverInstructionsValue = undefined;
    this.stopWatching();
    try {
      const transport = this.session();
      const requestOptions = options.signal === undefined ? {} : { signal: options.signal };
      const modern = await this.discoverModern(transport, options);
      if (modern !== undefined) {
        this.era = 'modern';
        this.serverInstructionsValue = normalizeInstructions(modern.instructions);
        this.listChanged = declaresToolListChanged(modern.capabilities);
        this.status = {
          state: 'connected',
          protocolVersion: MCP_MODERN_VERSION,
          ...(modern.serverInfo === undefined ? {} : { serverName: modern.serverInfo.name, serverVersion: modern.serverInfo.version }),
        };
      } else {
        // Legacy: the initialize handshake. No version header goes out before the server has named its own.
        transport.setProtocolVersion?.(undefined);
        const raw = await transport.request(
          this.nextId++,
          'initialize',
          { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT_INFO },
          requestOptions,
        );
        const init = parseInitializeResult(raw);
        transport.setProtocolVersion?.(init.protocolVersion);
        await transport.notify('notifications/initialized', {});
        this.era = 'legacy';
        this.serverInstructionsValue = normalizeInstructions(init.instructions);
        this.listChanged = declaresToolListChanged(init.capabilities);
        this.status = {
          state: 'connected',
          protocolVersion: init.protocolVersion,
          ...(init.serverInfo === undefined ? {} : { serverName: init.serverInfo.name, serverVersion: init.serverInfo.version }),
        };
      }
      if (this.listChanged) this.startWatching();
      return this.getStatus();
    } catch (error) {
      this.stopWatching();
      await this.discardTransport();
      this.resetList();
      this.era = undefined;
      this.listChanged = false;
      this.serverInstructionsValue = undefined;
      this.status = { state: 'error', detail: mcpErrorDetail(error) };
      throw error;
    }
  }

  /**
   * The modern probe: server/discover with the 2026 version in `_meta`. Undefined when the server does not
   * answer as a modern one, so the caller takes the legacy handshake. Auth and cancellation are real answers
   * and propagate; anything else (an unknown method, an old server, a silent one) means legacy.
   */
  private async discoverModern(transport: McpTransport, options: McpCallOptions): Promise<McpDiscoverResult | undefined> {
    transport.setProtocolVersion?.(MCP_MODERN_VERSION);
    // Bounded by its own timer (and the caller's signal): a silent server cannot hold the connect; a timeout is a
    // non-answer like any other and takes the legacy handshake.
    const probe = new AbortController();
    const timer = setTimeout(() => probe.abort(new Error('MCP discovery probe timed out')), this.probeTimeoutMs);
    const onOuterAbort = (): void => probe.abort(options.signal?.reason);
    if (options.signal?.aborted === true) onOuterAbort();
    else options.signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const raw = await transport.request(this.nextId++, 'server/discover', { _meta: modernMeta() }, { signal: probe.signal });
      const result = parseDiscoverResult(raw);
      return result.supportedVersions.includes(MCP_MODERN_VERSION) ? result : undefined;
    } catch (error) {
      if (error instanceof McpAuthError || options.signal?.aborted === true) throw error;
      return undefined;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  /** Page tools/list to the catalog's end, stopping at the tool cap with an explicit truncation flag. */
  async discoverTools(options: McpCallOptions = {}): Promise<McpToolDiscovery> {
    this.requireConnected();
    const transport = this.session();
    const tools: McpTool[] = [];
    let truncated = false;
    let cursor: string | undefined;
    // The list is fresh for the shortest ttl any of its pages states (a page with none takes the default).
    let freshFor = Number.POSITIVE_INFINITY;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const params = this.requestParams(cursor === undefined ? {} : { cursor });
      const requestOptions = options.signal === undefined ? {} : { signal: options.signal };
      const raw = await transport.request(this.nextId++, 'tools/list', params, requestOptions);
      const result = parseToolsPage(raw);
      freshFor = Math.min(freshFor, result.ttlMs === undefined ? DEFAULT_LIST_TTL_MS : Math.max(0, result.ttlMs));
      for (const tool of result.tools) {
        if (tools.length >= this.maxTools) {
          truncated = true;
          break;
        }
        tools.push(tool);
      }
      if (truncated) break;
      if (result.nextCursor === undefined) break;
      if (page === MAX_TOOL_PAGES - 1) {
        truncated = true;
        break;
      }
      cursor = result.nextCursor;
    }
    // Copy-on-write: a list that did not change keeps the array already in use, and a changed one replaces it whole.
    // Nothing that holds the old array is ever mutated, and a failed page aborts before anything is replaced.
    // 2026-07-28 over HTTP: a tool whose x-mcp-header annotations break the rules is never advertised (the client MUST reject it).
    const usable = transport.kind === 'http' && this.era === 'modern' ? tools.filter((tool) => mcpHeaderParams(tool.inputSchema).problem === undefined) : tools;
    if (!sameTools(usable, this.tools) || truncated !== this.truncatedTools) {
      this.tools = usable;
      this.truncatedTools = truncated;
    }
    this.expiresAt = Date.now() + freshFor;
    this.stale = false;
    this.listed = true;
    return { tools: [...this.tools], truncated: this.truncatedTools };
  }

  async listTools(options: McpCallOptions = {}): Promise<McpTool[]> {
    return (await this.discoverTools(options)).tools;
  }

  /**
   * Re-list when the cached list is stale: its ttl has passed, or a list_changed arrived. A failed re-list keeps
   * the last good list and retries after a short back-off; only an abort propagates. Resolves true when it re-listed.
   */
  async refreshIfStale(options: McpRefreshOptions = {}): Promise<boolean> {
    if (this.status.state !== 'connected') return false;
    if (!this.stale && Date.now() < this.expiresAt) return false;
    // At most one re-list per run turn: a list that is due again within the same turn waits for the next one.
    if (options.turn !== undefined) {
      if (this.refreshedTurn === options.turn) return false;
      this.refreshedTurn = options.turn;
    }
    return this.refresh(options);
  }

  private refresh(options: McpCallOptions): Promise<boolean> {
    if (this.refreshing === undefined) {
      this.refreshing = this.discoverTools(options)
        .then(() => true, (error: unknown) => {
          if (options.signal?.aborted === true) throw error;
          this.stale = false;
          this.expiresAt = Date.now() + RETRY_MS;
          return false;
        })
        .finally(() => {
          this.refreshing = undefined;
        });
    }
    return this.refreshing;
  }

  async callTool(name: string, args: Record<string, unknown>, options: McpCallOptions = {}): Promise<McpToolOutcome> {
    this.requireConnected();
    // Nothing was sent yet, so an already-cancelled call returns before the transport (and its
    // cancellation notify) is touched.
    if (options.signal?.aborted) throw new McpCancelledError('MCP tool call ' + JSON.stringify(name) + ' was cancelled before start');
    // A name the cached list does not hold may be a tool that moved: confirm with a fresh list before refusing.
    await this.requireListed(name, options);
    const id = this.nextId++;
    const signal = options.signal;
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
    };
    if (signal !== undefined) {
      if (signal.aborted) cancelled = true;
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const transport = this.session();
    // 2026-07-28 over HTTP: the annotated arguments also travel as Mcp-Param-* headers.
    const modernHttp = transport.kind === 'http' && this.era === 'modern';
    const headers = modernHttp ? mirroredHeaders(this.headerParamsOf(name), args) : {};
    try {
      const requestOptions: McpRequestOptions = {
        ...(signal === undefined ? {} : { signal }),
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
      };
      const raw = await transport.request(id, 'tools/call', this.requestParams({ name, arguments: args }), requestOptions);
      return this.toOutcome(parseCallResult(raw));
    } catch (error) {
      if (!cancelled && error instanceof McpProtocolError && error.code === -32602) {
        // An unknown tool is an invalid-params error; the list may simply have moved, so check before blaming the arguments.
        await this.refresh({});
        if (!this.hasTool(name)) throw new McpToolRemovedError(name);
      }
      if (!cancelled) throw error;
      // Over modern HTTP the closed response stream is the cancellation; no notification is defined there.
      // Elsewhere the notify is bounded, so a server that never answers it cannot delay the cancellation.
      if (!modernHttp) await transport.notify('notifications/cancelled', { requestId: id, reason: 'client-abort' }).catch(() => undefined);
      throw new McpCancelledError('MCP tool call ' + JSON.stringify(name) + ' was cancelled');
    } finally {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
    }
  }

  async close(): Promise<void> {
    this.stopWatching();
    await this.discardTransport();
    this.resetList();
    this.era = undefined;
    this.listChanged = false;
    this.serverInstructionsValue = undefined;
    this.status = { state: 'disconnected' };
  }

  async reconnect(): Promise<McpConnectionStatus> {
    await this.close();
    return this.connect();
  }

  private hasTool(name: string): boolean {
    return this.tools.some((tool) => tool.name === name);
  }

  private async requireListed(name: string, options: McpCallOptions): Promise<void> {
    // Only a session that has listed its tools can say a name is gone; without a listing the server decides.
    if (!this.listed || this.hasTool(name)) return;
    this.stale = true;
    const refreshed = await this.refresh(options);
    if (!refreshed || !this.hasTool(name)) throw new McpToolRemovedError(name);
  }

  /** The x-mcp-header parameters of a listed tool; none when the name is not listed. */
  private headerParamsOf(name: string): McpHeaderParam[] {
    const tool = this.tools.find((candidate) => candidate.name === name);
    return tool === undefined ? [] : mcpHeaderParams(tool.inputSchema).params;
  }

  private resetList(): void {
    this.tools = [];
    this.truncatedTools = false;
    this.listed = false;
    this.stale = false;
    this.expiresAt = 0;
    this.refreshedTurn = undefined;
  }

  /** Modern requests carry the protocol version, identity and capabilities in `_meta`; legacy requests go out unchanged. */
  private requestParams(params: Record<string, unknown>): Record<string, unknown> {
    return this.era === 'modern' ? { ...params, _meta: modernMeta() } : params;
  }

  private startWatching(): void {
    this.stopWatching();
    const controller = new AbortController();
    this.watch = controller;
    void this.watchLoop(controller.signal);
  }

  private stopWatching(): void {
    this.watch?.abort();
    this.watch = undefined;
  }

  /**
   * Keeps a notification stream open for a server that declared listChanged. A list_changed marks the list
   * stale; a stream that ends is reopened after a back-off (the list is marked stale too, since it may have
   * missed changes). A server that offers no stream ends the loop; the ttl still bounds freshness.
   */
  private async watchLoop(signal: AbortSignal): Promise<void> {
    const onNotification = (method: string): void => {
      if (method === TOOLS_LIST_CHANGED) this.stale = true;
    };
    while (!signal.aborted) {
      const transport = this.transport;
      if (transport?.listen === undefined) return;
      const options = this.era === 'modern' ? { id: this.nextId++, subscribe: { toolsListChanged: true } } : { id: this.nextId++ };
      let opened: boolean;
      try {
        opened = await transport.listen(options, onNotification, signal);
      } catch {
        return;
      }
      if (!opened || signal.aborted) return;
      this.stale = true;
      await sleep(this.listenRetryMs, signal);
    }
  }

  private session(): McpTransport {
    if (this.transport === undefined) this.transport = this.createTransport();
    return this.transport;
  }

  private async discardTransport(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    if (transport !== undefined) await transport.close().catch(() => undefined);
  }

  private requireConnected(): void {
    if (this.status.state !== 'connected') {
      throw new McpConnectionError('MCP client is not connected (state: ' + this.status.state + ')');
    }
  }

  private toOutcome(result: McpCallToolResult): McpToolOutcome {
    const parts: McpOutcomePart[] = [];
    const unsupported: string[] = [];
    const notes: string[] = [];
    let remaining = this.maxResultChars;
    let truncated = false;
    let images = 0;
    let fullText = '';
    const addFull = (chunk: string): void => {
      if (fullText.length >= MAX_FULL_CHARS) return;
      fullText += (fullText === '' ? '' : '\n') + chunk.slice(0, MAX_FULL_CHARS - fullText.length);
    };
    const addNote = (note: string): void => {
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const bounded = note.length > remaining ? note.slice(0, remaining) + '…' : note;
      if (bounded.length < note.length) truncated = true;
      remaining -= bounded.length;
      notes.push(bounded);
    };
    for (const part of result.content) {
      const type = typeof part.type === 'string' ? part.type : 'unknown';
      if (type === 'text' && typeof part.text === 'string') {
        // Display parts carry only the bounded prefix; the full text rides on fullText.
        const visible = remaining > 0 ? part.text.slice(0, remaining) : '';
        parts.push({ type: 'text', text: visible });
        addNote(part.text);
        addFull(part.text);
        continue;
      }
      if (type === 'image') {
        const mimeType = typeof part.mimeType === 'string' ? part.mimeType : '';
        const data = typeof part.data === 'string' ? part.data : '';
        if (mimeType.startsWith('image/') && data.length <= MAX_IMAGE_CHARS && images < MAX_IMAGES && BASE64.test(data)) {
          images += 1;
          parts.push({ type: 'image', mimeType, data });
          addNote('[image ' + mimeType + ']');
        } else {
          unsupported.push(mimeType.startsWith('image/') ? mimeType + ' (too large or invalid)' : 'image');
        }
        continue;
      }
      if (type === 'resource') {
        const nested = isRecordValue(part.resource) ? part.resource : undefined;
        const uri = typeof part.uri === 'string' ? part.uri : nested !== undefined && typeof nested.uri === 'string' ? nested.uri : undefined;
        if (uri === undefined) {
          unsupported.push('resource');
          continue;
        }
        const resourceText = nested !== undefined && typeof nested.text === 'string' ? nested.text : '';
        parts.push({ type: 'resource', uri, text: resourceText.slice(0, MAX_STRUCTURED_CHARS) });
        addNote('[resource ' + uri + ']');
        if (resourceText !== '') addNote(resourceText);
        if (resourceText !== '') addFull(resourceText);
        continue;
      }
      if (type === 'resource_link') {
        addNote('[link ' + (typeof part.uri === 'string' ? part.uri : '') + ']');
        continue;
      }
      unsupported.push(type === '' ? 'unknown' : type);
    }
    const structured = result.structuredContent === undefined ? undefined : boundedJson(result.structuredContent, MAX_STRUCTURED_CHARS);
    if (structured !== undefined) {
      addNote('structured: ' + structured);
      addFull('structured: ' + structured);
    }
    const uniqueUnsupported = [...new Set(unsupported)];
    if (uniqueUnsupported.length > 0) addNote('[unsupported content omitted: ' + uniqueUnsupported.join(', ') + ']');
    const hasFull = fullText.length > notes.join('\n').length;
    if (truncated && hasFull) {
      notes.push('[display truncated; full result (' + String(fullText.length) + ' chars) is available to the artifact capture]');
    }
    return {
      text: notes.join('\n'),
      parts,
      ...(structured === undefined ? {} : { structured }),
      unsupported: uniqueUnsupported,
      isError: result.isError === true,
      truncated,
      ...(hasFull ? { fullText } : {}),
    };
  }
}
