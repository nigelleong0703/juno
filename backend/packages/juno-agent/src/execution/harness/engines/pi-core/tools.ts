/**
 * pi-agent-core tool bindings.
 *
 * Core owns the tool boundary: argument preparation, schema validation, `beforeToolCall`,
 * execution and `afterToolCall`. Each call is forwarded to the caller's single-call adapter,
 * which runs the authoritative durable path (existing run-tools/run-input helpers) and returns
 * the concrete tool result. An unknown tool fails before any effect, and the harness checks the arguments
 * against the product tool's own JSON schema before policy and approval; core never reaches `execute`.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Tool, ToolRegistry } from '../../../../contracts/index.js';
import { toolsForModel } from '../../../../modules/tools/tools/toolSearch.js';

export interface CoreToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** True for a plain object; core passes the schema-validated tool arguments. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A tool call's source index within its turn, so journal naming stays stable across retries. */
export function toolIndexOf(toolCalls: Array<{ id: string }>, id: string, fallback: number): number {
  const index = toolCalls.findIndex((call) => call.id === id);
  return index >= 0 ? index : fallback;
}

/**
 * Discover the agent's tools. Discovery can be aborted (a real MCP initialize handshake must be
 * cancellable); a discovery aborted by the run's stop returns null so the caller reports a stop
 * instead of a failed run.
 */
export async function discoverTools(registry: ToolRegistry, agentId: string, signal: AbortSignal, options: { goalMode?: boolean; reactions?: boolean; ownerOnly?: boolean; quietExit?: boolean; turn?: string } = {}): Promise<Tool[] | null> {
  const { goalMode, reactions, ownerOnly, quietExit, turn } = options;
  try {
    // The registry holds every tool; the model is shown a short list and reaches the rest through tool_search (the hidden
    // ones come last, marked `deferLoading`), and the policy keeps reading the full list, so a hidden tool still has to pass its rules.
    // A tool that is owner-only is not offered to a run where anyone else is in the chat.
    // A tool that is unattended-only (finish_quietly) is offered only to a run nobody is waiting on.
    const offered = (await registry.forAgent(agentId, turn === undefined ? { signal } : { signal, turn }))
      .filter((tool) => (tool.ownerOnly !== true || ownerOnly === true) && (tool.unattendedOnly !== true || quietExit === true));
    return toolsForModel(offered, goalMode === undefined ? process.env : { ...process.env, BROWSER_INTERFACE: goalMode ? 'goal' : 'direct' }, { reactions: reactions === true, quietExit: quietExit === true });
  } catch (error) {
    if (signal.aborted) return null;
    throw error;
  }
}

/**
 * Core does not validate any tool's arguments: the harness does, in one place (run-tool-check.ts), after it has left out the optional
 * strings a model filled with "" (core's own check would reject an empty enum value first) and with the same teaching error for every tool.
 */
const ANY_ARGUMENTS = { type: 'object', additionalProperties: true };

export function toAgentTools(tools: Tool[], execute: (call: CoreToolCall) => Promise<AgentToolResult>): AgentTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: ANY_ARGUMENTS,
    executionMode: 'sequential',
    execute: async (toolCallId, params) => execute({ id: toolCallId, name: tool.name, args: params }),
  }));
}
