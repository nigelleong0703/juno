// MCP wire protocol: the JSON-RPC 2.0 envelope plus the subset this runtime speaks, in two eras.
// Modern (2026-07-28): no handshake; every request carries its protocol version, identity and client
// capabilities in `_meta`, and server/discover states what the server supports. Legacy (2025-06-18 and
// older): an initialize handshake establishes the session. Deliberately dependency-free (no MCP SDK lock)
// so an owner's configured server is contacted with plain HTTP JSON or SSE and nothing beyond the spec
// fields we use.
import { z } from 'zod';
import { type Challenge } from './challenge.js';

/** The modern revision: per-request `_meta`, server/discover, no initialize. Offered first. */
export const MCP_MODERN_VERSION = '2026-07-28';
/** The newest legacy revision this client speaks (initialize handshake). */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_SUPPORTED_VERSIONS = [MCP_MODERN_VERSION, MCP_PROTOCOL_VERSION, '2025-03-26', '2024-11-05'];
export const MCP_CLIENT_INFO = { name: 'agent-desktop', version: '0.1.0' } as const;
/** The notification that invalidates a cached tool list (legacy unsolicited; modern on a subscriptions/listen stream). */
export const TOOLS_LIST_CHANGED = 'notifications/tools/list_changed';

export class McpProtocolError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = 'McpProtocolError';
  }
}

export class McpAuthError extends Error {
  /** A 403 `insufficient_scope`: the scope the server wants the sign-in extended with (MCP authorization, step-up). */
  public readonly insufficientScope: string | undefined;
  constructor(public readonly status: number, challenge: Challenge = {}) {
    super('MCP server rejected the request (HTTP ' + String(status) + '); no credential is configured for this connection');
    this.name = 'McpAuthError';
    this.insufficientScope = status === 403 && challenge.error === 'insufficient_scope' ? (challenge.scope ?? '') : undefined;
  }
}

export class McpUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpUnsupportedError';
  }
}

const jsonRpcIdSchema = z.union([z.number(), z.string()]);
const errorSchema = z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() });
const envelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: jsonRpcIdSchema.optional(),
  method: z.string().optional(),
  // Any JSON value: a notification's params are read only when they are an object, and never fail the frame.
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: errorSchema.optional(),
});

export interface McpFrame {
  id?: number | string;
  /** Set on notifications and server requests (no id); a response carries `result` or `error`. */
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse one JSON-RPC envelope without deciding whether it is the response we are waiting for. */
export function parseFrame(raw: string): McpFrame {
  const parsed = envelopeSchema.parse(JSON.parse(raw));
  return {
    ...(parsed.id === undefined ? {} : { id: parsed.id }),
    ...(parsed.method === undefined ? {} : { method: parsed.method }),
    ...(isRecordValue(parsed.params) ? { params: parsed.params } : {}),
    ...(parsed.result === undefined ? {} : { result: parsed.result }),
    ...(parsed.error === undefined ? {} : { error: { code: parsed.error.code, message: parsed.error.message } }),
  };
}

/** The result of a response frame; an error frame raises the server's JSON-RPC error. */
export function parseResult(raw: string): unknown {
  const frame = parseFrame(raw);
  if (frame.error !== undefined) throw new McpProtocolError(frame.error.code, frame.error.message);
  return frame.result;
}

export function buildRequest(id: number | string, method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

export function buildNotification(method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params });
}

/** The `_meta` every modern request carries: its protocol version, who is asking, and what the client can do. */
export function modernMeta(): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': MCP_MODERN_VERSION,
    'io.modelcontextprotocol/clientInfo': MCP_CLIENT_INFO,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

/** params of a modern subscriptions/listen: the filter names the notification types the client wants. */
export function subscriptionParams(subscribe: Record<string, unknown>): Record<string, unknown> {
  return { _meta: modernMeta(), notifications: subscribe };
}

/** RFC 9110 token characters: the only ones an x-mcp-header name may use. */
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * An HTTP header value for an argument (2026-07-28 "Value Encoding"): plain visible ASCII with no outer whitespace
 * goes as is; anything else, and a value that looks like the sentinel, is base64-wrapped.
 */
export function encodeHeaderValue(value: string): string {
  const plain = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value);
  const sentinel = value.startsWith('=?base64?') && value.endsWith('?=');
  return plain && !sentinel ? value : '=?base64?' + Buffer.from(value, 'utf8').toString('base64') + '?=';
}

export interface McpHeaderParam {
  /** The x-mcp-header name; the header is `Mcp-Param-<name>`. */
  name: string;
  /** The chain of `properties` keys from the root to the annotated property. */
  path: string[];
}

function scanHeaderParams(node: unknown, reachable: boolean, path: string[], params: McpHeaderParam[], problems: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) scanHeaderParams(item, false, path, params, problems);
    return;
  }
  if (!isRecordValue(node)) return;
  if ('x-mcp-header' in node) {
    const name = node['x-mcp-header'];
    const type = node['type'];
    if (!reachable || path.length === 0) problems.push('x-mcp-header is not on a statically reachable property');
    else if (typeof name !== 'string' || !HEADER_TOKEN.test(name)) problems.push('x-mcp-header name is not an HTTP token');
    else if (type !== 'string' && type !== 'integer' && type !== 'boolean') problems.push('x-mcp-header parameter ' + name + ' is not a string, integer or boolean');
    else params.push({ name, path });
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'x-mcp-header') continue;
    // Only a chain of `properties` keys is statically reachable; any other keyword makes what is under it unreachable.
    if (key === 'properties' && reachable && isRecordValue(value)) {
      for (const [prop, sub] of Object.entries(value)) scanHeaderParams(sub, true, [...path, prop], params, problems);
    } else {
      scanHeaderParams(value, false, path, params, problems);
    }
  }
}

/**
 * The x-mcp-header parameters of one tool's input schema, and the first rule they break (undefined when valid).
 * A tool that breaks a rule is not advertised over HTTP (2026-07-28 "Tool Definitions").
 */
export function mcpHeaderParams(inputSchema: Record<string, unknown> | undefined): { params: McpHeaderParam[]; problem?: string } {
  const params: McpHeaderParam[] = [];
  const problems: string[] = [];
  scanHeaderParams(inputSchema ?? {}, true, [], params, problems);
  const lowered = params.map((param) => param.name.toLowerCase());
  if (new Set(lowered).size !== lowered.length) problems.push('x-mcp-header names repeat');
  const problem = problems[0];
  return problem === undefined ? { params } : { params, problem };
}

/**
 * The Mcp-Param-* headers of one call: each annotated argument, read at its property path. A missing or null value
 * omits its header; a non-integer number is not sent (the schema does not allow it).
 */
export function mirroredHeaders(params: readonly McpHeaderParam[], args: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const param of params) {
    let value: unknown = args;
    for (const key of param.path) value = isRecordValue(value) ? value[key] : undefined;
    const header = 'Mcp-Param-' + param.name;
    if (typeof value === 'string') headers[header] = encodeHeaderValue(value);
    else if (typeof value === 'number' && Number.isSafeInteger(value)) headers[header] = String(value);
    else if (typeof value === 'boolean') headers[header] = value ? 'true' : 'false';
  }
  return headers;
}

export const mcpToolSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
});
export type McpTool = z.infer<typeof mcpToolSchema>;

const initializeResultSchema = z.object({
  protocolVersion: z.string(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  serverInfo: z.object({ name: z.string(), version: z.string() }).optional(),
  instructions: z.string().optional(),
});
export type McpInitializeResult = z.infer<typeof initializeResultSchema>;

const discoverResultSchema = z.object({
  supportedVersions: z.array(z.string()),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  instructions: z.string().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

export interface McpDiscoverResult {
  supportedVersions: string[];
  capabilities?: Record<string, unknown>;
  instructions?: string;
  serverInfo?: { name: string; version: string };
}

const listToolsResultSchema = z.object({
  tools: z.array(mcpToolSchema),
  nextCursor: z.string().optional(),
  /** Modern servers state how long the list may be treated as fresh (milliseconds). */
  ttlMs: z.number().optional(),
});

const callToolResultSchema = z.object({
  /** Structured-only results omit content entirely; that must parse, not fail. */
  content: z.array(z.record(z.string(), z.unknown())).default([]),
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  /** `input_required` is a multi round-trip interim result; this client does not answer those. */
  resultType: z.string().optional(),
});
export type McpCallToolResult = z.infer<typeof callToolResultSchema>;

export function parseInitializeResult(value: unknown): McpInitializeResult {
  return initializeResultSchema.parse(value);
}

/** server/discover (modern): the versions, capabilities, guidance and identity the server offers. */
export function parseDiscoverResult(value: unknown): McpDiscoverResult {
  const parsed = discoverResultSchema.parse(value);
  const info = z.object({ name: z.string(), version: z.string() }).safeParse(parsed._meta?.['io.modelcontextprotocol/serverInfo']);
  return {
    supportedVersions: parsed.supportedVersions,
    ...(parsed.capabilities === undefined ? {} : { capabilities: parsed.capabilities }),
    ...(parsed.instructions === undefined ? {} : { instructions: parsed.instructions }),
    ...(info.success ? { serverInfo: info.data } : {}),
  };
}

/** Whether a capabilities object declares `tools.listChanged` (both eras use the same field). */
export function declaresToolListChanged(capabilities: Record<string, unknown> | undefined): boolean {
  const tools: unknown = capabilities?.['tools'];
  return typeof tools === 'object' && tools !== null && Reflect.get(tools, 'listChanged') === true;
}

export function parseTools(value: unknown): McpTool[] {
  return listToolsResultSchema.parse(value).tools;
}

export interface McpToolsPage {
  tools: McpTool[];
  nextCursor?: string;
  ttlMs?: number;
}

/** One tools/list page with its cursor, so discovery can page instead of silently stopping. */
export function parseToolsPage(value: unknown): McpToolsPage {
  const parsed = listToolsResultSchema.parse(value);
  return {
    tools: parsed.tools,
    ...(parsed.nextCursor === undefined ? {} : { nextCursor: parsed.nextCursor }),
    ...(parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs }),
  };
}

export function parseCallResult(value: unknown): McpCallToolResult {
  const parsed = callToolResultSchema.parse(value);
  if (parsed.resultType === 'input_required') {
    throw new McpProtocolError(-32000, 'MCP server asked for more input (multi round-trip), which this client does not support');
  }
  return parsed;
}
