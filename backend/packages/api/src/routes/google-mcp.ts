/**
 * Public routes of the Google MCP servers this gateway hosts (modules/google-mcp.ts): the MCP endpoint and its
 * RFC 9728 metadata at the path-aware well-known URL. No session: the bearer is the caller's Google token.
 */
import type { Hono } from 'hono';
import { GOOGLE_MCP_PATH, googleMcpResourceMetadata, handleGoogleMcp, isGoogleMcpService, type GoogleMcpDeps } from '../modules/google-mcp.js';

import { HEVY_MCP_PATH, handleHevyMcp, type HevyMcpDeps } from '../modules/hevy-mcp.js';

export function registerGoogleMcp(app: Hono, deps: GoogleMcpDeps, hevy: HevyMcpDeps = {}): void {
  app.get('/.well-known/oauth-protected-resource' + GOOGLE_MCP_PATH + ':service', (c) => {
    const service = c.req.param('service') ?? '';
    return isGoogleMcpService(service) ? c.json(googleMcpResourceMetadata(deps, service)) : c.notFound();
  });
  // Hevy has no sign-in: the caller's own Hevy key is the credential (modules/hevy-mcp.ts).
  app.all(HEVY_MCP_PATH, (c) => handleHevyMcp(hevy, c.req.raw));
  app.all(GOOGLE_MCP_PATH + ':service', (c) => handleGoogleMcp(deps, c.req.param('service') ?? '', c.req.raw));
}
