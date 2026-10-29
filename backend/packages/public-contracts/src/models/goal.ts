import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

/** "tracking" is a concrete watch (a date, a price); "goal" is a longer aim worked on in steps. */
export const goalKindSchema = z.enum(['tracking', 'goal']);
export type GoalKind = z.infer<typeof goalKindSchema>;

export const goalStatusSchema = z.enum(['active', 'paused', 'done']);
export type GoalStatus = z.infer<typeof goalStatusSchema>;

/** The life area a goal belongs to (stored in the doc, not an indexed column). */
export const goalCategorySchema = z.enum(['health', 'relationships', 'finance', 'career', 'interests', 'productivity', 'other']);
export type GoalCategory = z.infer<typeof goalCategorySchema>;

export const goalStepSchema = z.object({ text: z.string().min(1), done: z.boolean() });
export type GoalStep = z.infer<typeof goalStepSchema>;

/** One entry of a goal's timeline. Newest first; the server keeps the latest GOAL_ACTIVITY_LIMIT. */
export const goalActivitySchema = z.object({
  at: isoDateTimeSchema,
  actor: z.enum(['user', 'agent']),
  /** `quote` is the user's own words kept as material (the text is the quote itself; `milestoneId` says which milestone it belongs to). */
  kind: z.enum(['created', 'updated', 'status', 'note', 'quote']),
  /** One short line: the new title, the new summary, or `status: done`. */
  text: z.string(),
  /** The agent run that made the change, when there was one (the only link to runs). */
  runId: idSchema.optional(),
  /** The milestone a `quote` belongs to; absent when it matched none. */
  milestoneId: idSchema.optional(),
});
export type GoalActivity = z.infer<typeof goalActivitySchema>;

/** One step of the action plan the goal's agent writes when the goal is created (3 to 7), worked through by check-ins. */
export const goalMilestoneStatusSchema = z.enum(['todo', 'doing', 'done', 'blocked']);
export type GoalMilestoneStatus = z.infer<typeof goalMilestoneStatusSchema>;

export const goalMilestoneSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  status: goalMilestoneStatusSchema,
  due: isoDateTimeSchema.optional(),
  /** When the 24-hour deadline reminder was sent (set by the server so it is sent once). */
  remindedAt: isoDateTimeSchema.optional(),
});
export type GoalMilestone = z.infer<typeof goalMilestoneSchema>;

export const goalSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  kind: goalKindSchema,
  title: z.string().min(1),
  /** One line on where it stands. */
  summary: z.string(),
  status: goalStatusSchema,
  category: goalCategorySchema.optional(),
  /** Optional checklist; the page computes progress from it. */
  steps: z.array(goalStepSchema).optional(),
  /** The agent's action plan; absent until the plan run has written it. */
  milestones: z.array(goalMilestoneSchema).optional(),
  /** When the agent checks in on this goal next (active goals only; the agent sets it, 1 hour to 7 days ahead). */
  nextCheckAt: isoDateTimeSchema.optional(),
  /** When the last check-in ran. */
  lastCheckedAt: isoDateTimeSchema.optional(),
  /** Timeline, newest first. Omitted from list responses; always present on GET /v1/goals/:id. */
  activity: z.array(goalActivitySchema).optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Goal = z.infer<typeof goalSchema>;

/** What the user can edit from the page. */
export const updateGoalInputSchema = goalSchema.pick({ title: true, summary: true, steps: true, status: true, category: true }).partial();
export type UpdateGoalInput = z.infer<typeof updateGoalInputSchema>;

/** The user creates a goal for one of their agents (`POST /v1/goals`). */
export const createGoalInputSchema = z.object({
  agentId: idSchema,
  kind: goalKindSchema,
  title: z.string().trim().min(1),
  summary: z.string().trim().optional(),
  category: goalCategorySchema.optional(),
});
export type CreateGoalInput = z.infer<typeof createGoalInputSchema>;

/** Timeline entries kept per goal; older ones fall off the end. */
export const GOAL_ACTIVITY_LIMIT = 50;

/** The goal's timeline with `entry` prepended (newest first), capped. Every goal write goes through this. */
export function appendGoalActivity(previous: GoalActivity[] | undefined, entry: GoalActivity): GoalActivity[] {
  return [entry, ...(previous ?? [])].slice(0, GOAL_ACTIVITY_LIMIT);
}
