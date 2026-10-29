import { validateToolArguments, type ToolCall as PiToolCall } from '@earendil-works/pi-ai';
import type { Doc, Tool, ToolResult } from '../../../contracts/index.js';
import { checkArguments, invalidArgumentsResult, normalizeOptionalStrings } from '../../../modules/tools/toolArguments.js';
import { isDiscoveryTool, TOOL_LOAD, TOOL_SEARCH } from '../../../modules/tools/tools/toolSearch.js';
import { appendRunStep } from './run-steps.js';
import type { RunInput, RunServices } from './run-types.js';

type Call = { name: string; arguments: Record<string, unknown> };

/**
 * A model call at the argument boundary, before policy and approval see it: an optional string the model left "", blank or null is
 * taken out (each one logged: tool, field, model, so the rate per model can be counted), then the arguments are checked against the
 * tool's JSON Schema. A call that fails the check never reaches an approval card; the model gets the teaching error instead.
 * Connected-app (MCP) tools are the server's own schema and are passed through.
 */
export function checkedCall<C extends Call>(services: RunServices, input: RunInput, runId: string, call: C): { call: C; invalid: ToolResult | null } {
  const tool = services.toolRegistry.get(call.name);
  if (tool === undefined || tool.mcp === true) return { call, invalid: null };
  const { args: cleaned, normalized } = normalizeOptionalStrings(tool, call.arguments);
  for (const entry of normalized) services.log?.({ tool: call.name, field: entry.field, was: entry.was, model: input.modelId, runId }, 'tool argument normalized');
  const args = withSafeCoercion(tool, cleaned);
  // The one orchestrated browser tool answers a bad call itself, with guidance that is specific to its stages.
  const issues = tool.orchestrate === undefined ? checkArguments(tool, args) : [];
  return { call: args === call.arguments ? call : { ...call, arguments: args }, invalid: issues.length === 0 ? null : invalidArgumentsResult(tool, issues) };
}

/**
 * The type coercion the agent core used to apply before validation ("5" for a number, 1 for a boolean): the arguments as core's
 * schema check would have made them, or unchanged when they do not fit (the schema check after this one then names what is wrong).
 */
function withSafeCoercion(tool: Tool, args: Record<string, unknown>): Record<string, unknown> {
  try {
    // The arguments came from the model as JSON; a round trip gives pi-ai's JSON type without an assertion.
    const json: PiToolCall['arguments'] = JSON.parse(JSON.stringify(args));
    const coerced: unknown = validateToolArguments({ name: tool.name, description: tool.description, parameters: tool.parameters }, { type: 'toolCall', id: 'check', name: tool.name, arguments: json });
    return typeof coerced === 'object' && coerced !== null && !Array.isArray(coerced) ? { ...coerced } : args;
  } catch {
    return args;
  }
}

const QUERY_MAX = 200;

/** What a discovery step asked for: the search query, or the names to load. */
export function searchQueryOf(call: Call): string | undefined {
  const raw = call.name === TOOL_SEARCH ? call.arguments['query'] : call.name === TOOL_LOAD ? call.arguments['names'] : undefined;
  const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.filter((name): name is string => typeof name === 'string').join(', ') : undefined;
  return text === undefined ? undefined : text.slice(0, QUERY_MAX);
}

/**
 * What a new step knows from the run so far: `retryOf` when the previous call to the same tool failed, and, for any tool other than a
 * discovery one, the earlier `tool_search`/`tool_load` step that has not yet seen a call after it: that step records which tool was then
 * actually called (`calledTool`). Runs inside the journaled step creation, so a replay does not link twice.
 */
export async function linkToRun(services: RunServices, runId: string, step: Doc<'steps'>): Promise<{ retryOf?: string }> {
  const steps = (await services.store.get('runs', runId))?.steps ?? [];
  const tool = step.tool;
  if (tool === undefined) return {};
  if (!isDiscoveryTool(tool)) {
    const search = [...steps].reverse().find((earlier) => earlier.tool !== undefined && (earlier.tool === TOOL_SEARCH || earlier.tool === TOOL_LOAD) && earlier.calledTool === undefined);
    if (search !== undefined) {
      const linked = await services.store.patch('steps', search.id, { calledTool: tool });
      await appendRunStep(services.store, runId, linked);
    }
  }
  const previous = [...steps].reverse().find((earlier) => earlier.tool === tool && earlier.id !== step.id);
  return previous?.status === 'failed' ? { retryOf: previous.id } : {};
}
