/**
 * computer.batch (M-BATCH-TOOLS): a run of predicted browser and screen actions in one model call, one observation at
 * the end. The harness runs every step as its own canonical call (run-tools.ts executeBatchChild: the same preparation,
 * policy, fence and journal as a single call); this module owns what a batch may contain and how its result reads.
 */
import { z } from 'zod';
import type { ToolBatchStepOutcome, ToolResult } from '../../../contracts/index.js';
import type { ComputerTarget } from './contract.js';

export const COMPUTER_BATCH_TOOL = 'computer.batch';
export const BATCH_MAX_STEPS = 12;

/**
 * The only tools a batch may run: this agent's own browser and screen actions. Never a read (the batch observes itself),
 * a shell, files, a message, a connector, a payment tool, a secure-input request, computer.act (already a batch of its own)
 * or another batch.
 */
export const BATCH_ACTION_TOOLS: readonly string[] = [
  'browser.navigate', 'browser.new_tab', 'browser.click', 'browser.type', 'browser.fill', 'browser.scroll',
  'computer.click', 'computer.double_click', 'computer.right_click', 'computer.move', 'computer.type', 'computer.key', 'computer.scroll',
];

export const batchArgsSchema = z.object({
  steps: z.array(z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).optional() }).strict()).min(1).max(BATCH_MAX_STEPS),
  observe: z.enum(['changes', 'none']).optional(),
}).strict();
export type BatchArgs = z.infer<typeof batchArgsSchema>;

type StepStatus = 'done' | 'failed' | 'needs_approval' | 'blocked' | 'cancelled';
interface StepRecord { n: number; tool: string; status: StepStatus; line: string; stepId?: string }

const textOf = (result: ToolResult): string => result.content.map((part) => (part.type === 'text' ? part.text : '')).join(' ').replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max - 1) + '…' : text);

/** What a step said, on one line (a step runs without its own snapshot, so this is the action, its notices and any restart note): the page comes once at the end. */
function lineOf(result: ToolResult): string {
  return clip(textOf(result), 400);
}

/** The refusal or error a failed step gave, longer than a success line so the model can act on it. */
function reasonOf(result: ToolResult): string {
  return clip(textOf(result), 700);
}

const asOn = (value: unknown): ComputerTarget | undefined => (value === 'sandbox' || value === 'mac' ? value : undefined);

/** Why a batch cannot start: a step names a tool a batch may not run. Nothing has run when this is returned. */
export function batchStepRefusal(steps: BatchArgs['steps']): string | null {
  for (const [index, step] of steps.entries()) {
    if (!BATCH_ACTION_TOOLS.includes(step.tool)) {
      return `Step ${index + 1}: ${step.tool} cannot run inside computer.batch. A batch holds only these actions: ${BATCH_ACTION_TOOLS.join(', ')}. Nothing was run; call ${step.tool} on its own and keep the rest in the batch.`;
    }
  }
  return null;
}

export interface BatchRunOptions {
  args: BatchArgs;
  /** Runs one step as its own canonical call (the harness). */
  runTool(name: string, args: Record<string, unknown>): Promise<ToolBatchStepOutcome>;
  /** The page after the batch (journaled by the caller); `tab` is the tab the last browser step acted on. */
  observe(tab: string | undefined, on: ComputerTarget | undefined): Promise<string>;
}

/** Run the steps in order, stop at the first that fails or would need approval, and report. `null`: the run was stopped. */
export async function runBatch(opts: BatchRunOptions): Promise<ToolResult | null> {
  const steps = opts.args.steps;
  const records: StepRecord[] = [];
  let lastBrowser: { tab?: string; on?: ComputerTarget } | undefined;
  let stop: string | undefined;
  for (const [index, step] of steps.entries()) {
    const n = index + 1;
    const stepArgs = step.args ?? {};
    const outcome = await opts.runTool(step.tool, stepArgs);
    if (outcome.kind === 'cancelled') return null;
    if (outcome.kind === 'needs_approval') {
      records.push({ n, tool: step.tool, status: 'needs_approval', line: outcome.reason });
      stop = `Step ${n} (${step.tool}) needs the user's approval, so the batch stopped before it and that step did not run. Call ${step.tool} directly now, outside computer.batch, with the same arguments: the user is asked there. Do not look for another way to do the same thing. Then carry on from step ${n + 1}.`;
      break;
    }
    const { result, stepId } = outcome;
    if (result.isError === true || result.suspend !== undefined) {
      // A commit gate says to call again with confirm; that call is made directly, never inside a batch (which would only stop before it).
      const alone = result.details?.['code'] === 'purchase_needs_confirm' ? ` Make that call directly with confirm, not inside computer.batch: the user is asked there, and a batch never asks.` : '';
      records.push({ n, tool: step.tool, status: 'failed', line: reasonOf(result), stepId });
      stop = `Step ${n} (${step.tool}) failed: ${reasonOf(result)}${alone}`;
      break;
    }
    if (step.tool.startsWith('browser.')) {
      const tab = result.details?.['tab'];
      const on = asOn(stepArgs['on']);
      lastBrowser = { ...(typeof tab === 'string' ? { tab } : {}), ...(on === undefined ? {} : { on }) };
    }
    if (result.details?.['dialog'] !== undefined) {
      records.push({ n, tool: step.tool, status: 'blocked', line: lineOf(result), stepId });
      stop = `Step ${n} (${step.tool}) opened a dialog that blocks the page, so the batch stopped. Answer it with browser.dialog, then carry on from step ${n + 1}.`;
      break;
    }
    records.push({ n, tool: step.tool, status: 'done', line: lineOf(result), stepId });
  }
  const done = records.filter((record) => record.status === 'done').length;
  const failed = records.some((record) => record.status === 'failed');
  const head = stop === undefined ? `Batch done: all ${done} steps ran.` : `Batch stopped after ${done} of ${steps.length} steps. ${stop}`;
  const list = records.map((record) => `${record.n}. ${record.tool}${record.status === 'done' ? '' : ` [${record.status.replace('_', ' ')}]`}: ${record.line}`);
  const skipped = steps.length - records.length;
  const rest = skipped > 0 ? `Not run: steps ${records.length + 1}-${steps.length}.` : '';
  let observation = '';
  if (opts.args.observe !== 'none' && done > 0) {
    observation = lastBrowser === undefined
      ? 'Nothing to read for screen actions: take computer.screenshot to check the result.'
      : `Page after the batch:\n${await opts.observe(lastBrowser.tab, lastBrowser.on)}`;
  }
  const text = [head, ...list, rest, observation].filter((part) => part !== '').join('\n');
  return {
    content: [{ type: 'text', text }],
    ...(failed ? { isError: true } : {}),
    details: {
      steps: records.map((record) => ({ n: record.n, tool: record.tool, status: record.status, ...(record.stepId === undefined ? {} : { stepId: record.stepId }) })),
      done,
      total: steps.length,
      ...(lastBrowser?.tab === undefined ? {} : { tab: lastBrowser.tab }),
    },
  };
}
