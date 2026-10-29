/** Routes of the Singapore MCP servers this gateway hosts (modules/sg-mcp.ts). Internal token only; no OAuth metadata. */
import type { Hono } from 'hono';
import { handleSgMcp, SG_MCP_PATH, type SgMcpDeps } from '../modules/sg-mcp.js';
import { LTA_BASE } from '../modules/sg/transport.js';

export function registerSgMcp(app: Hono, deps: SgMcpDeps): void {
  const shared: SgMcpDeps = { ...deps, cache: deps.cache ?? new Map() };
  app.all(SG_MCP_PATH + ':service', (c) => handleSgMcp(shared, c.req.param('service') ?? '', c.req.raw, [LTA_BASE]));
}
