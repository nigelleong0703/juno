// Jev's authorization boundary around the ordinary MCP manager. The wrapper stays installed even
// when the feature is off, because a persisted managed row must not become a startup bypass later.
import type { Store, Tool } from '../contracts/index.js';
import type { BackendConfig } from './config.js';
import type { McpManager } from '../modules/mcp/index.js';
import { currentOwnerId } from '../owner-context.js';
import { createJevRelayBridge } from '../modules/mcp/jev-relay-bridge.js';
import type { SandboxStdioBridge } from '../modules/mcp/stdio-transport.js';
import type { ComputerClient } from '../modules/tools/index.js';
import {
  handleJevRelay,
  isJevConnectionId,
  jevConnectionIdForOwner,
  JEV_BROWSER_MCP_COMMAND,
  JEV_BROWSER_MCP_WRAPPER,
  resolveJevNative,
} from './jev-browser-mcp.js';
import { addJevRelaySignal, getJevRelaySignal, removeJevRelaySignal } from './jev-relay-signals.js';
import { ensureJevConnection, hideJevStore } from './jev-managed-store.js';

export { JEV_CONNECTION_PREFIX, jevConnectionIdForOwner, isJevConnectionId } from './jev-browser-mcp.js';

export function isJevTool(tool: { name: string } & { origin?: { connectionId?: string } }): boolean {
  if (typeof tool !== 'object' || tool === null) return false;
  const origin = Reflect.get(tool, 'origin');
  if (typeof origin !== 'object' || origin === null) return false;
  return isJevConnectionId(Reflect.get(origin, 'connectionId'));
}

function ownerOf(input: { ownerId?: string }): string | undefined {
  return currentOwnerId() ?? (input.ownerId === '' ? undefined : input.ownerId);
}

function scopedStore(store: Store, ownerId: string): Store {
  return store.forOwner === undefined ? store : store.forOwner(ownerId);
}

/** Re-resolve the operator flag and real native on every authorization decision. */
export async function jevGatePass(store: Store, config: BackendConfig, ownerId: string | undefined): Promise<boolean> {
  if (ownerId === undefined || ownerId === '') return false;
  const selection = await resolveJevNative(scopedStore(store, ownerId), ownerId, config).catch(() => undefined);
  return selection !== undefined;
}

function wrapJevTool(tool: Tool, store: Store, config: BackendConfig): Tool {
  if (!isJevTool(tool)) return tool;
  const original = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(args, ctx) {
      if (tool.origin === undefined || tool.origin.connectionId !== jevConnectionIdForOwner(ctx.ownerId)) {
        throw new Error('MCP tool is not available for this agent (owner or connection changed)');
      }
      if (!(await jevGatePass(scopedStore(store, ctx.ownerId), config, ctx.ownerId))) {
        throw new Error('MCP tool is not available for this agent (disconnected, unconfigured, or removed)');
      }
      addJevRelaySignal(ctx.ownerId, ctx.agentId, ctx.signal);
      try {
        return await original(args, ctx);
      } finally {
        removeJevRelaySignal(ctx.ownerId, ctx.agentId, ctx.signal);
      }
    },
  };
}

export function createJevGatedManager(base: McpManager, store: Store, config: BackendConfig): McpManager {
  return {
    async connect(input) {
      if (isJevConnectionId(input.connectionId)) {
        const owner = ownerOf(input);
        if (!(await jevGatePass(store, config, owner))) throw new Error('MCP connection is not available');
        if (owner === undefined || input.connectionId !== jevConnectionIdForOwner(owner)) throw new Error('MCP connection is not available');
        return base.connect({ ...input, ownerId: owner });
      }
      return base.connect(input);
    },
    async toolsForAgent(input) {
      const owner = ownerOf(input);
      if (!(await jevGatePass(store, config, owner))) {
        return base.toolsForAgent({ ...input, store: hideJevStore(input.store) });
      }
      if (owner === undefined) return base.toolsForAgent({ ...input, store: hideJevStore(input.store) });
      const scoped = scopedStore(input.store, owner);
      if (!(await ensureJevConnection(scoped, owner))) {
        return base.toolsForAgent({ ...input, store: hideJevStore(input.store) });
      }
      const tools = await base.toolsForAgent({ ...input, ownerId: owner });
      return tools.map((tool) => wrapJevTool(tool, scoped, config));
    },
    async callTool(input) {
      if (!isJevConnectionId(input.connectionId)) return base.callTool(input);
      const owner = ownerOf(input);
      if (!(await jevGatePass(store, config, owner))) throw new Error('MCP connection is not available');
      if (owner === undefined || input.connectionId !== jevConnectionIdForOwner(owner)) throw new Error('MCP connection is not available');
      addJevRelaySignal(owner, input.agentId, input.signal);
      try {
        return await base.callTool({ ...input, ownerId: owner });
      } finally {
        removeJevRelaySignal(owner, input.agentId, input.signal);
      }
    },
    async listTools(input) {
      if (isJevConnectionId(input.connectionId)) {
        const owner = ownerOf(input);
        if (!(await jevGatePass(store, config, owner))) throw new Error('MCP connection is not available');
        if (owner === undefined || input.connectionId !== jevConnectionIdForOwner(owner)) throw new Error('MCP connection is not available');
        return base.listTools({ ...input, ownerId: owner });
      }
      return base.listTools(input);
    },
    async disconnect(input) {
      if (isJevConnectionId(input.connectionId)) {
        const owner = ownerOf(input);
        if (owner === undefined || input.connectionId !== jevConnectionIdForOwner(owner)) throw new Error('MCP connection is not available');
        return base.disconnect({ ...input, ownerId: owner });
      }
      return base.disconnect(input);
    },
    async status(input) {
      if (isJevConnectionId(input.connectionId)) {
        const owner = ownerOf(input);
        if (!(await jevGatePass(store, config, owner))) return { state: 'disconnected' };
        if (owner === undefined || input.connectionId !== jevConnectionIdForOwner(owner)) return { state: 'disconnected' };
        return base.status({ ...input, ownerId: owner });
      }
      return base.status(input);
    },
    probe: (input) => base.probe(input),
    close: () => base.close(),
  };
}

export function createJevMcpRuntime(input: {
  computer: ComputerClient | undefined;
  store: Store;
  config: BackendConfig;
}): { stdioForAgent: (args: { ownerId: string; agentId: string | undefined }) => SandboxStdioBridge | undefined } {
  const client = input.computer;
  if (client === undefined) return { stdioForAgent: () => undefined };
  return {
    stdioForAgent: (args) => {
      if (args.agentId === undefined || args.agentId === '') return undefined;
      const trustedOwner = currentOwnerId() ?? args.ownerId;
      const agentId = args.agentId;
      return createJevRelayBridge({
        client,
        agentId,
        jevCommand: JEV_BROWSER_MCP_COMMAND,
        jevWrapper: JEV_BROWSER_MCP_WRAPPER,
        relay: (params, signal) => handleJevRelay({ store: input.store, config: input.config, ownerId: trustedOwner, signal }, params),
        activeSignal: () => getJevRelaySignal(trustedOwner, agentId),
      });
    },
  };
}
