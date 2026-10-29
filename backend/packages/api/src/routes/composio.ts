/**
 * `GET /oauth/composio/callback`: where the browser lands after the owner logs in to an app at Composio (BACKEND 10.18.3). Public like
 * `/oauth/mcp/callback` (a browser carries no bearer token); the state is the only credential, redeemed once, and the outcome is whatever Composio
 * itself says about the connected account, not anything in the query.
 */
import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Store } from '@agent-desktop/contracts';
import { SecretsError } from '@agent-desktop/contracts/secrets';
import { COMPOSIO_CALLBACK_PATH, completeComposioLogin, type ComposioClient } from '../modules/composio.js';
import { McpAuthorizationError, returnLocation } from '../modules/mcp-authorization.js';
import type { CatalogEntry } from '../modules/connector-catalog.js';

export interface ComposioCallbackDeps {
  store: Store;
  composio: ComposioClient;
  /** The apps held, to find a connection's toolkit. */
  catalog: () => Promise<readonly CatalogEntry[]>;
  returnUrl: string;
  connectionsChanged?: (ownerId: string) => void;
}

export function registerComposioCallback(app: Hono, deps: ComposioCallbackDeps): void {
  app.get(COMPOSIO_CALLBACK_PATH, async (c) => {
    const state = c.req.query('state');
    if (state === undefined || state === '') return c.json({ error: { code: 'COMPOSIO_STATE_INVALID', message: 'The login link is invalid or has expired' } }, 400);
    try {
      const outcome = await completeComposioLogin({
        store: deps.store,
        composio: deps.composio,
        toolkitOf: async (catalogId) => (await deps.catalog()).find((entry) => entry.id === catalogId)?.toolkit,
        returnUrl: deps.returnUrl,
      }, state);
      if (outcome.status === 'connected') deps.connectionsChanged?.(outcome.ownerId);
      return c.redirect(returnLocation(outcome.returnUrl, outcome.connectionId, outcome.status), 302);
    } catch (error) {
      if (error instanceof McpAuthorizationError) return c.json({ error: { code: error.code, message: error.message } }, error.status as ContentfulStatusCode);
      if (error instanceof SecretsError) return c.json({ error: { code: 'SECRETS_UNAVAILABLE', message: 'Credential storage is not configured on this deployment' } }, 503);
      throw error;
    }
  });
}
