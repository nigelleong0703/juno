import { z } from 'zod';
import {
  idSchema,
  isoDateTimeSchema,
  runStatusSchema,
  stepErrorKindSchema,
  stepKindSchema,
  stepStatusSchema,
} from './common.js';
import { todoSchema } from './conversation.js';
import { runEngineSnapshotSchema } from './engine.js';
import { runOriginSchema } from './run-origin.js';

/** Structured tool input/output attached to one step (StepDetail in §5.3). */
export const stepIOSchema = z.object({
  summary: z.string().optional(),
  command: z.string().optional(),
  url: z.string().optional(),
  text: z.string().optional(),
  /** Arbitrary structured payload (JSON-ish) rendered as a code block. */
  data: z.unknown().optional(),
});
export type StepIO = z.infer<typeof stepIOSchema>;

export const stepSchema = z.object({
  id: idSchema,
  runId: idSchema,
  /** Position in the run; 0-based. */
  index: z.number().int().min(0),
  kind: stepKindSchema,
  /** Action verb, e.g. "Opened", "Clicked", "Ran". */
  verb: z.string().min(1),
  /** Object of the verb, e.g. "chromium → linear.app". */
  target: z.string().min(1),
  /** Plain-language one-line title written by the model after the run finished; absent = show verb + target. */
  title: z.string().max(80).optional(),
  /** One result line under `title` (what came back), written with it. */
  detail: z.string().max(200).optional(),
  /** Reference to a captured screenshot (resolved by the screen store). */
  screenshotRef: z.string().optional(),
  input: stepIOSchema.optional(),
  output: stepIOSchema.optional(),
  status: stepStatusSchema,
  startedAt: isoDateTimeSchema,
  durationMs: z.number().int().min(0),
  /** The tool this step ran, by its real name (`kind` is only a coarse family). Absent on a step written before 0.54. */
  tool: z.string().optional(),
  /**
   * True for plumbing: the step looks up a tool or skill, keeps the agent's own bookkeeping (plans, tasks, profile), reads back an
   * observation, or repeats what the person already sees as a message. Clients leave it out of the activity list (and may show it
   * under "details"); they keep no list of tool names. Absent = a step the person should see.
   */
  internal: z.boolean().optional(),
  /** Why a failed or skipped step went wrong. */
  errorKind: stepErrorKindSchema.optional(),
  /** The id of the previous failed step of the same tool in this run, when this step is a retry of it. */
  retryOf: idSchema.optional(),
  /** `tool_search` / `tool_load` steps: the query (or the names) asked for. */
  searchQuery: z.string().optional(),
  /** `tool_search` / `tool_load` steps: the first tool the run called afterwards. */
  calledTool: z.string().optional(),
});
export type Step = z.infer<typeof stepSchema>;

export const runUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** PH11: measured cache tokens, when the provider reports them. */
  cacheReadTokens: z.number().int().min(0).optional(),
  cacheWriteTokens: z.number().int().min(0).optional(),
  computeSeconds: z.number().min(0),
  costUsd: z.number().min(0),
  /** PH11: false when no real price was reported, so costUsd 0 means unknown, not free. */
  costKnown: z.boolean().optional(),
  /** PH11: false when the provider reported no usage at all, so the counters are not measured. */
  measured: z.boolean().optional(),
  steps: z.number().int().min(0),
});
export type RunUsage = z.infer<typeof runUsageSchema>;

/** A skill version a run read (`skill_read`): the exposure the nightly outcome labels are credited or blamed on. */
export const runSkillSchema = z.object({
  /** An owner skill's id, or a platform skill's id (its directory name, e.g. `pdf`). */
  skillId: idSchema,
  versionId: idSchema,
  /** True for a platform skill. Absent for an owner skill. */
  platform: z.boolean().optional(),
});
export type RunSkill = z.infer<typeof runSkillSchema>;

/** The nightly deterministic label of a finished run (BACKEND §5.15). The model never grades itself. */
export const runOutcomeSchema = z.enum(['ok', 'corrected', 'failed_method', 'failed_other', 'abandoned', 'unknown']);
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

export const runKindSchema = z.enum(['chat', 'routine', 'scheduled', 'manual', 'background']);
export type RunKind = z.infer<typeof runKindSchema>;

/** A Run is a Task (ARCHITECTURE §2 "Task 就是 Run"). */
export const runSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  conversationId: idSchema.optional(),
  /** 0.68.0: the routine that started this run; set for a run a routine's schedule or monitor started. */
  routineId: idSchema.optional(),
  /** 0.68.0: what started this run, written at creation. Every run has one (a migration backfilled the older ones). */
  origin: runOriginSchema.optional(),
  /** 0.68.0: for a child run (`origin.type === 'parent_run'`), the origin of the run at the top of its chain. Absent otherwise. */
  rootOrigin: runOriginSchema.optional(),
  /**
   * PH12 child-task link: the run that spawned this one. Absent for a top-level run, so this is
   * purely additive and a legacy run stays valid.
   */
  parentRunId: idSchema.optional(),
  /** PH12 child-task metadata: the runs this one spawned. Absent or empty when it spawned none. */
  childRunIds: z.array(idSchema).optional(),
  /**
   * CT: a child-task final result stored on the run itself. Absent for a top-level run or a
   * child that has not finished writing its result, so this is purely additive.
   */
  childResult: z.string().optional(),
  title: z.string().min(1),
  /** True once the short model-written title replaced the raw wake text (BACKEND §10.11). */
  titleGenerated: z.boolean().optional(),
  status: runStatusSchema,
  kind: runKindSchema,
  /** Human label for how it started, e.g. "Daily inbox triage". */
  triggerLabel: z.string().optional(),
  steps: z.array(stepSchema),
  /** 1-2 sentence model-written summary, set after the run reached a terminal status; absent when none was written. */
  summary: z.string().max(300).optional(),
  usage: runUsageSchema,
  /** The model this run was frozen on, recorded with its first charged model step. */
  model: z.string().min(1).optional(),
  engine: runEngineSnapshotSchema.optional(),
  /** 0.64.0: the skill versions this run read, in first-read order. Absent when it read none. */
  skills: z.array(runSkillSchema).optional(),
  /** 0.64.0: set once by the nightly labeling job, after the run settled. Absent until then. */
  outcome: runOutcomeSchema.optional(),
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.optional(),
  durationMs: z.number().int().min(0).optional(),
  lastActivityAt: isoDateTimeSchema,
  /** Set by `POST /v1/runs/:id/seen`: the owner has seen the result, so Today stops listing it as completed. */
  seenAt: isoDateTimeSchema.optional(),
  error: z.string().optional(),
});
export type Run = z.infer<typeof runSchema>;

/** Plan / todo card (ARCHITECTURE §5.3 PlanCard). */
export const planSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  runId: idSchema.optional(),
  title: z.string().min(1),
  todos: z.array(todoSchema),
  updatedAt: isoDateTimeSchema,
});
export type Plan = z.infer<typeof planSchema>;
