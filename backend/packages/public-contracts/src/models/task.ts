import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';
import { runOriginSchema } from './run-origin.js';
import { runUsageSchema } from './run.js';

/**
 * One observable projection of work (BACKEND 6.5): the agent's declared tasks, delegated child runs, routine
 * runs and background jobs all read as the same `AgentTask`. Execution, retries, cancellation and storage stay
 * with each mechanism; this is only how they are shown.
 *
 * `task`: work the agent declared itself with `task_update`. `subagent`: a delegated child run. `routine`: a run
 * a routine's schedule or monitor started. `command`: a background shell process. `connector`: a background MCP
 * call. `wait`: a `wait_for` wait.
 */
export const workKindSchema = z.enum(['task', 'subagent', 'routine', 'command', 'connector', 'wait']);
export type WorkKind = z.infer<typeof workKindSchema>;

/** Where it is now. `waiting` says what for in `waitingFor`. `ended` has an `outcome`. */
export const workStatusSchema = z.enum(['queued', 'running', 'waiting', 'ended']);
export type WorkStatus = z.infer<typeof workStatusSchema>;

/** What a task waits for, while `status` is `waiting`. */
export const waitingForSchema = z.enum(['owner_input', 'approval', 'event', 'effect_review']);
export type WaitingFor = z.infer<typeof waitingForSchema>;

/** How it ended. `unknown_effect`: an outside action may have happened and nothing trustworthy says whether (wins over the rest). */
export const workOutcomeSchema = z.enum(['done', 'failed', 'cancelled', 'needs_input', 'unknown_effect']);
export type WorkOutcome = z.infer<typeof workOutcomeSchema>;

/** The specific reason behind an outcome, when there is one. */
export const outcomeDetailSchema = z.enum([
  'timed_out',
  'step_limit',
  'no_progress',
  'verification_failed',
  'dispatch_failed',
  'state_unreadable',
  'stopped_by_owner',
  'stopped_by_agent',
  'stopped_by_system',
  'stop_unconfirmed',
  'effect_review',
]);
export type OutcomeDetail = z.infer<typeof outcomeDetailSchema>;

/** Who gets the result. */
export const replyTargetSchema = z.discriminatedUnion('type', [
  /** A delegated child: its parent run collects it. */
  z.object({ type: z.literal('parent_run'), runId: idSchema }),
  /** A background job that wakes the agent's session when it ends. */
  z.object({ type: z.literal('session'), agentId: idSchema, conversationId: idSchema }),
  /** A routine's delivery: a chat, Slack or email. */
  z.object({ type: z.literal('delivery'), channel: z.enum(['chat', 'slack', 'email']), target: z.string().optional() }),
  /** Nobody is waiting for it. */
  z.object({ type: z.literal('none') }),
]);
export type ReplyTarget = z.infer<typeof replyTargetSchema>;

/** `awaited`: a parent run waits for it. `background`: it reports back by itself. `scheduled`: a routine started it. */
export const workModeSchema = z.enum(['awaited', 'background', 'scheduled']);
export type WorkMode = z.infer<typeof workModeSchema>;

/**
 * One entry of the task list (`GET /v1/tasks`, `GET /v1/agents/:id/tasks`, the tree) and the payload of the live
 * `task.updated`. Every text is agent-written or derived from its work, so render it as untrusted plain text.
 */
export const agentTaskSchema = z.object({
  id: idSchema,
  kind: workKindSchema,
  agentId: idSchema,
  conversationId: idSchema.optional(),
  /** The task or run this one hangs under: a child's parent run, the run that started a background job. Absent at the top of a tree. */
  parentId: idSchema.optional(),
  /** The run at the top of the tree this task belongs to (a plain chat run, or the routine run). */
  rootRunId: idSchema,
  /** 0 at the top of a tree, +1 per level. */
  depth: z.number().int().min(0),
  /** What started the whole tree. Written once at the root and copied down, so it is the same for every task in the tree. */
  origin: runOriginSchema,
  mode: workModeSchema,
  replyTo: replyTargetSchema,
  status: workStatusSchema,
  waitingFor: waitingForSchema.optional(),
  /** Only when `status` is `ended`. */
  outcome: workOutcomeSchema.optional(),
  outcomeDetail: outcomeDetailSchema.optional(),
  /** Short imperative phrase, e.g. "Find rain jacket options". */
  title: z.string().min(1).max(200),
  /** While live: one line of what it is doing now (a subagent's latest step, the awaited event). */
  progress: z.string().max(300).optional(),
  /** When ended: one line of the result, e.g. "Listed 16 Sept and Oct school dates" or "Exited with code 1". */
  resultLine: z.string().max(300).optional(),
  /** The run that started it (declared task, background job) or is it (subagent, routine). */
  runId: idSchema.optional(),
  /** For a subagent: the child run doing the work (its steps are under `GET /v1/runs/:id`). */
  childRunId: idSchema.optional(),
  routineId: idSchema.optional(),
  /** What this task itself spent, for a task that is a run. Limits and what is left of a budget are never public. */
  usage: runUsageSchema.optional(),
  startedAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.optional(),
});
export type AgentTask = z.infer<typeof agentTaskSchema>;

/** `GET /v1/tasks`: live tasks whole, ended ones a page at a time (`nextCursor`). */
export const taskListSchema = z.object({ items: z.array(agentTaskSchema), nextCursor: z.string().nullable() });
export type TaskList = z.infer<typeof taskListSchema>;

/** `GET /v1/tasks/:id/tree`: every task under one root run, parents before children. */
export const taskTreeSchema = z.object({
  rootRunId: idSchema,
  origin: runOriginSchema,
  items: z.array(agentTaskSchema),
  /** What the whole tree spent, root run included. */
  subtreeUsage: runUsageSchema,
});
export type TaskTree = z.infer<typeof taskTreeSchema>;
