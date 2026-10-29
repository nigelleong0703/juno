/**
 * child_spawn / child_wait / child_results — visible scoped child tasks.
 *
 * A child is a real run in the parent's own conversation, dispatched to the EXACT reserved run id by
 * the core's adapter. Nothing here opens a hidden conversation or a peer chat, and waiting suspends on
 * the child completion event (never a fake user request).
 */
import { z } from 'zod';
import type { Store, Tool, ToolContext, ToolResult } from '../../contracts/index.js';
import { cancelChildTasks, CHILD_PROMPT_MAX_CHARS, isTerminal, listChildTasks, readChildTask, spawnChildTask, type ChildDispatchAdapter, type ChildRefusalReason, type ChildStatus } from './child.js';
import { shouldAddFeedCard } from '../feed/feedCard.js';
import { CHILD_WAIT_TIMEOUT_MS } from './childWait.js';
import { authorizeOwnChild, childCancelRefusalText } from './childControl.js';
import { depthOf, toStatus } from './childRead.js';
import { nextBackgroundGeneration, type BackgroundSpawn } from './child-background.js';
import type { WakeEvent } from '../../contracts/index.js';
import { nameRunByAgent } from '../../execution/harness/services/run-aux.js';
import type { MemoryPort } from '../memory/port.js';
import { handoffMemory, MAX_MEMORY_REFS, memoryNote, receiverRun, withHandoffMemory } from '../memory/handoff.js';
import { harnessText } from '../harness/loader.js';

const spawnSchema = z.object({ prompt: z.string().min(1).max(4_000), title: z.string().trim().min(1).max(120).optional(), targetAgentId: z.string().min(1).optional(), retryRunId: z.string().min(1).optional(), notify: z.boolean().optional(), mission: z.enum(['research', 'page_builder']).optional(), tools: z.array(z.string().min(1)).max(200).optional(), fast: z.boolean().optional(), deep: z.boolean().optional(), memoryRefs: z.array(z.string().min(1).max(64)).max(MAX_MEMORY_REFS).optional() });
/** The mission text (harness unit child.research or child.page_builder, ending at "Task:") comes before the parent's prompt, on its own line. */
const missionText = (name: 'research' | 'page_builder'): string => harnessText(name === 'research' ? 'child.research' : 'child.page_builder') + '\n';
const messageSchema = z.object({ runId: z.string().min(1), text: z.string().min(1).max(CHILD_PROMPT_MAX_CHARS), retryRunId: z.string().min(1).optional() });
const waitSchema = z.object({ runIds: z.array(z.string().min(1)).max(50).optional(), timeoutMs: z.number().int().positive().optional() });
const resultsSchema = z.object({ runId: z.string().min(1).optional() });

const REFUSALS: Record<ChildRefusalReason, string> = {
  parent_not_found: 'the parent run is not known in this scope',
  owner_mismatch: 'this run does not belong to the calling owner and agent',
  target_not_authorized: 'the target agent is not available in this owner scope',
  depth_exceeded: 'child-task depth limit reached: a child cannot spawn another child this deep',
  concurrency_exceeded: 'too many child tasks are already active for this run',
  budget_exhausted: 'the run budget is exhausted, so no child task can be spawned',
  invalid_prompt: 'the child prompt must be 1..4000 characters',
  dispatch_unavailable: 'child tasks are unavailable: this deployment has no qualified child-run dispatcher',
  parent_conversation_mismatch: 'the parent run belongs to a different conversation',
  dispatch_failed: 'the child run could not be started',
  parent_terminal: 'the parent run (or the reserved child) already ended, so it cannot be retried',
  background_limit: 'background task limit reached: this chain already went too many background generations deep or started too many background tasks; finish without starting another',
  run_stopped: 'the run was stopped before the child task could start',
};

function refusal(reason: ChildRefusalReason, runId?: string, tool: 'child_spawn' | 'child_message' = 'child_spawn'): ToolResult {
  if (reason === 'dispatch_failed' && runId !== undefined) {
    // A failed continuation is retried through child_message, a failed spawn through child_spawn; both name the reserved run.
    const retry = tool === 'child_message' ? 'call child_message again with the same runId and text, plus retryRunId ' + runId : 'retry the same spawn with retryRunId ' + runId;
    return { content: [{ type: 'text', text: REFUSALS[reason] + '; the reserved child is ' + runId + ', so ' + retry + ' (no new child is reserved).' }], isError: true, details: { child: true, refused: reason, runId, retryRunId: runId } };
  }
  return { content: [{ type: 'text', text: REFUSALS[reason] }], isError: true, details: { child: true, refused: reason } };
}

function summary(child: ChildStatus): Record<string, unknown> {
  return { runId: child.runId, parentRunId: child.parentRunId, status: child.status, title: child.title, depth: child.depth, result: child.result, resultRef: child.resultRef };
}

export function createChildSpawnTool(opts: { store: Store; adapter?: ChildDispatchAdapter; memory?: MemoryPort }): Tool {
  return {
    name: 'child_spawn',
    description: '',
    parameters: { type: 'object', properties: { prompt: { type: 'string', maxLength: 4_000, description: '' }, title: { type: 'string', maxLength: 120, description: '' }, targetAgentId: { type: 'string', description: '' }, retryRunId: { type: 'string', description: '' }, notify: { type: 'boolean', description: '' }, mission: { type: 'string', enum: ['research', 'page_builder'], description: '' }, tools: { type: 'array', items: { type: 'string' }, maxItems: 200, description: '' }, fast: { type: 'boolean', description: '' }, deep: { type: 'boolean', description: '' }, memoryRefs: { type: 'array', items: { type: 'string' }, maxItems: MAX_MEMORY_REFS, description: '' } }, required: ['prompt'], additionalProperties: false },
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
        receiver: receiverRun({ ownerId: ctx.ownerId, agentId: targetAgentId, conversationId: ctx.conversationId, kind: 'child_task', senderAgentId: ctx.agentId, payload: {} }),
        refs: parsed.memoryRefs ?? [],
      });
      const task = withHandoffMemory(parsed.mission === undefined ? parsed.prompt : missionText(parsed.mission) + parsed.prompt, memory.lines);
      if (task.trim().length > CHILD_PROMPT_MAX_CHARS) {
        return { content: [{ type: 'text', text: 'The task with its memory items is over ' + String(CHILD_PROMPT_MAX_CHARS) + ' characters; shorten the task or pass fewer memoryRefs. Nothing was spawned.' }], isError: true };
      }
      const spawned = await spawnChildTask(
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
          ...(parsed.notify !== false ? { notify: backgroundSpawnFor(ctx) } : {}),
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
        content: [{ type: 'text', text: 'Spawned child task ' + spawned.child.runId + ' (status ' + spawned.child.status + ')' + memoryNote(memory) }],
        details: { child: true, spawned: summary(spawned.child) },
      };
    },
  };
}

/**
 * The child's status when the calling run may act on it under authorizeOwnChild (the rule child_message,
 * child_cancel and task_stop share), else null. Read-only: the same refusal for a missing or foreign id.
 */
async function ownChildStatus(ctx: ToolContext, childRunId: string): Promise<ChildStatus | null> {
  const access = await authorizeOwnChild(ctx.store, { ownerId: ctx.ownerId, agentId: ctx.agentId, parentRunId: ctx.runId, childRunId, conversationId: ctx.conversationId });
  return access.ok ? toStatus(ctx.store, access.child) : null;
}

export function createChildResultsTool(): Tool {
  return {
    name: 'child_results',
    description: '',
    parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: [], additionalProperties: false },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = resultsSchema.parse(args);
      // A named run must pass the same ownership rule as child_message (own child, or one an earlier run of this agent spawned).
      const named = parsed.runId === undefined ? null : await ownChildStatus(ctx, parsed.runId);
      if (parsed.runId !== undefined && named === null) {
        return { content: [{ type: 'text', text: 'child ' + parsed.runId + ' is not a child of this run' }], isError: true, details: { child: true, refused: 'not_own_child' } };
      }
      const children = named === null ? await listChildTasks(ctx.store, ctx.runId) : [named];
      const active = children.filter((child) => !isTerminal(child.status)).length;
      return {
        content: [{ type: 'text', text: children.length === 0 ? 'No child tasks for this run.' : JSON.stringify(children.map(summary)) }],
        details: { child: true, children: children.map(summary), active },
      };
    },
  };
}

export function createChildWaitTool(): Tool {
  return {
    name: 'child_wait',
    description: '',
    parameters: { type: 'object', properties: { runIds: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'number' } }, required: [], additionalProperties: false },
    // Waiting is a durable suspension, safe to redo.
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = waitSchema.parse(args);
      const all = await listChildTasks(ctx.store, ctx.runId);
      let wanted = all;
      if (parsed.runIds !== undefined) {
        const picked: ChildStatus[] = [];
        const foreign: string[] = [];
        for (const runId of parsed.runIds) {
          const child = await ownChildStatus(ctx, runId);
          if (child === null) foreign.push(runId);
          else picked.push(child);
        }
        if (foreign.length > 0) {
          return { content: [{ type: 'text', text: 'child ' + String(foreign[0]) + ' is not a child of this run' }], isError: true, details: { child: true, refused: 'not_own_child', missing: foreign } };
        }
        wanted = picked;
      }
      const pending = wanted.filter((child) => !isTerminal(child.status));
      if (pending.length > 0) {
        const timeoutMs = Math.min(parsed.timeoutMs ?? CHILD_WAIT_TIMEOUT_MS, CHILD_WAIT_TIMEOUT_MS);
        const until = new Date(Date.now() + timeoutMs).toISOString();
        const runIds = wanted.map((child) => child.runId);
        // A durable event wait on the children — never the user-approval path. The validated run ids
        // and deadline ride in private details for the core integrator (runIds + until), never a
        // model-controlled binding: foreign ids are refused above, never collapsed to an empty wait.
        return {
          content: [{ type: 'text', text: 'Waiting for ' + String(pending.length) + ' child task(s) to finish.' }],
          details: { child: true, waiting: pending.map((child) => child.runId), parentRunId: ctx.runId, runIds, timeoutMs, until, childWait: { parentRunId: ctx.runId, runIds, timeoutMs, until } },
          // An EXPLICIT child-wait branch: the core polls durably (awaitChildTasks) and never asks the
          // user, unlike reason 'user' which would create a request and await a human.
          suspend: { reason: 'child', until },
        };
      }
      return {
        content: [{ type: 'text', text: wanted.length === 0 ? 'No child tasks to wait for.' : JSON.stringify(wanted.map(summary)) }],
        details: { child: true, children: wanted.map(summary), active: 0 },
      };
    },
  };
}

/**
 * child_message — a follow-up to one of this run's own children. A running child reads it as a steer at its
 * next step. A finished child is continued: a new run on a copy of its transcript, with the message as its prompt.
 */
export function createChildMessageTool(opts: { store: Store; adapter?: ChildDispatchAdapter }): Tool {
  return {
    name: 'child_message',
    description: '',
    parameters: { type: 'object', properties: { runId: { type: 'string' }, text: { type: 'string' }, retryRunId: { type: 'string' } }, required: ['runId', 'text'], additionalProperties: false },
    // Like child_spawn, a continuation commits a durable run: never replay it after a crash.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = messageSchema.parse(args);
      const access = await authorizeOwnChild(ctx.store, { ownerId: ctx.ownerId, agentId: ctx.agentId, parentRunId: ctx.runId, childRunId: parsed.runId, conversationId: ctx.conversationId });
      if (!access.ok) return { content: [{ type: 'text', text: childCancelRefusalText(access.reason, parsed.runId) }], isError: true, details: { child: true, refused: access.reason } };
      const child = access.child;
      if (child.dispatch !== 'accepted') {
        return { content: [{ type: 'text', text: 'Child ' + parsed.runId + ' has not started yet; its spawn must be retried before it can be messaged.' }], isError: true, details: { child: true, refused: 'not_started' } };
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
          kind: 'child_task',
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
          return { content: [{ type: 'text', text: 'The message to child ' + parsed.runId + ' was refused: ' + (admitted.reason ?? 'unknown reason') }], isError: true, details: { child: true, refused: 'message_refused' } };
        }
        // The child may have ended while the message was queued. Its run never read that message, so say so.
        const after = await readChildTask(ctx.store, child.id);
        if (after !== null && isTerminal(after.status)) {
          return { content: [{ type: 'text', text: 'Child ' + parsed.runId + ' ended before it read the message (status ' + after.status + '); send child_message again to continue it.' }], isError: true, details: { child: true, refused: 'child_ended' } };
        }
        return { content: [{ type: 'text', text: 'Message queued for running child ' + parsed.runId + '; it reads it at its next step. Collect its result with child_wait.' }], details: { child: true, messaged: parsed.runId, mode: 'steer' } };
      }
      // Like a stopped subagent in Claude Code, a child this run or the user stopped does not resume.
      if (child.status === 'stopped') {
        return { content: [{ type: 'text', text: 'Child ' + parsed.runId + ' was stopped, so it does not resume; spawn a new child task instead.' }], isError: true, details: { child: true, refused: 'child_stopped' } };
      }
      const spawned = await spawnChildTask(
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
          ...(child.notifyParent === undefined ? {} : { notify: backgroundSpawnFor(ctx) }),
          ...((await shouldAddFeedCard(ctx.store, ctx)) ? { feedCardUserOrigin: true as const } : {}),
        },
        opts.adapter,
        ctx.signal,
      );
      if (!spawned.ok) return refusal(spawned.reason, spawned.runId, 'child_message');
      return {
        content: [{ type: 'text', text: 'Continued child ' + parsed.runId + ' as run ' + spawned.child.runId + ' (status ' + spawned.child.status + '); wait for it with child_wait.' }],
        details: { child: true, continued: parsed.runId, spawned: summary(spawned.child) },
      };
    },
  };
}

/** Cancel every active child of this run by stopping its REAL run (no fabricated status). */
export async function cancelChildrenOfRun(store: Store, stop: (runId: string) => Promise<void>, parentRunId: string): Promise<{ cancelled: number }> {
  return cancelChildTasks(store, stop, parentRunId);
}

/**
 * Chain position of a background spawn: a run woken by a task_done continues that chain one generation
 * deeper; any other run starts a new chain at generation 1 (H-75 caps generations per chain).
 */
function backgroundSpawnFor(ctx: ToolContext): BackgroundSpawn {
  return { chainId: ctx.wake.hop?.chainId ?? ctx.runId, generation: nextBackgroundGeneration(ctx.wake) };
}
