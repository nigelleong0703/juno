/**
 * MCP connect callback. `GET /oauth/mcp/callback` is the browser redirect target of an app's sign-in (started by
 * `POST /v1/apps/:id/install`, routes/apps.ts): it sits on the public surface beside /auth/* because a browser carries no bearer
 * token; the state it verifies is the only credential it accepts.
 */
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { SecretsError } from '@agent-desktop/contracts/secrets';
import { clientMetadataDocument } from '@agent-desktop/contracts/mcp';
import {
  CALLBACK_PATH,
  CLIENT_METADATA_PATH,
  clientMetadataUrl,
  clientRedirectUris,
  completeMcpAuthorization,
  McpAuthorizationError,
  returnLocation,
  type McpAuthorizationDeps,
} from '../modules/mcp-authorization.js';

/**
 * The origin the client used: behind a proxy (Tailscale serve) the forwarded host and scheme, else the request
 * URL. Only a hint: startMcpAuthorization accepts it only when it is an allow-listed public origin.
 */
export function requestOrigin(request: Request): string | undefined {
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  if (host === undefined || host === '') return new URL(request.url).origin;
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? 'https';
  return proto + '://' + host;
}

function errorResponse(c: Context, error: McpAuthorizationError): Response {
  return c.json({ error: { code: error.code, message: error.message } }, error.status as ContentfulStatusCode);
}

/** A missing or wrong SECRETS_KEY is a deployment gap, reported without the key or any value. */
function secretsResponse(c: Context): Response {
  return c.json({ error: { code: 'SECRETS_UNAVAILABLE', message: 'Credential storage is not configured on this deployment' } }, 503);
}

export function registerMcpCallback(app: Hono, deps: McpAuthorizationDeps): void {
  // The client metadata document (CIMD): a provider that supports it fetches this URL, which is our client id, to learn our name and
  // redirect URIs. Public by nature; it holds nothing secret. Served only when this deployment has an https address to be a client id.
  app.get(CLIENT_METADATA_PATH, (c) => {
    const clientId = clientMetadataUrl(deps);
    if (clientId === undefined) return c.json({ error: { code: 'MCP_OAUTH_NOT_CONFIGURED', message: 'No public https address is configured to host a client metadata document' } }, 404);
    return c.json(clientMetadataDocument(clientId, clientRedirectUris(deps)), 200, { 'cache-control': 'public, max-age=3600' });
  });
  app.get(CALLBACK_PATH, async (c) => {
    if (deps.publicUrl === undefined) {
      return c.json({ error: { code: 'MCP_OAUTH_NOT_CONFIGURED', message: 'MCP authorization is not configured on this deployment' } }, 503);
    }
    const state = c.req.query('state');
    if (state === undefined || state === '') {
      return c.json({ error: { code: 'MCP_OAUTH_STATE_INVALID', message: 'The authorization link is invalid or has expired' } }, 400);
    }
    const code = c.req.query('code');
    const denied = c.req.query('error');
    try {
      const outcome = await completeMcpAuthorization(deps, {
        state,
        ...(code === undefined ? {} : { code }),
        ...(denied === undefined ? {} : { error: denied }),
      });
      if (outcome.status === 'connected') deps.connectionsChanged?.(outcome.ownerId);
      return c.redirect(returnLocation(outcome.returnUrl, outcome.connectionId, outcome.status), 302);
    } catch (error) {
      if (error instanceof McpAuthorizationError) return errorResponse(c, error);
      if (error instanceof SecretsError) return secretsResponse(c);
      throw error;
    }
  });
}
