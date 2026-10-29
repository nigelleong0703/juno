// PH7 pinned entry: importing the MCP suites registers their tests under this file, so the single
// pinned command exercises transport, protocol, discovery, cancellation and the production manager.
import './mcp-transport.suite.js';
import './mcp-manager.suite.js';
import './mcp-composition.suite.js';
import { afterAll, beforeAll } from 'vitest';

// These suites run their fixtures on 127.0.0.1; the MCP guard refuses loopback unless the test escape hatch is set.
let previousPrivateHosts: string | undefined;
beforeAll(() => {
  previousPrivateHosts = process.env.MCP_ALLOW_PRIVATE_HOSTS;
  process.env.MCP_ALLOW_PRIVATE_HOSTS = '1';
});
afterAll(() => {
  if (previousPrivateHosts === undefined) delete process.env.MCP_ALLOW_PRIVATE_HOSTS;
  else process.env.MCP_ALLOW_PRIVATE_HOSTS = previousPrivateHosts;
});
