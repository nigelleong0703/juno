// MCP runtime and OAuth surface for the API gateway (connect flow) and tests; the implementation lives in juno-agent.
export * from 'juno-agent/modules/mcp/index';
export { mcpToolsForAgent } from 'juno-agent/modules/tools/tools/mcpTools';
// The Apps view of a connection, shared with agentd so the gateway answers `install` with the same installation the Apps page lists.
export { appIdOfConnection, connectionInstallation, connectionStanding } from 'juno-agent/modules/apps/agent-apps';
