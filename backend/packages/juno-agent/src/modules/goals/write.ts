/**
 * The one way a goal row is written by an agent side (BACKEND §5.10): the `goal_update` tool and the background recorder both call
 * `writeGoal`, so same-title merging, milestone ids, the timeline and the `goal.updated` event behave the same for both.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Goal, GoalActivity, GoalMilestone } from '@agent-desktop/public-contracts';
import { appendGoalActivity, goalKindSchema, goalMilestoneStatusSchema, goalStatusSchema, goalStepSchema } from '@agent-desktop/public-contracts';
import type { Enqueuer, Store } from '../../contracts/index.js';
import { queueGoalWake } from './checkin.js';
import { agentGoals } from './index.js';
import { clampNextCheck } from './schedule.js';

export const goalWriteSchema = z.object({
  id: z.string().min(1).optional(),
  kind: goalKindSchema.optional(),
  title: z.string().trim().min(1),
  summary: z.string().trim(),
  steps: z.array(goalStepSchema).optional(),
  status: goalStatusSchema.optional(),
  milestones: z.array(z.object({ id: z.string().min(1).optional(), title: z.string().trim().min(1), status: goalMilestoneStatusSchema.default('todo'), due: z.string().optional() })).optional(),
  nextCheckAt: z.string().optional(),
  note: z.string().trim().min(1).optional(),
});
export type GoalWriteInput = z.infer<typeof goalWriteSchema>;

export interface GoalWriter {
  ownerId: string;
  agentId: string;
  /** The run that writes, when there is one; goes on the timeline entry. */
  runId?: string;
}

/** An extra timeline entry; `milestoneTitle` is resolved to the milestone's id after the plan is merged. */
export type GoalExtraActivity = Pick<GoalActivity, 'kind' | 'text'> & { actor?: GoalActivity['actor']; milestoneTitle?: string };

export type GoalWriteResult = { ok: true; goal: Goal; created: boolean } | { ok: false; error: string };

/** The plan sent, keeping the id (and reminder mark) of a milestone already there when the title or id matches. */
function mergeMilestones(sent: NonNullable<GoalWriteInput['milestones']>, previous: readonly GoalMilestone[] | undefined): GoalMilestone[] {
  return sent.map((milestone) => {
    const old = (previous ?? []).find((candidate) => (milestone.id !== undefined ? candidate.id === milestone.id : candidate.title.toLowerCase() === milestone.title.toLowerCase()));
    const sent = milestone.due === undefined || Number.isNaN(Date.parse(milestone.due)) ? undefined : new Date(milestone.due).toISOString();
    const due = sent ?? old?.due;
    return {
      id: old?.id ?? milestone.id ?? 'ms-' + randomUUID().slice(0, 8),
      title: milestone.title,
      status: milestone.status,
      ...(due === undefined ? {} : { due }),
      ...(old?.remindedAt === undefined || old.due !== due ? {} : { remindedAt: old.remindedAt }),
    };
  });
}

/**
 * Creates the agent's goal or updates the one it already has (by `id`, else the same title that is not done). `extraActivity` entries
 * (the recorder's quoted answers, which may name a milestone by title) go on the timeline after the write's own entry. A new goal without milestones gets its one plan wake
 * when an enqueuer is given.
 */
export async function writeGoal(deps: { store: Store; enqueuer?: Enqueuer }, who: GoalWriter, input: GoalWriteInput, extraActivity: readonly GoalExtraActivity[] = []): Promise<GoalWriteResult> {
  const { store } = deps;
  const own = await agentGoals(store, who.ownerId, who.agentId);
  const existing = input.id === undefined
    ? own.find((goal) => goal.status !== 'done' && goal.title.toLowerCase() === input.title.toLowerCase())
    : own.find((goal) => goal.id === input.id);
  if (input.id !== undefined && existing === undefined) return { ok: false, error: 'no goal of yours with id ' + JSON.stringify(input.id) + '.' };
  const now = new Date().toISOString();
  const entry = (kind: GoalActivity['kind'], text: string): GoalActivity => ({ at: now, actor: 'agent', kind, text, ...(who.runId === undefined ? {} : { runId: who.runId }) });
  const withExtras = (activity: GoalActivity[], milestones: readonly GoalMilestone[] | undefined): GoalActivity[] => extraActivity.reduce((all, extra) => {
    const key = extra.milestoneTitle?.replace(/\s+/g, ' ').trim().toLowerCase();
    const milestoneId = key === undefined ? undefined : (milestones ?? []).find((m) => m.title.replace(/\s+/g, ' ').trim().toLowerCase() === key)?.id;
    return appendGoalActivity(all, { ...entry(extra.kind, extra.text), ...(extra.actor === undefined ? {} : { actor: extra.actor }), ...(milestoneId === undefined ? {} : { milestoneId }) });
  }, activity);
  if (existing !== undefined) {
    const milestones = input.milestones === undefined ? existing.milestones : mergeMilestones(input.milestones, existing.milestones);
    const statusChanged = input.status !== undefined && input.status !== existing.status;
    const updated = await store.patch('goals', existing.id, {
      title: input.title,
      summary: input.summary,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.steps === undefined ? {} : { steps: input.steps }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.milestones === undefined ? {} : { milestones }),
      ...(input.nextCheckAt === undefined && !(input.status === 'active' && existing.status !== 'active') ? {} : { nextCheckAt: clampNextCheck(input.nextCheckAt, new Date(now)) }),
      activity: withExtras(appendGoalActivity(existing.activity, entry(statusChanged ? 'status' : input.note === undefined ? 'updated' : 'note', statusChanged ? 'status: ' + String(input.status) : (input.note ?? (input.summary.length > 0 ? input.summary : input.title)))), milestones),
      updatedAt: now,
    });
    await store.emit({ type: 'goal.updated', goal: updated });
    return { ok: true, goal: updated, created: false };
  }
  const milestones = input.milestones === undefined ? undefined : mergeMilestones(input.milestones, undefined);
  const goal: Goal & { ownerId: string } = {
    id: 'goal-' + String(Date.now()) + '-' + randomUUID().slice(0, 8),
    ownerId: who.ownerId,
    agentId: who.agentId,
    kind: input.kind ?? 'goal',
    title: input.title,
    summary: input.summary,
    status: input.status ?? 'active',
    ...(input.steps === undefined ? {} : { steps: input.steps }),
    ...(milestones === undefined ? {} : { milestones }),
    nextCheckAt: clampNextCheck(input.nextCheckAt, new Date(now)),
    activity: withExtras(appendGoalActivity(undefined, entry('created', input.title)), milestones),
    createdAt: now,
    updatedAt: now,
  };
  const created = await store.put('goals', goal);
  await store.emit({ type: 'goal.updated', goal: created });
  // A new goal without a plan gets its one planning run (the wake id is per goal, so a replay queues nothing twice).
  if (deps.enqueuer !== undefined && created.milestones === undefined && created.status === 'active') await queueGoalWake({ store, enqueuer: deps.enqueuer }, created, 'plan');
  return { ok: true, goal: created, created: true };
}
