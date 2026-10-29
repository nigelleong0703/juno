/**
 * Composio, the long-tail path (BACKEND 10.18.3). A catalog row with `source: 'composio'` has no MCP server of its own: for each owner we ask
 * Composio for a tool-router SESSION keyed by our owner id, restricted to the row's toolkit, and Composio answers with a per-user MCP address
 * and the header that opens it. The owner's login to the app (Spotify, Shopify, ...) is a connected account held by Composio; we never see it.
 *
 * Calls used, all from Composio's own docs (read 2026-10-29):
 *   POST {base}/api/v3.1/tool_router/session                {user_id, toolkits:{enable:[slug]}, auth_configs?:{slug:"ac_..."}, manage_connections:{enable:false}}
 *                                                           -> {session_id, mcp:{url, headers}}        https://docs.composio.dev/docs/sessions-via-mcp
 *   POST {base}/api/v3.1/tool_router/session/{id}/link      {toolkit, callback_url} -> {redirect_url}  https://docs.composio.dev/docs/configuring-sessions
 *   GET  {base}/api/v3.1/tool_router/session/{id}/toolkits?is_connected=true -> {items:[{slug, connection:{is_active}}]}   (same page)
 * Every call carries `x-api-key: COMPOSIO_API_KEY`. `auth_configs` is how a toolkit with no Composio-managed OAuth app uses ours
 * (https://docs.composio.dev/docs/using-custom-auth-configuration). The `manage_connections` flag and the exact `toolkits` filter shape are
 * from the session example in the first page; the REST shape of `is_connected` filtering is as that page gives it.
 */
import { z } from 'zod';
import { createState, nonceMatches, parseState } from '@agent-desktop/contracts/mcp';
import type { Store } from '@agent-desktop/contracts';
import { McpAuthorizationError } from './mcp-authorization.js';

export const COMPOSIO_CALLBACK_PATH = '/oauth/composio/callback';
const DEFAULT_BASE = 'https://backend.composio.dev';
const TIMEOUT_MS = 15_000;
/** The owner has this long to finish the login at Composio. */
const PENDING_TTL_MS = 15 * 60_000;

export interface ComposioSession {
  sessionId: string;
  /** The per-user MCP address Composio made for this session. */
  mcpUrl: string;
  /** What opens it (the project's API key); a secret, sealed on the connection row. */
  headers: Record<string, string>;
}

export interface ComposioClient {
  session(input: { userId: string; toolkit: string; authConfigId?: string }): Promise<ComposioSession>;
  /** Whether the session's user has an active connected account for the toolkit. */
  connected(sessionId: string, toolkit: string): Promise<boolean>;
  /** The page where the user logs in to the toolkit, returning to `callbackUrl` afterwards. */
  link(sessionId: string, toolkit: string, callbackUrl: string): Promise<string>;
}

const sessionSchema = z.object({
  session_id: z.string().min(1),
  mcp: z.object({ url: z.string().min(1), headers: z.record(z.string(), z.string()).default({}) }),
});
const linkSchema = z.object({ redirect_url: z.string().min(1) });
const toolkitsSchema = z.object({ items: z.array(z.object({ slug: z.string(), connection: z.object({ is_active: z.boolean().optional() }).nullish() })) });

function failed(what: string, status?: number): McpAuthorizationError {
  return new McpAuthorizationError(502, 'COMPOSIO_FAILED', 'Composio could not ' + what + (status === undefined ? '' : ' (HTTP ' + String(status) + ')'));
}

/** https, or loopback http for the test double. */
function baseOf(raw: string): string {
  const url = new URL(raw);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('COMPOSIO_BASE_URL must be https');
  return url.origin;
}

export function createComposioClient(deps: { apiKey: string; fetchImpl: typeof fetch; baseUrl?: string }): ComposioClient {
  const base = baseOf(deps.baseUrl ?? DEFAULT_BASE);
  const call = async (what: string, path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<unknown> => {
    let response: Response;
    try {
      response = await deps.fetchImpl(base + '/api/v3.1/tool_router/' + path, {
        method: init.method,
        headers: { 'x-api-key': deps.apiKey, accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      throw failed(what);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw failed(what, response.status);
    }
    return response.json().catch(() => undefined);
  };
  return {
    async session(input) {
      const parsed = sessionSchema.safeParse(await call('start a session', 'session', {
        method: 'POST',
        body: {
          user_id: input.userId,
          toolkits: { enable: [input.toolkit] },
          manage_connections: { enable: false },
          ...(input.authConfigId === undefined ? {} : { auth_configs: { [input.toolkit]: input.authConfigId } }),
        },
      }));
      if (!parsed.success) throw failed('start a session');
      return { sessionId: parsed.data.session_id, mcpUrl: parsed.data.mcp.url, headers: parsed.data.mcp.headers };
    },
    async connected(sessionId, toolkit) {
      const parsed = toolkitsSchema.safeParse(await call('check the login', 'session/' + encodeURIComponent(sessionId) + '/toolkits?is_connected=true', { method: 'GET' }));
      if (!parsed.success) throw failed('check the login');
      return parsed.data.items.some((item) => item.slug.toLowerCase() === toolkit && item.connection?.is_active === true);
    },
    async link(sessionId, toolkit, callbackUrl) {
      const parsed = linkSchema.safeParse(await call('start the login', 'session/' + encodeURIComponent(sessionId) + '/link', { method: 'POST', body: { toolkit, callback_url: callbackUrl } }));
      if (!parsed.success) throw failed('start the login');
      return parsed.data.redirect_url;
    },
  };
}

/** The pending login kept on the connection row: a nonce hash (not a secret), where to send the browser back, and a deadline. */
export interface ComposioPending {
  nonceHash: string;
  returnUrl?: string;
  expiresAt: string;
}

export function newComposioPending(connectionId: string, returnUrl: string | undefined, now: number = Date.now()): { state: string; pending: ComposioPending } {
  const { state, nonceHash } = createState(connectionId);
  return { state, pending: { nonceHash, ...(returnUrl === undefined ? {} : { returnUrl }), expiresAt: new Date(now + PENDING_TTL_MS).toISOString() } };
}

function pendingOf(doc: object): ComposioPending | undefined {
  const parsed = z.object({ nonceHash: z.string(), returnUrl: z.string().optional(), expiresAt: z.string() }).safeParse(Reflect.get(doc, 'composioPending'));
  return parsed.success ? parsed.data : undefined;
}

/**
 * The browser is back from Composio. The state names a connection with a live, unused pending login (redeemed once: it is cleared first); then
 * Composio is asked whether the toolkit is now connected, and only that answer flips the connection. Nothing in the query is believed.
 */
export async function completeComposioLogin(deps: { store: Store; composio: ComposioClient; toolkitOf: (catalogId: string) => Promise<string | undefined>; returnUrl: string }, stateParam: string): Promise<{ connectionId: string; ownerId: string; status: 'connected' | 'error'; returnUrl: string }> {
  const invalid = () => new McpAuthorizationError(400, 'COMPOSIO_STATE_INVALID', 'The login link is invalid or has expired');
  const parsed = parseState(stateParam);
  if (parsed === undefined) throw invalid();
  const found = await deps.store.get('connections', parsed.connectionId);
  const ownerId = found === null ? undefined : Reflect.get(found, 'ownerId');
  const pending = found === null ? undefined : pendingOf(found);
  if (found === null || found.kind !== 'mcp' || typeof ownerId !== 'string' || pending === undefined) throw invalid();
  if (Date.parse(pending.expiresAt) <= Date.now() || !nonceMatches(parsed.nonce, pending.nonceHash)) throw invalid();
  const scoped = deps.store.forOwner?.(ownerId);
  if (scoped === undefined) throw new Error('store is missing forOwner; refusing an unscoped Composio login');
  await scoped.patch('connections', parsed.connectionId, { composioPending: null } as never);
  const sessionId = Reflect.get(found, 'composioSessionId');
  const toolkit = found.catalogId === undefined ? undefined : await deps.toolkitOf(found.catalogId);
  const returnUrl = pending.returnUrl ?? deps.returnUrl;
  let connected = false;
  if (typeof sessionId === 'string' && toolkit !== undefined) {
    try {
      connected = await deps.composio.connected(sessionId, toolkit);
    } catch {
      connected = false;
    }
  }
  await scoped.patch('connections', parsed.connectionId, { status: connected ? 'connected' : 'error', enabled: true, ...(connected ? { connectedAt: new Date().toISOString() } : {}) } as never);
  return { connectionId: parsed.connectionId, ownerId, status: connected ? 'connected' : 'error', returnUrl };
}
