/**
 * An outside action whose outcome nobody can tell (BACKEND §3.3d.5). Checking it is the agent's job, not the person's:
 *  1. the tool's own `reconcile` hook runs first (runFencedTool, unchanged);
 *  2. still unknown: the AGENT is told, as the tool result, that the action may or may not have happened and to check with a read tool before
 *     doing it again. The run goes on. An identical call stays held back until the agent has made a read call after the notice (or the person
 *     said to do it again);
 *  3. only if the agent itself cannot tell and a repeat would matter does the person get one plain question (`ask_about_uncertain_action`).
 * The technical evidence stays on the step record (`StepExecution.reconciliation`, the step's output) and in the audit, never in a card.
 */
import type { Doc, Tool, ToolReconciliation, ToolResult } from '../../../contracts/index.js';
import { words } from '../../../modules/mcp/tool-access.js';
import { isPlumbingTool } from '../../../modules/tools/plumbing.js';
import { markNoticed, readExecution, releaseFence, type ToolRunContext } from './replay.js';
import { redactText } from './redaction.js';
import type { RunInput, RunServices } from './run-types.js';

export const ASK_ABOUT_UNCERTAIN_ACTION = 'ask_about_uncertain_action';

/** `The action "send message" in Gmail`: the action in plain words, for the agent's notice. `label` is the step's own wording (a connected app's step reads "App · Action"). */
export function actionPhrase(tool: Pick<Tool, 'name' | 'origin' | 'mcp'>, label: string): string {
  if (tool.origin === undefined) return 'The action "' + (tool.mcp === true ? label : words(tool.name).join(' ') || tool.name) + '"';
  const action = words(tool.origin.toolName).join(' ') || tool.origin.toolName;
  return 'The action "' + action + '" in ' + tool.origin.connectionName;
}

/** Why it is uncertain, in one line: what the check said, or that the run was cut off. */
export function reasonLine(evidence: ToolReconciliation | undefined): string {
  if (evidence === undefined || evidence.status === 'succeeded' || evidence.status === 'not_executed') return 'the run was interrupted before the result was saved';
  if (/no read-only result check/i.test(evidence.reason)) return 'nothing could confirm it afterwards';
  if (/abort|time[ds]? ?out|econn|socket|connection (?:reset|closed)/i.test(evidence.reason)) return 'the request was sent but no answer came back';
  const line = redactText(evidence.reason.replace(/\s+/g, ' ').trim()).slice(0, 160);
  return line === '' ? 'no result came back' : line;
}

/** What the agent reads. */
export function noticeText(phrase: string, reason: string): string {
  return `${phrase} may or may not have happened (${reason}). Check with a read tool before doing it again (for example look in sent mail / the calendar / the page); if it already happened, don't repeat it. If you cannot tell and doing it twice would matter, ask the person with ${ASK_ABOUT_UNCERTAIN_ACTION} (find it with tool_search).`;
}

export function noticeResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true, details: { errorKind: 'harness', uncertainOutcome: true } };
}

/** Remember on the run which fenced steps the agent was told about (the question tool finds the latest one). Called inside a journaled step. */
async function rememberOnRun(services: Pick<RunServices, 'store'>, runId: string, sourceStepId: string): Promise<void> {
  const run = await services.store.get('runs', runId);
  if (run === null || run.uncertainSteps?.at(-1) === sourceStepId) return;
  await services.store.patch('runs', runId, { uncertainSteps: [...(run.uncertainSteps ?? []).filter((id) => id !== sourceStepId), sourceStepId] });
}

/** The notice for an action that has just run with an unknown outcome: recorded on its step and on the run, journaled. */
export async function giveNotice(ctx: ToolRunContext, services: Pick<RunServices, 'store'>, runId: string, step: Doc<'steps'>, source: Doc<'steps'>): Promise<void> {
  await ctx.run(`recovery:${step.id}:notice`, async () => {
    await markNoticed(services.store, source, runId);
    await rememberOnRun(services, runId, source.id);
    return true;
  });
}

/** Whether a tool only reads: its own mark, or the connected app's classification. A bookkeeping tool does not count. */
function readsOnly(tool: Tool): boolean {
  if (isPlumbingTool(tool.name)) return false;
  return tool.origin !== undefined ? tool.origin.access === 'read' : tool.sideEffect === false;
}

/**
 * An identical call arrives while an earlier one is still uncertain: let it through once the agent has made a read call after the notice
 * (releasing the earlier one), otherwise hold it back with the notice. The first sight of an unnoticed uncertain action counts as the notice.
 * Journaled as one step, so a replay decides the same way.
 */
export async function repeatGate(ctx: ToolRunContext, services: RunServices, input: RunInput, runId: string, step: Doc<'steps'>, prior: Doc<'steps'>): Promise<'proceed' | 'hold'> {
  return ctx.run(`recovery:${step.id}:gate`, async () => {
    const notice = readExecution(await services.store.get('steps', prior.id))?.notice;
    if (notice === undefined) {
      await markNoticed(services.store, prior, runId);
      await rememberOnRun(services, runId, prior.id);
      return 'hold' as const;
    }
    const tools = await services.toolRegistry.forAgent(input.agentId);
    const readers = new Set(tools.filter(readsOnly).map((tool) => tool.name));
    const run = await services.store.get('runs', runId);
    const readSince = (run?.steps ?? []).some((other) => other.tool !== undefined && readers.has(other.tool) && other.status !== 'running' && other.internal !== true && other.startedAt > notice.at);
    if (!readSince) {
      await rememberOnRun(services, runId, prior.id);
      return 'hold' as const;
    }
    await releaseFence(services.store, prior);
    return 'proceed' as const;
  });
}
