/**
 * Registry-side MCP wiring.
 *
 * The registry caches nothing per owner. The catalog is resolved fresh for each agent from the
 * TRUSTED owner (the async-chain owner when present, else the agent row's persisted owner), discovery
 * honors the run's cancellation signal, and an MCP call is resolved AGAIN at execute time for the
 * calling context — never through a closure that remembers the original agent.
 */
import type { Store, Tool, ToolResult } from '../../../contracts/index.js';
import type { McpManager } from '../../mcp/index.js';
import { currentOwnerId } from '../../../owner-context.js';
import { BACKGROUND_OPTIONS } from '../../tasks/background-registry.js';
import { APPROVAL_ARG, approvalSchema } from '../../../execution/harness/services/decision/approval-arg.js';

/**
 * The owner an MCP catalog must be authorized against: the trusted async-chain owner wins, otherwise
 * the agent row's persisted owner. Undefined means no owner can be trusted, so no MCP tool is exposed.
 */
export async function resolveOwnerId(store: Store, agentId: string): Promise<string | undefined> {
  const trusted = currentOwnerId();
  if (trusted !== undefined && trusted !== '') return trusted;
  const agent: unknown = await store.get('agents', agentId);
  return ownerField(agent, 'createdBy') ?? ownerField(agent, 'ownerId');
}

function ownerField(agent: unknown, key: string): string | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined;
  const value: unknown = Reflect.get(agent, key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The run turn a tool call belongs to (`runId:stepId`). An MCP connection re-lists at most once per turn, so every
 * listing made for the same model step shares this key.
 */
export function toolTurn(ctx: { runId: string; stepId?: string }): string {
  return ctx.runId + ':' + (ctx.stepId ?? '');
}

/** The MCP tools an agent may currently use, minus names the static toolset already owns. */
export async function mcpToolsForAgent(
  mcp: McpManager,
  store: Store,
  agentId: string,
  taken: Set<string>,
  signal?: AbortSignal,
  turn?: string,
): Promise<Tool[]> {
  const ownerId = await resolveOwnerId(store, agentId);
  if (ownerId === undefined) return [];
  const discovered = await mcp.toolsForAgent({
    ownerId,
    store,
    agentId,
    ...(signal === undefined ? {} : { signal }),
    ...(turn === undefined ? {} : { turn }),
  });
  return discovered.filter((tool) => !taken.has(tool.name)).map(withBackgroundOption);
}

/**
 * H-73: every MCP tool accepts `background: true` (stripped before the server sees it): the call is
 * authorized as usual, runs outside this turn, and its result returns as a task_done.
 */
/** Whether the harness adds `approval` to this tool: an action tool whose own schema has no argument of that name. */
function takesInjectedApproval(tool: Tool): boolean {
  const props: unknown = Reflect.get(tool.parameters, 'properties');
  return tool.origin?.access === 'action' && !(typeof props === 'object' && props !== null && APPROVAL_ARG in props);
}

function withBackgroundOption(tool: Tool): Tool {
  const params = tool.parameters;
  const props: unknown = Reflect.get(params, 'properties');
  const properties = typeof props === 'object' && props !== null ? props : {};
  // An action tool also takes `approval` (BACKEND 8.1): the agent's sentence, reason and "if denied" for the decision card. A
  // tool whose own schema already has an `approval` argument keeps it, and nothing is stripped.
  const inject = takesInjectedApproval(tool);
  return {
    ...tool,
    parameters: {
      ...params,
      properties: {
        ...properties,
        ...(inject ? { [APPROVAL_ARG]: approvalSchema(true) } : {}),
        background: { type: 'boolean', description: 'Run this call in the background: you may finish the turn and are woken with a task_done carrying its result.' },
        taskTitle: { type: 'string', description: "With background: short imperative phrase of the task for the user's task list, e.g. 'Export the Q3 sales report'." },
      },
    },
  };
}

/**
 * The execution handle for one MCP tool name. It holds no client and no cached tool: `execute`
 * re-reads the CALLING context's catalog (that ctx's owner, store, agent and signal) and delegates to
 * the fresh binding, so a removed, disconnected or re-owned tool is refused instead of running from a
 * stale helper.
 */
export function createMcpDispatchTool(name: string, mcp: McpManager): Tool {
  return {
    name,
    description: 'MCP tool; authorization and the live server session are resolved when the tool is called.',
    parameters: { type: 'object', properties: {} },
    replay: 'never',
    sideEffect: true,
    mcp: true,
    async execute(args: unknown, ctx): Promise<ToolResult> {
      const ownerId = currentOwnerId() ?? ctx.ownerId;
      const available = await mcp.toolsForAgent({ ownerId, store: ctx.store, agentId: ctx.agentId, signal: ctx.signal, turn: toolTurn(ctx) });
      const found = available.find((tool) => tool.name === name);
      if (found === undefined) {
        return {
          content: [{ type: 'text', text: 'this app no longer offers ' + name + ' (it was removed, disconnected or is not configured); search again with tool_search' }],
          isError: true,
          details: { mcp: true, tool: name, unavailable: true },
        };
      }
      // `background` and `taskTitle` are harness options (H-73), never server arguments.
      // So is `approval` when the harness added it.
      const harness = takesInjectedApproval(found) ? [...BACKGROUND_OPTIONS, APPROVAL_ARG] : BACKGROUND_OPTIONS;
      const serverArgs = typeof args === 'object' && args !== null ? Object.fromEntries(Object.entries(args).filter(([key]) => !harness.includes(key))) : args;
      return found.execute(serverArgs, ctx);
    },
  };
}
