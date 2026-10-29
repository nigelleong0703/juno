/**
 * Bearer token authentication middleware.
 *
 * Token mode (default) checks the shared single-user API token. Account mode resolves the
 * owner from an injected session resolver instead, so this middleware never learns about
 * password or session storage details. After the identity is validated the optional
 * runAsOwner hook enters the request owner scope (AsyncLocalStorage) around `next`, which
 * is how HTTP request-scoped owner stores work without a global mutable singleton.
 */

import type { Context, MiddlewareHandler, Next } from 'hono';
import { getConfig } from './config.js';

/** Validated request identity from either auth mode. */
export interface AuthResolver {
  mode: 'token' | 'account';
  providers: string[];
  resolve(req: Request): Promise<{ ownerId: string; email?: string } | null>;
}

/** Auth surface the client reads before choosing a flow (token vs account). */
export interface AuthInfo {
  mode: 'token' | 'account';
  providers: string[];
}

/** The private agentd never serves accounts: it only ever reports token mode. */
export function tokenAuthInfo(): AuthInfo {
  return { mode: 'token', providers: [] };
}

/**
 * Optional auth dependencies. Both are injected per app instance (server/routes), never
 * kept as a global mutable singleton. runAsOwner adapts AU2's runWithOwner(ownerId, fn).
 */
export interface AuthOptions {
  resolver?: AuthResolver;
  runAsOwner?: (ownerId: string, next: () => Promise<void>) => Promise<void>;
}

async function runNext(
  opts: AuthOptions,
  ownerId: string,
  next: Next,
): Promise<Response | void> {
  if (opts.runAsOwner) return opts.runAsOwner(ownerId, () => next());
  return next();
}

async function accountRequest(
  c: Context,
  next: Next,
  resolver: AuthResolver,
  opts: AuthOptions,
): Promise<Response | void> {
  let identity: { ownerId: string; email?: string } | null;
  try {
    identity = await resolver.resolve(c.req.raw);
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing session' } }, 401);
  }
  if (!identity) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing session' } }, 401);
  }
  c.set('ownerId', identity.ownerId);
  if (identity.email) c.set('ownerEmail', identity.email);
  return runNext(opts, identity.ownerId, next);
}

async function tokenRequest(c: Context, next: Next, opts: AuthOptions): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
  const { API_TOKEN: expectedToken, OWNER_ID: ownerId } = getConfig();

  // E39: no built-in token. Token mode only works with an explicitly configured token and owner.
  if (!expectedToken || !ownerId || !token || token !== expectedToken) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' } }, 401);
  }

  c.set('token', token);
  c.set('ownerId', ownerId);
  return runNext(opts, ownerId, next);
}

export const bearerAuth = (opts: AuthOptions = {}): MiddlewareHandler => {
  return async (c: Context, next: Next) => {
    const resolver = opts.resolver;
    if (resolver && resolver.mode === 'account') return accountRequest(c, next, resolver, opts);
    return tokenRequest(c, next, opts);
  };
};

/** The authenticated request owner. Throws instead of guessing a config owner (E41). */
export const getOwnerId = (c: Context): string => {
  const ownerId: unknown = c.get('ownerId');
  if (typeof ownerId !== 'string' || ownerId.length === 0) throw new Error('missing request owner: route reached without auth');
  return ownerId;
};

/** The owner's account email when the gateway forwarded it (account mode); undefined otherwise. */
export const getOwnerEmail = (c: Context): string | undefined => {
  const email: unknown = c.get('ownerEmail');
  return typeof email === 'string' && email.length > 0 ? email : undefined;
};
