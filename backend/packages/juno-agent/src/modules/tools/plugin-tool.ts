import type { Tool, ToolRegistry } from '../../contracts/index.js';

/** What a build receives: the registry's view of every tool an agent can use (a tool that watches the others needs it). */
export type ToolLookup = Pick<ToolRegistry, 'forAgent'>;

/** A plugin tool built once the registry exists, for a tool that needs the registry's other tools. `name` is what the registry checks. */
export interface PluginToolBuild {
  name: string;
  build(tools: ToolLookup): Tool;
}

/**
 * A tool a host plugin adds to the registry (agentd's plugin host collects them once at start; see docs/BACKEND.md
 * "Plugins"). `visibleFor` is the per-agent offer rule for tools that only some agents may use; the tool stays
 * registered (replay, policy and `registry.get` see it), only the model-visible list leaves it out. `connectedApp` (default
 * true) marks the tool as a connected app's: hidden outside the owner's own chat. A first-party tool the built-in scope rules
 * fit sets it false, so it is offered wherever a built-in tool is.
 */
export interface PluginTool {
  tool: Tool | PluginToolBuild;
  visibleFor?(agentId: string): Promise<boolean>;
  connectedApp?: boolean;
}
