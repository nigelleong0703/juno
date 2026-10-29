/**
 * Authenticated forwarding to the private agentd.
 *
 * The gateway authenticates the client itself (see server.ts), then re-issues the request
 * upstream with the service bearer and the authoritative owner. Incoming client credentials
 * and spoofable owner headers are stripped so a user token or a forged x-owner-id can never
 * reach the private service. Redirects are never followed: following one would resend the
 * authoritative owner to the redirect target. Set-cookie from the private service is dropped
 * so internal session state never lands in the browser. Exactly one upstream request is
 * made: no retries, so mutations are never replayed. A bound waits only for the upstream
 * response headers; the body stream itself stays long-lived and client-cancelable.
 */
import type { Context } from 'hono';
import { rewriteSseStream, type MediaRewriter } from './media-proxy.js';

/** Client-controlled hop headers that must never be forwarded upstream. */
const STRIPPED_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-owner-id',
  'x-owner',
  'x-owner-email',
  'x-hook-secret',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
]);

/** Upstream response headers owned by the transport or the private service internals. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'set-cookie',
]);

/** Default bound for the upstream response headers; streams run past it untouched. */
export const HEADER_TIMEOUT_MS = 10000;

/**
 * Sandbox provisioning boots a real VM and runs its start command (bounded ~180s upstream), so the
 * ordinary header bound would abort a healthy first provision. Only the two provisioning POSTs get
 * this longer bound; every other route keeps HEADER_TIMEOUT_MS.
 */
export const COMPUTER_PROVISION_TIMEOUT_MS = 240000;

const PROVISION_PATHS = new Set(['/v1/computers/ensure']);
const PROVISION_SCREENS = /^\/v1\/computers\/[^/]+\/screens$/;

/** The first response of these POSTs legitimately waits for a sandbox to boot. */
function isProvisioning(method: string, pathname: string): boolean {
  if (method !== 'POST') return false;
  return PROVISION_PATHS.has(pathname) || PROVISION_SCREENS.test(pathname);
}

/** Explicit `headerTimeoutMs` always wins; otherwise provisioning gets the longer bound. */
function headerTimeoutFor(method: string, pathname: string, override?: number): number {
  if (override !== undefined) return override;
  return isProvisioning(method, pathname) ? COMPUTER_PROVISION_TIMEOUT_MS : HEADER_TIMEOUT_MS;
}

export interface ForwardDeps {
  agentdUrl: string;
  internalToken: string;
  fetchFn: typeof fetch;
  /** Bound for upstream response headers only; defaults to HEADER_TIMEOUT_MS. */
  headerTimeoutMs?: number;
  /** Turns external image URLs in JSON and SSE responses into signed media URLs (BACKEND 5.13); absent passes bodies through. */
  media?: MediaRewriter;
}

/**
 * True when a failure is the client going away rather than a server fault: the request signal is
 * already aborted (a disconnect or a logout closed the stream), or the error is an AbortError.
 * Expected disconnects are not server errors and should not be logged as such.
 */
export function isClientAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * Join the private base with the incoming path plus query, preserving both exactly. The exceptions
 * are /v1/hooks/* and /v1/channels/*: their queries may carry the caller secret (`?key=`), which
 * the gateway has already verified and must not hand on.
 */
/** Install redirects carry `code`, `state` (and Discord's `guild_id`) in the query, which agentd needs. */
const OAUTH_CALLBACKS = new Set(['/v1/channels/slack/oauth/callback', '/v1/channels/discord/oauth/callback']);

export function upstreamUrl(agentdUrl: string, rawUrl: string): string {
  const incoming = new URL(rawUrl);
  const secretInQuery =
    incoming.pathname.startsWith('/v1/hooks/') ||
    (incoming.pathname.startsWith('/v1/channels/') && !OAUTH_CALLBACKS.has(incoming.pathname));
  const search = secretInQuery ? '' : incoming.search;
  return agentdUrl.replace(/\/$/, '') + incoming.pathname + search;
}

export async function forwardToAgentd(c: Context, ownerId: string, deps: ForwardDeps, ownerEmail?: string): Promise<Response> {
  const raw = c.req.raw;
  const headers = new Headers();
  raw.headers.forEach((value, key) => {
    if (!STRIPPED_HEADERS.has(key.toLowerCase())) headers.append(key, value);
  });
  headers.set('authorization', 'Bearer ' + deps.internalToken);
  headers.set('x-owner-id', ownerId);
  if (ownerEmail) headers.set('x-owner-email', ownerEmail);
  const target = upstreamUrl(deps.agentdUrl, raw.url);
  const timeoutMs = headerTimeoutFor(raw.method, new URL(raw.url).pathname, deps.headerTimeoutMs);
  const setup = new AbortController();
  const onClientAbort = (): void => setup.abort();
  if (raw.signal.aborted) setup.abort();
  else raw.signal.addEventListener('abort', onClientAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    setup.abort();
  }, timeoutMs);
  let body: ArrayBuffer | undefined;
  if (raw.method !== 'GET' && raw.method !== 'HEAD') body = await raw.arrayBuffer();
  let upstream: Response;
  try {
    upstream = await deps.fetchFn(target, {
      method: raw.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: setup.signal,
      redirect: 'manual',
    });
  } catch {
    clearTimeout(timer);
    raw.signal.removeEventListener('abort', onClientAbort);
    if (raw.signal.aborted) return new Response(null, { status: 499 });
    if (timedOut) {
      return Response.json(
        { error: { code: 'GATEWAY_TIMEOUT', message: 'Private agentd did not respond in time' } },
        { status: 504 },
      );
    }
    return Response.json(
      { error: { code: 'BAD_GATEWAY', message: 'Private agentd is unreachable' } },
      { status: 502 },
    );
  }
  clearTimeout(timer);
  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) outHeaders.append(key, value);
  });
  const type = upstream.headers.get('content-type') ?? '';
  if (deps.media !== undefined && upstream.body !== null && /^application\/json/i.test(type)) {
    // The incoming request URL (never forwarded headers) rebases loopback dev media signing for remote callers.
    return new Response(deps.media.rewriteJson(await upstream.text(), raw.url), { status: upstream.status, headers: outHeaders });
  }
  let outBody = upstream.body === null ? null : quietOnClientAbort(upstream.body, raw.signal);
  if (deps.media !== undefined && outBody !== null && /^text\/event-stream/i.test(type)) outBody = rewriteSseStream(outBody, deps.media, raw.url);
  return new Response(outBody, { status: upstream.status, headers: outHeaders });
}

/**
 * E56: a client disconnect aborts the upstream fetch mid-body (e.g. SSE on logout). End the
 * forwarded stream quietly in that case instead of erroring it, which the node transport
 * would print as an AbortError stack. Any other upstream body failure still errors.
 */
export function quietOnClientAbort(body: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) {
        if (isClientAbort(error, signal)) controller.close();
        else controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
