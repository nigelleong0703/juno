// Configured owner MCP runtime: build a session for a stored server, discover its tools, and expose
// them as agent tools. The registry owner wires createMcpClient/createMcpTool into the run loop.
import { McpClient } from './client.js';
import type { McpServerConfig } from './config.js';
import { HttpMcpTransport } from './http-transport.js';
import { McpUnsupportedError } from './protocol.js';
import { StdioMcpTransport, type SandboxStdioBridge } from './stdio-transport.js';

export * from './protocol.js';
export * from './config.js';
export * from './client.js';
export * from './access-error.js';
export * from './connections.js';
export * from './registry.js';
export * from './manager.js';
export * from './tool-access.js';
export { markToolsReviewed, type ToolLedger } from './tool-ledger.js';
export * from './oauth.js';
export { mergeScopes, parseChallenge, type Challenge } from './challenge.js';
export * from './catalog.js';
export * from './composio.js';
export * from './probe.js';
export { missingDefaultConnections, platformKeyConfigured, PLATFORM_KEY_SERVERS } from './platform-keys.js';
export { createOAuthAuthorizer, type OAuthAuthorizerInput } from './oauth-tokens.js';
export type { McpTransport, McpRequestOptions } from './transport.js';
export type { SandboxStdioBridge, SandboxStdioChannel } from './stdio-transport.js';
export { HttpMcpTransport } from './http-transport.js';
export { createGuardedFetch, createModelFetch, guardedFetch, mcpUrlRefused, modelUrlRefused, privateHostsAllowed, MCP_ALLOW_PRIVATE_HOSTS, HOSTED_MCP_PATH, SG_MCP_PATH } from '../tools/net/guardedFetch.js';
export { StdioMcpTransport } from './stdio-transport.js';

export interface McpRuntimeDeps {
  /** computerd's qualified sandbox bridge; required for stdio servers (the host never spawns). */
  stdio?: SandboxStdioBridge;
  fetchImpl?: typeof fetch;
}

export function createMcpClient(config: McpServerConfig, deps: McpRuntimeDeps = {}): McpClient {
  if (config.transport === 'http') {
    const options = deps.fetchImpl === undefined ? { url: config.url } : { url: config.url, fetchImpl: deps.fetchImpl };
    return new McpClient(() => new HttpMcpTransport(options));
  }
  if (deps.stdio === undefined) {
    throw new McpUnsupportedError('stdio MCP requires the qualified sandbox bridge; the host does not spawn processes');
  }
  const bridge = deps.stdio;
  const options = config.env === undefined
    ? { bridge, command: config.command, args: config.args }
    : { bridge, command: config.command, args: config.args, env: config.env };
  return new McpClient(() => new StdioMcpTransport(options));
}
