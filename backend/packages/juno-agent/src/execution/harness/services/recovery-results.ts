import { z } from 'zod';
import type { Tool, ToolContext, ToolReconciliation, ToolResult } from '../../../contracts/index.js';
import { invalidArgumentsResult, withTeachingExample, zodArgumentIssues } from '../../../modules/tools/toolArguments.js';
import { captureOversizedResult } from './output-capture.js';
import { projectResult, redactText } from './tool-projection.js';
import type { RunServices } from './run-types.js';

type ToolCall = { name: string; arguments: Record<string, unknown> };

/** The per-tool 60s limit ran out (not a stop of the run). */
function timedOut(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason;
  return signal.aborted && reason instanceof Error && reason.name === 'TimeoutError';
}

export async function executeSafely(tool: Tool, call: ToolCall, context: ToolContext): Promise<ToolResult> {
  try {
    const result = withTeachingExample(tool, await tool.execute(call.arguments, context));
    if (result.isError !== true || result.details?.['errorKind'] !== undefined) return result;
    // The 60s limit, or a connected app's failure (the outside service's); every other tool marks its own kind (validation) or stays "other".
    const errorKind = timedOut(context.signal) ? 'timeout' : tool.mcp === true ? 'external' : undefined;
    return errorKind === undefined ? result : { ...result, details: { ...result.details, errorKind } };
  } catch (error) {
    // A tool that parses its own arguments with `parse` throws the zod error: the model reads the same teaching error as for any other
    // invalid argument, not the zod dump.
    if (error instanceof z.ZodError) return invalidArgumentsResult(tool, zodArgumentIssues(call.arguments, error));
    const text = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `Tool ${call.name} failed: ${text}` }], isError: true, details: { errorKind: timedOut(context.signal) ? 'timeout' : 'harness' } };
  }
}

export async function reconcileWithProjection(services: Pick<RunServices, 'store'>, tool: Tool, args: Record<string, unknown>, context: ToolContext): Promise<ToolReconciliation> {
  if (tool.reconcile === undefined) return { status: 'unknown', reason: 'no read-only result check is available for this tool' };
  if (context.stepId === undefined) return { status: 'failed', reason: 'the durable action identity is unavailable' };
  const evidence = await tool.reconcile(args, context);
  if (evidence.status === 'succeeded') {
    const captured = await captureOversizedResult(services.store, {
      ownerId: context.ownerId, agentId: context.agentId, runId: context.runId, stepId: context.stepId, tool: tool.name,
    }, evidence.result, context.signal);
    return { ...evidence, evidence: redactText(evidence.evidence).slice(0, 500), result: projectResult(captured) };
  }
  return evidence.status === 'not_executed'
    ? { ...evidence, evidence: redactText(evidence.evidence).slice(0, 500) }
    : { ...evidence, reason: redactText(evidence.reason).slice(0, 500) };
}
