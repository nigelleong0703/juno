/**
 * MCP servers this gateway hosts for Google services, on Google's regular REST APIs: Gmail, Google Calendar and
 * Google Drive (Google's own MCP servers for them need Workspace Developer Preview enrollment), YouTube (YouTube Data
 * API v3: public search and charts on this deployment's key, plus the owner's own account) and Google Tasks; the tool sets live in modules/google/. Each is an OAuth protected
 * resource (RFC 9728) whose authorization server is Google: the connect flow discovers Google from our resource
 * metadata, the owner signs in with our configured Google client, and the agent calls us with that Google access
 * token. We hold no state and check nothing ourselves: every call is forwarded with the caller's token, so Google
 * decides what it may read, and a rejected token comes back as HTTP 401 (the client refreshes or asks to
 * reconnect). The public YouTube server needs no user sign-in: it calls the API with YOUTUBE_API_KEY and touches no personal
 * data, and answers only callers with the internal service token (403 otherwise). Writing tools say so (readOnlyHint false), so they follow the connector's level and ask first.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { HOSTED_MCP_PATH, MICROSOFT_ISSUER } from '@agent-desktop/contracts/mcp';
import { CALENDAR_SCOPES, CALENDAR_TOOLS } from './google/calendar.js';
import { DRIVE_SCOPES, DRIVE_TOOLS } from './google/drive.js';
import { GMAIL_SCOPES, GMAIL_TOOLS } from './google/gmail.js';
import type { Api, Args, HostedTool, Query, Send } from './google/shared.js';
import { CONTACTS_SCOPES, CONTACTS_TOOLS } from './microsoft/contacts.js';
import { ONEDRIVE_SCOPES, ONEDRIVE_TOOLS } from './microsoft/onedrive.js';
import { OUTLOOK_CALENDAR_SCOPES, OUTLOOK_CALENDAR_TOOLS } from './microsoft/outlook-calendar.js';
import { OUTLOOK_MAIL_SCOPES, OUTLOOK_MAIL_TOOLS } from './microsoft/outlook-mail.js';
import { TEAMS_SCOPES, TEAMS_TOOLS } from './microsoft/teams.js';
import { TODO_SCOPES, TODO_TOOLS } from './microsoft/todo.js';
import { TASKS_SCOPES, TASKS_TOOLS } from './google/tasks.js';
import { YOUTUBE_ACCOUNT_TOOLS, YOUTUBE_PUBLIC_TOOLS, YOUTUBE_SCOPES } from './google/youtube.js';

export const GOOGLE_MCP_PATH = HOSTED_MCP_PATH;
const GOOGLE_ISSUER = 'https://accounts.google.com';
const APIS = {
  gmail: 'https://gmail.googleapis.com/gmail/v1',
  calendar: 'https://www.googleapis.com/calendar/v3',
  drive: 'https://www.googleapis.com/drive/v3',
  youtube: 'https://www.googleapis.com/youtube/v3',
  tasks: 'https://tasks.googleapis.com/tasks/v1',
  graph: 'https://graph.microsoft.com/v1.0',
} as const;
type ApiName = keyof typeof APIS;
export const PROTOCOL_VERSION = '2025-06-18';

export interface GoogleMcpDeps {
  /** This gateway's public origin; the resource identifier is `publicUrl + GOOGLE_MCP_PATH + service`. */
  publicUrl: string;
  /** Tests point these at a loopback fixture; production uses Google. */
  issuer?: string;
  apis?: Partial<Record<ApiName, string>>;
  fetchImpl?: typeof fetch;
  /** Where the platform API key is read (YOUTUBE_API_KEY); defaults to the process environment. */
  env?: Record<string, string | undefined>;
  /** The service bearer shared with agentd (INTERNAL_AGENTD_TOKEN): the only credential a platform-key service (public YouTube) accepts. */
  internalToken?: string;
}

interface HostedService {
  api: ApiName;
  scopes: string[];
  tools: HostedTool[];
  /** The authorization server when it is not Google. */
  issuer?: string;
  /** No sign-in: the call carries this deployment's API key (env name) instead of the caller's token. */
  keyEnv?: string;
}

/** Path segment under GOOGLE_MCP_PATH -> service. The scopes are what the catalog entries request. */
export const SERVICES: Readonly<Record<string, HostedService>> = {
  gmail: { api: 'gmail', scopes: GMAIL_SCOPES, tools: GMAIL_TOOLS },
  calendar: { api: 'calendar', scopes: CALENDAR_SCOPES, tools: CALENDAR_TOOLS },
  drive: { api: 'drive', scopes: DRIVE_SCOPES, tools: DRIVE_TOOLS },
  youtube: { api: 'youtube', scopes: [], tools: YOUTUBE_PUBLIC_TOOLS, keyEnv: 'YOUTUBE_API_KEY' },
  'youtube-account': { api: 'youtube', scopes: YOUTUBE_SCOPES, tools: YOUTUBE_ACCOUNT_TOOLS },
  tasks: { api: 'tasks', scopes: TASKS_SCOPES, tools: TASKS_TOOLS },
  // Microsoft 365 on Microsoft Graph (modules/microsoft/); the signed-in Microsoft account's token is forwarded as is.
  'outlook-mail': { api: 'graph', scopes: OUTLOOK_MAIL_SCOPES, tools: OUTLOOK_MAIL_TOOLS, issuer: MICROSOFT_ISSUER },
  'outlook-calendar': { api: 'graph', scopes: OUTLOOK_CALENDAR_SCOPES, tools: OUTLOOK_CALENDAR_TOOLS, issuer: MICROSOFT_ISSUER },
  'microsoft-todo': { api: 'graph', scopes: TODO_SCOPES, tools: TODO_TOOLS, issuer: MICROSOFT_ISSUER },
  onedrive: { api: 'graph', scopes: ONEDRIVE_SCOPES, tools: ONEDRIVE_TOOLS, issuer: MICROSOFT_ISSUER },
  'microsoft-contacts': { api: 'graph', scopes: CONTACTS_SCOPES, tools: CONTACTS_TOOLS, issuer: MICROSOFT_ISSUER },
  teams: { api: 'graph', scopes: TEAMS_SCOPES, tools: TEAMS_TOOLS, issuer: MICROSOFT_ISSUER },
};
/** MICROSOFT_ISSUER is the multi-tenant authority; juno-agent mcp/oauth.ts maps it to Microsoft's fixed v2.0 endpoints.
 *  Graph asks for UTC times and plain-text bodies, so tools format times themselves and never strip HTML. */
const GRAPH_HEADERS = { prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' };

/** Upstream rejected the token: answered as HTTP 401 so the MCP client refreshes or reports needs-reauth. */
class UpstreamAuthError extends Error {}
/** Upstream says the token's grant lacks a scope this tool needs (an owner who connected before the tool existed): answered as 403 insufficient_scope, which the app shows as scope_missing and signs in again with. */
class UpstreamScopeError extends Error {}

/** Google: reason ACCESS_TOKEN_SCOPE_INSUFFICIENT (Google API error details). Graph: an access-denied code (the codes are from Graph's error docs, not exercised live). */
function lacksScope(api: ApiName, body: Record<string, unknown>): boolean {
  if (api === 'graph') return ['Authorization_RequestDenied', 'ErrorAccessDenied', 'AccessDenied'].includes(String(Reflect.get((body.error as object | undefined) ?? {}, 'code')));
  return /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(JSON.stringify(body));
}

function scopeMissing(deps: GoogleMcpDeps, service: string): Response {
  const scope = (SERVICES[service]?.scopes ?? []).filter((entry) => entry !== 'offline_access').join(' ');
  return new Response(null, { status: 403, headers: { 'www-authenticate': 'Bearer error="insufficient_scope", scope="' + scope + '", resource_metadata="' + metadataUrl(deps, service) + '"' } });
}

export function isGoogleMcpService(service: string): boolean {
  return Object.hasOwn(SERVICES, service);
}

function resourceOf(deps: GoogleMcpDeps, service: string): string {
  return deps.publicUrl.replace(/\/+$/, '') + GOOGLE_MCP_PATH + service;
}

/** RFC 9728 metadata, served at the path-aware well-known URL. */
export function googleMcpResourceMetadata(deps: GoogleMcpDeps, service: string): Record<string, unknown> {
  return {
    resource: resourceOf(deps, service),
    authorization_servers: [SERVICES[service]?.issuer ?? deps.issuer ?? GOOGLE_ISSUER],
    scopes_supported: SERVICES[service]?.scopes ?? [],
    bearer_methods_supported: ['header'],
  };
}

function metadataUrl(deps: GoogleMcpDeps, service: string): string {
  return deps.publicUrl.replace(/\/+$/, '') + '/.well-known/oauth-protected-resource' + GOOGLE_MCP_PATH + service;
}

function unauthorized(deps: GoogleMcpDeps, service: string): Response {
  return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="' + metadataUrl(deps, service) + '"' } });
}

/** `authorization` is the caller's Google token, or the deployment's API key (sent as `key`) for a public service. */
function googleApi(deps: GoogleMcpDeps, name: ApiName, credential: { authorization: string } | { key: string }): Api {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const call = async (path: string, query: Query, send?: Send): Promise<Response> => {
    const base = deps.apis?.[name] ?? APIS[name];
    const url = new URL(path.startsWith('/upload/') ? new URL(base).origin + path : base + path);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
    if ('key' in credential) url.searchParams.set('key', credential.key);
    const response = await fetchImpl(url, {
      ...(send === undefined ? {} : { method: send.method, ...(send.body === undefined ? {} : { body: send.contentType === undefined ? JSON.stringify(send.body) : String(send.body) }) }),
      headers: { ...(name === 'graph' ? GRAPH_HEADERS : {}), ...('authorization' in credential ? { authorization: credential.authorization } : {}), ...(send?.body === undefined ? {} : { 'content-type': send.contentType ?? 'application/json' }) },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpstreamAuthError();
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const message = Reflect.get((body.error as object | undefined) ?? {}, 'message');
      if (response.status === 403 && lacksScope(name, body)) throw new UpstreamScopeError();
      throw new Error((name === 'graph' ? 'Microsoft Graph ' : 'Google API ') + String(response.status) + (typeof message === 'string' ? ': ' + message : ''));
    }
    return response;
  };
  const api = (async (path: string, query: Query = {}, send?: Send) =>
    (await (await call(path, query, send)).json().catch(() => ({}))) as Record<string, unknown>) as Api;
  api.text = async (path, query = {}) => (await call(path, query)).text();
  api.bytes = async (path, query = {}) => Buffer.from(await (await call(path, query)).arrayBuffer());
  return api;
}

export const rpc = (id: unknown, result: unknown): Response => Response.json({ jsonrpc: '2.0', id, result });
export const rpcError = (id: unknown, code: number, message: string): Response => Response.json({ jsonrpc: '2.0', id, error: { code, message } });

export function isInternalCaller(token: string | undefined, authorization: string): boolean {
  if (token === undefined || token === '') return false;
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  return timingSafeEqual(expected, createHash('sha256').update(authorization).digest());
}

/** Streamable HTTP, JSON responses only (no sessions, no server-sent events): initialize, tools/list, tools/call, ping. */
export async function handleGoogleMcp(deps: GoogleMcpDeps, service: string, request: Request): Promise<Response> {
  const hosted = SERVICES[service];
  if (hosted === undefined) return new Response(null, { status: 404 });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  const authorization = request.headers.get('authorization') ?? '';
  const key = hosted.keyEnv === undefined ? undefined : (deps.env ?? process.env)[hosted.keyEnv];
  if (hosted.keyEnv === undefined && !/^Bearer \S+$/.test(authorization)) return unauthorized(deps, service);
  // A platform-key service spends this deployment's quota: 403, not 401 (a 401 would start an OAuth flow in the client).
  if (hosted.keyEnv !== undefined && !isInternalCaller(deps.internalToken, authorization)) return Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  const message = (await request.json().catch(() => undefined)) as { id?: unknown; method?: unknown; params?: Record<string, unknown> } | undefined;
  if (typeof message !== 'object' || message === null || typeof message.method !== 'string') return rpcError(null, -32600, 'Invalid request');
  if (message.id === undefined) return new Response(null, { status: 202 });
  switch (message.method) {
    case 'initialize':
      return rpc(message.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'juno-' + service, version: '1.0.0' } });
    case 'ping':
      return rpc(message.id, {});
    case 'tools/list':
      return rpc(message.id, {
        tools: hosted.tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: { type: 'object', properties: tool.properties, ...(tool.required === undefined ? {} : { required: tool.required }) },
          annotations: { title: tool.title, readOnlyHint: tool.writes !== true, ...(tool.writes === true ? { destructiveHint: tool.destructive === true } : {}), openWorldHint: true },
        })),
      });
    case 'tools/call': {
      const tool = hosted.tools.find((candidate) => candidate.name === message.params?.name);
      if (tool === undefined) return rpcError(message.id, -32602, 'Unknown tool');
      const args = message.params?.arguments;
      if (hosted.keyEnv !== undefined && (key === undefined || key === '')) return rpc(message.id, { content: [{ type: 'text', text: 'This service is not configured on this deployment' }], isError: true });
      try {
        const result = await tool.run(googleApi(deps, hosted.api, key === undefined ? { authorization } : { key }), typeof args === 'object' && args !== null ? (args as Args) : {});
        return rpc(message.id, { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] });
      } catch (error) {
        if (error instanceof UpstreamScopeError) return scopeMissing(deps, service);
        if (error instanceof UpstreamAuthError) return hosted.keyEnv === undefined ? unauthorized(deps, service) : rpc(message.id, { content: [{ type: 'text', text: 'The service key was rejected' }], isError: true });
        return rpc(message.id, { content: [{ type: 'text', text: error instanceof Error ? error.message : 'The call failed' }], isError: true });
      }
    }
    default:
      return rpcError(message.id, -32601, 'Method not found');
  }
}
