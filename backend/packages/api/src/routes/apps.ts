/**
 * Adding and removing the work and custom apps (owner-scoped). The Apps routes are agentd's (routes/agentd-routes.ts); these two are the
 * part the gateway answers itself because it owns the OAuth callback, and a request for a chat app (or anything else) falls through to
 * the forwarded route:
 *
 * POST   /v1/apps/custom/probe                       what an MCP server at a URL asks for (login kind, tools with suggested marks); stores nothing
 * POST   /v1/apps/:id/install                        a catalog app, or `custom` for an MCP server by URL (with the owner's confirmation of the probe)
 * DELETE /v1/apps/:id/installations/:installationId  one account of an app, or a custom server
 */
import type { Context, Hono, Next } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { installAppCustomInputSchema, installAppWorkInputSchema, probeCustomAppInputSchema } from '@agent-desktop/public-contracts';
import { SecretsError } from '@agent-desktop/contracts/secrets';
import { requestOwner } from '../owner.js';
import { McpConfigError } from '../modules/integrations.js';
import { McpAuthorizationError } from '../modules/mcp-authorization.js';
import { installCustomApp, installWorkApp, probeCustomApp, removeAppInstallation, type ConnectorsDeps } from '../modules/connectors.js';
import { requestOrigin } from './mcp-authorization.js';

/** The custom app's install id: a template, not an app of its own (each server added is an app named by its connection). */
const CUSTOM = 'custom';

async function guarded(c: Context, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpAuthorizationError) return c.json({ error: { code: error.code, message: error.message } }, error.status as ContentfulStatusCode);
    if (error instanceof McpConfigError) return c.json({ error: { code: error.code, message: error.message } }, 400);
    if (error instanceof SecretsError) return c.json({ error: { code: 'SECRETS_UNAVAILABLE', message: 'Credential storage is not configured on this deployment' } }, 503);
    throw error;
  }
}

async function bodyOf(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const invalid = (c: Context, what: string): Response => c.json({ error: { code: 'VALIDATION_ERROR', message: what } }, 400);

export function registerAppsInstall(app: Hono, deps: ConnectorsDeps): void {
  app.post('/v1/apps/custom/probe', (c: Context) => guarded(c, async () => {
    const parsed = probeCustomAppInputSchema.safeParse(await bodyOf(c));
    if (!parsed.success) return invalid(c, 'The body must be {url}');
    return c.json(await probeCustomApp(deps, parsed.data.url));
  }));

  app.post('/v1/apps/:id/install', async (c: Context, next: Next) => {
    const appId = c.req.param('id') ?? '';
    // Anything that is not a catalog app or `custom` is a chat app (or nothing): agentd answers.
    if (appId !== CUSTOM && !(await deps.catalog()).some((entry) => entry.id === appId)) return next();
    return guarded(c, async () => {
      const body = await bodyOf(c);
      const owner = requestOwner(c);
      if (appId === CUSTOM) {
        const parsed = installAppCustomInputSchema.safeParse(body);
        if (!parsed.success) return invalid(c, 'The body must be an MCP server ({name, url, confirm} or {name, command, args?, env?}) or {connectionId}');
        return c.json(await installCustomApp(deps, owner, parsed.data, requestOrigin(c.req.raw)), 201);
      }
      const parsed = installAppWorkInputSchema.strict().safeParse(body);
      if (!parsed.success) return invalid(c, 'The body must be {returnUrl?, userConfig?, connectionId?}');
      return c.json(await installWorkApp(deps, owner, appId, parsed.data, requestOrigin(c.req.raw)), 201);
    });
  });

  app.delete('/v1/apps/:id/installations/:installationId', async (c: Context, next: Next) => {
    const owner = requestOwner(c);
    const scoped = deps.authorization.store.forOwner?.(owner);
    if (scoped === undefined) throw new Error('store is missing forOwner; refusing an unscoped app removal');
    // A connection row of this owner is ours; a workspace or bot id is a chat installation, which agentd removes.
    if ((await scoped.get('connections', c.req.param('installationId') ?? '')) === null) return next();
    return guarded(c, async () => {
      await removeAppInstallation(deps, owner, c.req.param('id') ?? '', c.req.param('installationId') ?? '');
      return c.body(null, 204);
    });
  });
}
