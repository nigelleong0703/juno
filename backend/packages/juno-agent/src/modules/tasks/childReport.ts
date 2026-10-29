import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { invalidArguments } from '../tools/toolArguments.js';
import { sessionKey, type Store, type Tool, type ToolContext, type ToolResult, type WakeEvent } from '../../contracts/index.js';
import type { ChildRun } from './childRead.js';

const REPORT_MAX_CHARS = 2_000;

const reportSchema = z.object({ text: z.string().min(1).max(REPORT_MAX_CHARS) });

function textResult(text: string, isError = false, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}), ...(details === undefined ? {} : { details }) };
}

/**
 * The session a child reports to: the background reporting target when it has one, else the parent
 * run's own chat. Never a user, peer or room channel (the child boundary still holds).
 */
async function parentSession(store: Store, child: ChildRun): Promise<{ agentId: string; conversationId: string } | undefined> {
  if (child.notifyParent !== undefined) return { agentId: child.notifyParent.agentId, conversationId: child.notifyParent.conversationId };
  if (child.parentRunId === undefined) return undefined;
  const parent = await store.get('runs', child.parentRunId);
  if (parent === null || parent.conversationId === undefined) return undefined;
  return { agentId: parent.agentId, conversationId: parent.conversationId };
}

/**
 * report_to_parent: a child task sends its parent a short progress update or question mid-run. The
 * parent is woken with a hand_back (system-origin, untrusted: a report, never an instruction). The
 * child's own per-run budget bounds how many it can send; the step id keeps the wake id stable, so a
 * replay is deduped by the parent's Session.
 */
export function createReportToParentTool(): Tool {
  return {
    name: 'report_to_parent',
    description:
      'Child tasks only: send your parent agent a short progress update or a question while you keep working. ' +
      'Your final result still reaches the parent automatically when you finish. You cannot reach the user or other agents this way.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = reportSchema.safeParse(args);
      if (!parsed.success) return invalidArguments('child_report', args, parsed.error);
      const child: ChildRun | null = await ctx.store.get('runs', ctx.runId);
      if (child === null || child.parentRunId === undefined) return textResult('report_to_parent is only available inside a child task', true);
      const target = await parentSession(ctx.store, child);
      if (target === undefined) return textResult('the parent of this child task is not available', true);
      const reportId = ctx.stepId ?? (await ctx.step('report-id', async () => randomUUID()));
      const wake: WakeEvent = {
        id: ctx.runId + ':report:' + reportId,
        ownerId: ctx.ownerId,
        agentId: target.agentId,
        sessionKey: sessionKey(target.agentId, target.conversationId),
        conversationId: target.conversationId,
        kind: 'hand_back',
        // System origin: the parent is usually the same agent, and an agent-origin self wake is refused.
        origin: { type: 'system', id: ctx.runId, label: 'child task report' },
        trusted: false,
        priority: 'background',
        payload: { text: parsed.data.text, taskId: ctx.runId, originRunId: child.parentRunId },
        ...(ctx.wake.hop === undefined ? {} : { hop: ctx.wake.hop }),
        at: new Date().toISOString(),
        status: 'accepted',
      };
      const admitted = await ctx.enqueuer.enqueue(wake);
      if (!admitted.accepted) return textResult('the report could not be delivered to the parent; continue and include it in your final result', true);
      return textResult('Reported to the parent.', false, { child: true });
    },
  };
}
