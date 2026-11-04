/**
 * subagent_start / subagent_message — visible scoped child tasks (the model-facing name is "subagent"; the code keeps "child").
 *
 * A child is a real run in the parent's own conversation, dispatched to the EXACT reserved run id by
 * the core's adapter. Nothing here opens a hidden conversation or a peer chat. The parent never waits: it is
 * woken with a task_done carrying the result when the child ends (BACKEND §3.3c).
 */
import { z } from 'zod';
import type { Store, Tool, ToolContext, ToolResult } from '../../contracts/index.js';
import { cancelSubagentTasks, SUBAGENT_PROMPT_MAX_CHARS, isTerminal, readSubagentTask, startSubagent, type SubagentDispatchAdapter, type SubagentRefusalReason, type SubagentStatus } from './subagent.js';
import { shouldAddFeedCard } from '../feed/feedCard.js';
import { authorizeOwnSubagent, subagentCancelRefusalText } from './subagentControl.js';
import { depthOf } from './subagentRead.js';
import { nextBackgroundGeneration, type BackgroundSpawn } from './subagent-background.js';
import type { WakeEvent } from '../../contracts/index.js';
import { nameRunByAgent } from '../../execution/harness/services/run-aux.js';
import type { MemoryPort } from '../memory/port.js';
import { handoffMemory, MAX_MEMORY_REFS, memoryNote, receiverRun, withHandoffMemory } from '../memory/handoff.js';
import { harnessText } from '../harness/loader.js';

const spawnSchema = z.object({ prompt: z.string().min(1).max(4_000), title: z.string().trim().min(1).max(120).optional(), targetAgentId: z.string().min(1).optional(), retryRunId: z.string().min(1).optional(), mission: z.enum(['research', 'page_builder']).optional(), tools: z.array(z.string().min(1)).max(200).optional(), fast: z.boolean().optional(), deep: z.boolean().optional(), memoryRefs: z.array(z.string().min(1).max(64)).max(MAX_MEMORY_REFS).optional() });
/** The mission text (harness unit subagent.research or subagent.page_builder, ending at "Task:") comes before the parent's prompt, on its own line. */
const missionText = (name: 'research' | 'page_builder'): string => harnessText(name === 'research' ? 'subagent.research' : 'subagent.page_builder') + '\n';
const messageSchema = z.object({ runId: z.string().min(1), text: z.string().min(1).max(SUBAGENT_PROMPT_MAX_CHARS), retryRunId: z.string().min(1).optional() });

const REFUSALS: Record<SubagentRefusalReason, string> = {
  parent_not_found: 'the parent run is not known in this scope',
  owner_mismatch: 'this run does not belong to the calling owner and agent',
  target_not_authorized: 'the target agent is not available in this owner scope',
  depth_exceeded: 'subagent depth limit reached: a subagent cannot start another this deep',
  concurrency_exceeded: 'too many subagents are already active for this run',
  budget_exhausted: 'the run budget is exhausted, so no subagent can be started',
  invalid_prompt: 'the subagent prompt must be 1..4000 characters',
  dispatch_unavailable: 'subagents are unavailable: this deployment has no qualified dispatcher',
  parent_conversation_mismatch: 'the parent run belongs to a different conversation',
  dispatch_failed: 'the subagent could not be started',
  parent_terminal: 'the parent run (or the reserved subagent) already ended, so it cannot be retried',
  background_limit: 'background task limit reached: this chain already went too many background generations deep or started too many background tasks; finish without starting another',
  run_stopped: 'the run was stopped before the subagent could start',
};

function refusal(reason: SubagentRefusalReason, runId?: string, tool: 'subagent_start' | 'subagent_message' = 'subagent_start'): ToolResult {
  if (reason === 'dispatch_failed' && runId !== undefined) {
    // A failed continuation is retried through subagent_message, a failed start through subagent_start; both name the reserved run.
    const retry = tool === 'subagent_message' ? 'call subagent_message again with the same runId and text, plus retryRunId ' + runId : 'retry the same subagent_start with retryRunId ' + runId;
    return { content: [{ type: 'text', text: REFUSALS[reason] + '; the reserved subagent is ' + runId + ', so ' + retry + ' (no new subagent is reserved).' }], isError: true, details: { child: true, refused: reason, runId, retryRunId: runId } };
  }
  return { content: [{ type: 'text', text: REFUSALS[reason] }], isError: true, details: { child: true, refused: reason } };
}

function summary(child: SubagentStatus): Record<string, unknown> {
  return { runId: child.runId, parentRunId: child.parentRunId, status: child.status, title: child.title, depth: child.depth, result: child.result, resultRef: child.resultRef };
}

export function createSubagentSpawnTool(opts: { store: Store; adapter?: SubagentDispatchAdapter; memory?: MemoryPort }): Tool {
  return {
    name: 'subagent_start',
    description: '',
    parameters: { type: 'object', properties: { prompt: { type: 'string', maxLength: 4_000, description: '' }, title: { type: 'string', maxLength: 120, description: '' }, targetAgentId: { type: 'string', description: '' }, retryRunId: { type: 'string', description: '' }, mission: { type: 'string', enum: ['research', 'page_builder'], description: '' }, tools: { type: 'array', items: { type: 'string' }, maxItems: 200, description: '' }, fast: { type: 'boolean', description: '' }, deep: { type: 'boolean', description: '' }, memoryRefs: { type: 'array', items: { type: 'string' }, maxItems: MAX_MEMORY_REFS, description: '' } }, required: ['prompt'], additionalProperties: false },
    // Spawning commits a durable child run; never replay it after a crash.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = spawnSchema.parse(args);
      const targetAgentId = parsed.targetAgentId ?? ctx.agentId;
      // The memory the child may use rides in its task text: only items both this run and the child may read (BACKEND 6.1b).
      const memory = await handoffMemory(opts.store, opts.memory, {
        ownerId: ctx.ownerId,
        sender: { ownerId: ctx.ownerId, agentId: ctx.agentId, conversationId: ctx.conversationId, wake: [ctx.wake] },
        receiver: receiverRun({ ownerId: ctx.ownerId, agentId: targetAgentId, conversationId: ctx.conversationId, kind: 'subagent_task', senderAgentId: ctx.agentId, payload: {} }),
        refs: parsed.memoryRefs ?? [],
      });
      const task = withHandoffMemory(parsed.mission === undefined ? parsed.prompt : missionText(parsed.mission) + parsed.prompt, memory.lines);
      if (task.trim().length > SUBAGENT_PROMPT_MAX_CHARS) {
        return { content: [{ type: 'text', text: 'The task with its memory items is over ' + String(SUBAGENT_PROMPT_MAX_CHARS) + ' characters; shorten the task or pass fewer memoryRefs. No subagent was started.' }], isError: true };
      }
      const spawned = await startSubagent(
        ctx.store,
        {
          ownerId: ctx.ownerId,
          agentId: ctx.agentId,
          parentRunId: ctx.runId,
          conversationId: ctx.conversationId,
          // The durable step (or the run) makes the child id deterministic, so a replay resolves the same run.
          callId: ctx.stepId ?? ctx.runId,
          prompt: task,
          title: parsed.title ?? parsed.prompt.slice(0, 80),
          targetAgentId,
          ...(parsed.retryRunId === undefined ? {} : { retryRunId: parsed.retryRunId }),
          // A subagent always wakes its parent when it ends (task_done carries the result).
          notify: backgroundSpawnFor(ctx),
          ...((await shouldAddFeedCard(ctx.store, ctx)) ? { feedCardUserOrigin: true as const } : {}),
          ...(parsed.tools === undefined ? {} : { tools: parsed.tools }),
          ...(parsed.fast === true ? { fast: true } : {}),
          ...(parsed.deep === true ? { deep: true } : {}),
        },
        opts.adapter,
        ctx.signal,
      );
      if (!spawned.ok) return refusal(spawned.reason, spawned.runId);
      if (parsed.title !== undefined) await nameRunByAgent(ctx.store, ctx.runId, parsed.title);
      return {
        content: [{ type: 'text', text: 'Started subagent ' + spawned.child.runId + ' (status ' + spawned.child.status + '). You are woken with its result when it ends; do not wait for it' + memoryNote(memory) }],
        details: { child: true, spawned: summary(spawned.child) },
      };
    },
  };
}

/**
 * subagent_message — a follow-up to one of this run's own subagents. A running one reads it as a steer at its
 * next step. A finished one is continued: a new run on a copy of its transcript, with the message as its prompt.
 */
export function createSubagentMessageTool(opts: { store: Store; adapter?: SubagentDispatchAdapter }): Tool {
  return {
    name: 'subagent_message',
    description: '',
    parameters: { type: 'object', properties: { runId: { type: 'string' }, text: { type: 'string' }, retryRunId: { type: 'string' } }, required: ['runId', 'text'], additionalProperties: false },
    // Like subagent_start, a continuation commits a durable run: never replay it after a crash.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = messageSchema.parse(args);
      const access = await authorizeOwnSubagent(ctx.store, { ownerId: ctx.ownerId, agentId: ctx.agentId, parentRunId: ctx.runId, subagentRunId: parsed.runId, conversationId: ctx.conversationId });
      if (!access.ok) return { content: [{ type: 'text', text: subagentCancelRefusalText(access.reason, parsed.runId) }], isError: true, details: { child: true, refused: access.reason } };
      const child = access.child;
      if (child.dispatch !== 'accepted') {
        return { content: [{ type: 'text', text: 'Subagent ' + parsed.runId + ' has not started yet; its subagent_start must be retried before it can be messaged.' }], isError: true, details: { child: true, refused: 'not_started' } };
      }
      if (!isTerminal(child.status)) {
        // A running child drains its own inbox at its steer points, so a queued message is read at the next one.
        const depth = await depthOf(ctx.store, child.id);
        const wake: WakeEvent = {
          id: ctx.runId + ':msg:' + (ctx.stepId ?? ctx.runId),
          ownerId: ctx.ownerId,
          agentId: child.agentId,
          sessionKey: child.childSessionKey ?? '',
          conversationId: child.conversationId ?? ctx.conversationId,
          kind: 'subagent_task',
          // System origin: parent and child are often the same agent, and an agent-origin self wake is refused.
          origin: { type: 'system', id: ctx.runId, label: 'parent task message' },
          trusted: false,
          priority: 'background',
          mode: 'steer',
          payload: { prompt: parsed.text, parentRunId: ctx.runId, childRunId: child.id, planId: child.planId, depth },
          hop: { chainId: ctx.runId, depth },
          at: new Date().toISOString(),
          status: 'accepted',
        };
        const admitted = await ctx.enqueuer.enqueue(wake, { awaitDecision: true });
        if (!admitted.accepted) {
          return { content: [{ type: 'text', text: 'The message to subagent ' + parsed.runId + ' was refused: ' + (admitted.reason ?? 'unknown reason') }], isError: true, details: { child: true, refused: 'message_refused' } };
        }
        // The child may have ended while the message was queued. Its run never read that message, so say so.
        const after = await readSubagentTask(ctx.store, child.id);
        if (after !== null && isTerminal(after.status)) {
          return { content: [{ type: 'text', text: 'Subagent ' + parsed.runId + ' ended before it read the message (status ' + after.status + '); send subagent_message again to continue it.' }], isError: true, details: { child: true, refused: 'child_ended' } };
        }
        return { content: [{ type: 'text', text: 'Message queued for running subagent ' + parsed.runId + '; it reads it at its next step. You are woken with its result when it ends.' }], details: { child: true, messaged: parsed.runId, mode: 'steer' } };
      }
      // Like a stopped subagent in Claude Code, a child this run or the user stopped does not resume.
      if (child.status === 'stopped') {
        return { content: [{ type: 'text', text: 'Subagent ' + parsed.runId + ' was stopped, so it does not resume; start a new subagent instead.' }], isError: true, details: { child: true, refused: 'child_stopped' } };
      }
      const spawned = await startSubagent(
        ctx.store,
        {
          ownerId: ctx.ownerId,
          agentId: ctx.agentId,
          parentRunId: ctx.runId,
          conversationId: ctx.conversationId,
          // Namespaced by the child it continues, so the continuation id never collides with a spawn's.
          callId: 'continue:' + child.id + ':' + (ctx.stepId ?? ctx.runId),
          prompt: parsed.text,
          targetAgentId: child.agentId,
          continuesRunId: child.id,
          ...(child.allowedTools === undefined ? {} : { tools: child.allowedTools }),
          ...(child.fastModel === true ? { fast: true } : {}),
          ...(child.deepEffort === true ? { deep: true } : {}),
          ...(parsed.retryRunId === undefined ? {} : { retryRunId: parsed.retryRunId }),
          notify: backgroundSpawnFor(ctx),
          ...((await shouldAddFeedCard(ctx.store, ctx)) ? { feedCardUserOrigin: true as const } : {}),
        },
        opts.adapter,
        ctx.signal,
      );
      if (!spawned.ok) return refusal(spawned.reason, spawned.runId, 'subagent_message');
      return {
        content: [{ type: 'text', text: 'Continued subagent ' + parsed.runId + ' as run ' + spawned.child.runId + ' (status ' + spawned.child.status + '). You are woken with its result when it ends.' }],
        details: { child: true, continued: parsed.runId, spawned: summary(spawned.child) },
      };
    },
  };
}

/** Cancel every active child of this run by stopping its REAL run (no fabricated status). */
export async function cancelSubagentsOfRun(store: Store, stop: (runId: string) => Promise<void>, parentRunId: string): Promise<{ cancelled: number }> {
  return cancelSubagentTasks(store, stop, parentRunId);
}

/**
 * Chain position of a background spawn: a run woken by a task_done continues that chain one generation
 * deeper; any other run starts a new chain at generation 1 (H-75 caps generations per chain).
 */
function backgroundSpawnFor(ctx: ToolContext): BackgroundSpawn {
  return { chainId: ctx.wake.hop?.chainId ?? ctx.runId, generation: nextBackgroundGeneration(ctx.wake) };
}
