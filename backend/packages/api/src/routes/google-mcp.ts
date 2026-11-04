/**
 * Routes of the MCP servers this gateway hosts (modules/google-mcp.ts). The MCP endpoints are reachable through the public
 * api origin but internal: each handler answers 401 unless the request carries HOSTED_MCP_TOKEN (modules/hosted-mcp-auth.ts). Only the
 * RFC 9728 metadata at the path-aware well-known URL is open: our own connect flow (modules/mcp-authorization.ts) discovers Google's
 * authorization server from it, and it holds only the issuer and the scopes. No session; the owner's token rides in X-Upstream-Authorization.
 */
import type { Hono } from 'hono';
import { GOOGLE_MCP_PATH, googleMcpResourceMetadata, handleGoogleMcp, isGoogleMcpService, type GoogleMcpDeps } from '../modules/google-mcp.js';

export function registerGoogleMcp(app: Hono, deps: GoogleMcpDeps): void {
  app.get('/.well-known/oauth-protected-resource' + GOOGLE_MCP_PATH + ':service', (c) => {
    const service = c.req.param('service') ?? '';
    return isGoogleMcpService(service) ? c.json(googleMcpResourceMetadata(deps, service)) : c.notFound();
  });
  app.all(GOOGLE_MCP_PATH + ':service', (c) => handleGoogleMcp(deps, c.req.param('service') ?? '', c.req.raw));
}
