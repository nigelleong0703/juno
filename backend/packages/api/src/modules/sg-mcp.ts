/**
 * MCP server this gateway hosts for Singapore public data, like the public YouTube server (modules/google-mcp.ts):
 * `sg-transport` (LTA DataMall, on this deployment's LTA_ACCOUNT_KEY). It needs no user sign-in and touch no personal
 * data, but spend the deployment's quota, so only callers with the internal service token are answered (403
 * otherwise, never 401: that would start an OAuth flow in the client). An upstream failure is a tool error, never
 * an HTTP error. Results are cached briefly in memory (modules/sg/shared.ts) to stay inside the rate limits.
 */
import { SG_MCP_PATH } from '@agent-desktop/contracts/mcp';
import { isInternalCaller, PROTOCOL_VERSION, rpc, rpcError } from './google-mcp.js';
import type { Args, SgContext, SgTool } from './sg/shared.js';
import { lta } from './sg/transport.js';

export { SG_MCP_PATH };

export interface SgMcpDeps {
  /** The service bearer shared with agentd (INTERNAL_AGENTD_TOKEN). */
  internalToken?: string;
  /** Where LTA_ACCOUNT_KEY is read; defaults to the process environment. */
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Shared by all requests of one gateway; the route creates it. */
  cache?: Map<string, { at: number; value: Promise<unknown> }>;
}

interface SgService {
  /** Tools for this deployment, or undefined when it lacks the key. */
  tools(headers: Record<string, string>): SgTool[];
  keyEnv?: string;
  /** Header the key travels in. */
  header: string;
}

const SERVICES: Readonly<Record<string, SgService>> = {
  'sg-transport': { tools: lta, keyEnv: 'LTA_ACCOUNT_KEY', header: 'AccountKey' },
};

export const isSgMcpService = (service: string): boolean => Object.hasOwn(SERVICES, service);

const toolError = (id: unknown, text: string): Response => rpc(id, { content: [{ type: 'text', text }], isError: true });

function contextOf(deps: SgMcpDeps, origins: string[]): SgContext {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cache = deps.cache ?? new Map();
  const memo = <T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
    const value = load();
    cache.set(key, { at: Date.now(), value });
    // A failed load is not kept: the next call retries.
    value.catch(() => cache.delete(key));
    return value;
  };
  return {
    memo,
    now: deps.now ?? (() => new Date()),
    getJson: (url, ttlMs, headers = {}) => memo(url, ttlMs, async () => {
      if (!origins.some((origin) => url.startsWith(origin))) throw new Error('Unexpected upstream');
      const response = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20_000) });
      if (response.status === 401 || response.status === 403) throw new Error('The data source rejected this deployment\'s key (HTTP ' + String(response.status) + ')');
      if (response.status === 429) throw new Error('The data source is rate limiting this deployment; try again in a minute');
      if (!response.ok) throw new Error('The data source answered HTTP ' + String(response.status));
      return response.json();
    }),
  };
}

/** Streamable HTTP, JSON responses only: initialize, tools/list, tools/call, ping. */
export async function handleSgMcp(deps: SgMcpDeps, service: string, request: Request, origins: string[]): Promise<Response> {
  const hosted = SERVICES[service];
  if (hosted === undefined) return new Response(null, { status: 404 });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  if (!isInternalCaller(deps.internalToken, request.headers.get('authorization') ?? '')) return Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  const message = (await request.json().catch(() => undefined)) as { id?: unknown; method?: unknown; params?: Record<string, unknown> } | undefined;
  if (typeof message !== 'object' || message === null || typeof message.method !== 'string') return rpcError(null, -32600, 'Invalid request');
  if (message.id === undefined) return new Response(null, { status: 202 });
  const key = hosted.keyEnv === undefined ? undefined : (deps.env ?? process.env)[hosted.keyEnv];
  const hasKey = key !== undefined && key !== '';
  const tools = hosted.tools(hasKey ? { [hosted.header]: key } : {});
  switch (message.method) {
    case 'initialize':
      return rpc(message.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'juno-' + service, version: '1.0.0' } });
    case 'ping':
      return rpc(message.id, {});
    case 'tools/list':
      return rpc(message.id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: { type: 'object', properties: tool.properties, ...(tool.required === undefined ? {} : { required: tool.required }) },
          annotations: { title: tool.title, readOnlyHint: true, openWorldHint: true },
        })),
      });
    case 'tools/call': {
      const tool = tools.find((candidate) => candidate.name === message.params?.name);
      if (tool === undefined) return rpcError(message.id, -32602, 'Unknown tool');
      if (!hasKey) return toolError(message.id, 'This service is not configured on this deployment');
      const args = message.params?.arguments;
      try {
        return rpc(message.id, { content: [{ type: 'text', text: await tool.run(contextOf(deps, origins), typeof args === 'object' && args !== null ? (args as Args) : {}) }] });
      } catch (error) {
        return toolError(message.id, error instanceof Error ? error.message : 'The call failed');
      }
    }
    default:
      return rpcError(message.id, -32601, 'Method not found');
  }
}
