import type { Tool, ToolContext, ToolOrchestrationOutcome, ToolResult } from '../../../contracts/index.js';
import type { ComputerClientProvider } from '../computer/client.js';
import {
  ADVANCE_DECISION_TIMEOUT_MS,
  BROWSER_ADVANCE_TOOL,
  browserAdvanceArgsSchema,
  runBrowserAdvance,
} from '../computer/browser-advance.js';
import { readAdvanceHistory } from '../computer/browser-advance-history.js';
import type { AdvanceExecution } from '../computer/browser-advance-types.js';

function failClosed(message: string, code: string): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    details: { code, native: false, actionCount: 0 },
    isError: true,
  };
}

/**
 * One main-model call that may advance the browser through several observed actions. The harness
 * owns nested dispatch: this tool never executes a browser action directly, which keeps nested
 * policy, approval, journal/fence, cancellation and audit on the canonical path.
 */
export function createComputerBrowserAdvanceTool(opts: {
  computer?: ComputerClientProvider;
  /** Internal test seam; production uses the tight fixed deadline. */
  decisionTimeoutMs?: number;
}): Tool {
  return {
    name: BROWSER_ADVANCE_TOOL,
    description: '',
    parameters: {
      type: 'object',
      properties: {
        stage: { type: 'string', enum: ['form', 'interact'], description: '' },
        goal: { type: 'string', minLength: 1, maxLength: 2_000, description: '' },
        values: {
          type: 'object',
          description: '',
          additionalProperties: { type: 'string', maxLength: 2_000 },
          maxProperties: 24,
        },
        tab: { type: 'string', minLength: 1, maxLength: 16, description: '' },
        on: { type: 'string', enum: ['sandbox', 'mac'], description: '' },
        maxActions: { type: 'integer', minimum: 1, maximum: 6, default: 4, description: '' },
      },
      required: ['goal', 'stage'],
      additionalProperties: false,
    },
    // The outer action can move the page through nested never-replayed calls. It is not itself an
    // effect: the harness runs the orchestration outside a fence and each child owns its own fence.
    replay: 'never',
    sideEffect: true,
    async execute(): Promise<ToolResult> {
      return failClosed(
        'browser.advance requires the canonical harness orchestrator. No browser action or model call was performed.',
        'orchestration_required',
      );
    },
    async orchestrate(args: unknown, ctx: ToolContext, runtime): Promise<ToolOrchestrationOutcome> {
      let parsed;
      try {
        parsed = browserAdvanceArgsSchema.parse(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { kind: 'completed', result: failClosed('browser.advance arguments are invalid: ' + message, 'invalid_arguments') };
      }
      if (parsed.stage === undefined) {
        return { kind: 'completed', result: failClosed('Choose one small stage first: stage="form" with exact values for observed fields, or stage="interact" for choosing/opening controls. Do not delegate an entire search or comparison workflow. No browser or native call was made.', 'missing_stage') };
      }
      if (parsed.stage === 'form' && Object.keys(parsed.values ?? {}).length === 0) {
        return { kind: 'completed', result: failClosed('A form stage needs nonempty values keyed by the observed field labels. Values written only in goal do not create input actions. Observe the fields and supply their exact known values; use stage="interact" to operate noneditable controls. No browser or native call was made.', 'missing_values') };
      }
      if (parsed.stage === 'interact' && Object.keys(parsed.values ?? {}).length > 0) {
        return { kind: 'completed', result: failClosed('Use stage="form" when supplying values for typing. Keep opening/choosing controls as a separate stage="interact" goal. No browser or native call was made.', 'stage_value_mismatch') };
      }
      const result = await runBrowserAdvance({
        args: parsed,
        ownerId: ctx.ownerId,
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        ...(ctx.stepId === undefined ? {} : { stepId: ctx.stepId }),
        signal: runtime.signal,
        ...(ctx.systemOne === undefined ? {} : { systemOne: ctx.systemOne }),
        decisionTimeoutMs: opts.decisionTimeoutMs ?? ADVANCE_DECISION_TIMEOUT_MS,
        journal: (key, action) => runtime.journal(key, action),
        loadHistory: page => runtime.journal('progress-history', () => readAdvanceHistory(ctx, parsed.on ?? 'sandbox', page)),
        execute: (action, actionArgs): Promise<AdvanceExecution> => runtime.run(action, actionArgs),
      });
      return result.kind === 'cancelled' ? { kind: 'cancelled' } : { kind: 'completed', result: result.result };
    },
  };
}
