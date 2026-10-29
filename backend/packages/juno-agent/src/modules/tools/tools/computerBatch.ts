import type { Tool, ToolContext, ToolOrchestrationOutcome, ToolResult } from '../../../contracts/index.js';
import type { ComputerClientProvider } from '../computer/client.js';
import { BATCH_ACTION_TOOLS, BATCH_MAX_STEPS, COMPUTER_BATCH_TOOL, batchArgsSchema, batchStepRefusal, runBatch } from '../computer/batch.js';
import { observePage } from './computerBrowserActions.js';

function failClosed(message: string, code: string): ToolResult {
  return { content: [{ type: 'text', text: message }], details: { code, actionCount: 0 }, isError: true };
}

/**
 * Several predicted browser or screen actions in one call. Like browser.advance, the harness owns the dispatch: each step runs
 * as its own canonical tool call (policy, approval, journal and fence), so a restart resumes mid-batch exactly as it would after
 * single calls, and nothing is approved inside a batch: a step that would ask the user stops the batch before it.
 */
export function createComputerBatchTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: COMPUTER_BATCH_TOOL,
    description: '',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: BATCH_MAX_STEPS,
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', enum: [...BATCH_ACTION_TOOLS] },
              args: { type: 'object', description: '', additionalProperties: true },
            },
            required: ['tool'],
            additionalProperties: false,
          },
        },
        observe: { type: 'string', enum: ['changes', 'none'], description: '' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    // The steps move the page through never-replayed calls. The batch itself is not an effect: the harness runs it outside a fence
    // and each step owns its own fence, so a restart resumes at the first step that had not finished.
    replay: 'never',
    sideEffect: true,
    async execute(): Promise<ToolResult> {
      return failClosed('computer.batch requires the canonical harness orchestrator. No action was performed.', 'orchestration_required');
    },
    async orchestrate(args: unknown, ctx: ToolContext, runtime): Promise<ToolOrchestrationOutcome> {
      const parsed = batchArgsSchema.safeParse(args);
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
        return { kind: 'completed', result: failClosed(`computer.batch arguments are invalid (${issues}). Give steps as 1 to ${String(BATCH_MAX_STEPS)} items of {tool, args}. Nothing was run.`, 'invalid_arguments') };
      }
      const refusal = batchStepRefusal(parsed.data.steps);
      if (refusal !== null) return { kind: 'completed', result: failClosed(refusal, 'step_not_allowed') };
      const runTool = runtime.runTool;
      if (runTool === undefined) return { kind: 'completed', result: failClosed('computer.batch is unavailable here. Nothing was run.', 'unavailable') };
      const result = await runBatch({
        args: parsed.data,
        runTool: (name, stepArgs) => runTool(name, stepArgs),
        observe: (tab, on) => runtime.journal('observe', () => observePage(opts.computer, ctx, tab, on)),
      });
      return result === null ? { kind: 'cancelled' } : { kind: 'completed', result };
    },
  };
}
