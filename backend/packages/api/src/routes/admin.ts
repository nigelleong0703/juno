/**
 * The admin path of the app catalog (BACKEND 10.18): how an operator adds, edits, hides or retires an app without a code change or a
 * deploy. It is not part of the owner API (no session, nothing under /v1): a request must carry `Authorization: Bearer <ADMIN_TOKEN>`,
 * the gateway's own admin secret, which is not the service bearer to agentd and is never sent upstream. With ADMIN_TOKEN unset the path
 * answers 404, as if it did not exist.
 *
 * GET   /admin/v1/apps                 -> agentd GET   /v1/admin/apps
 * POST  /admin/v1/apps                 -> agentd POST  /v1/admin/apps
 * PATCH /admin/v1/apps/:id             -> agentd PATCH /v1/admin/apps/:id
 * POST  /admin/v1/apps/:id/retire      -> agentd POST  /v1/admin/apps/:id/retire
 * POST  /admin/v1/apps/probe           -> agentd POST  /v1/admin/apps/probe   `{url}` or `{composioToolkit}`: probe it and write a hidden draft
 *
 * agentd validates and answers (400/404/409 pass through unchanged). After a write that went through, the catalog this gateway cached is
 * dropped, so the next request already sees the change.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, Hono, MiddlewareHandler } from 'hono';

export interface AdminAppsDeps {
  /** ADMIN_TOKEN; empty switches the admin path off. */
  adminToken: string;
  agentdUrl: string;
  /** The service bearer to agentd. */
  internalToken: string;
  fetchFn: typeof fetch;
  /** A write went through: drop what the gateway cached of the catalog. */
  changed: () => void;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

function isAdmin(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length) : '';
  return timingSafeEqual(digest(presented), digest(token));
}

export function registerAdminApps(app: Hono, deps: AdminAppsDeps): void {
  const base = deps.agentdUrl.replace(/\/$/, '') + '/v1/admin/apps';
  const guard: MiddlewareHandler = async (c, next) => {
    if (deps.adminToken === '') return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
    if (!isAdmin(c.req.header('authorization'), deps.adminToken)) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing admin token' } }, 401);
    await next();
    return undefined;
  };
  app.use('/admin/v1/apps', guard);
  app.use('/admin/v1/apps/*', guard);

  const relay = async (c: Context, method: 'GET' | 'POST' | 'PATCH', suffix: string): Promise<Response> => {
    const sendsBody = method !== 'GET' && !suffix.endsWith('/retire');
    let upstream: Response;
    try {
      upstream = await deps.fetchFn(base + suffix, {
        method,
        headers: { authorization: 'Bearer ' + deps.internalToken, ...(sendsBody ? { 'content-type': 'application/json' } : {}) },
        ...(sendsBody ? { body: await c.req.text() } : {}),
        redirect: 'manual',
        // A probe reaches out to a third party's server and may list its tools.
        signal: AbortSignal.timeout(suffix === '/probe' ? 45_000 : 10_000),
      });
    } catch {
      return c.json({ error: { code: 'ADMIN_UNAVAILABLE', message: 'The app catalog could not be reached' } }, 502);
    }
    const text = await upstream.text();
    if (method !== 'GET' && upstream.ok) deps.changed();
    return new Response(text, { status: upstream.status, headers: { 'content-type': 'application/json' } });
  };

  app.get('/admin/v1/apps', (c) => relay(c, 'GET', ''));
  app.post('/admin/v1/apps', (c) => relay(c, 'POST', ''));
  app.post('/admin/v1/apps/probe', (c) => relay(c, 'POST', '/probe'));
  app.patch('/admin/v1/apps/:id', (c) => relay(c, 'PATCH', '/' + encodeURIComponent(c.req.param('id'))));
  app.post('/admin/v1/apps/:id/retire', (c) => relay(c, 'POST', '/' + encodeURIComponent(c.req.param('id')) + '/retire'));
}
