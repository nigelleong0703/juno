import { type Context, type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Goal, GoalActivity } from '@agent-desktop/public-contracts';
import { appendGoalActivity, createGoalInputSchema, goalStatusSchema, updateGoalInputSchema } from '@agent-desktop/public-contracts';
import { queueGoalWake } from 'juno-agent/modules/goals/checkin';
import { clampNextCheck } from 'juno-agent/modules/goals/schedule';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { canMutateAgent, docOwnerId, listAll, paginateFiltered } from './relationships.js';

/** The caller's own row, or undefined: another owner's row answers exactly like a missing one. */
async function ownRow(deps: AgentdDeps, c: Context): Promise<Goal | undefined> {
  const row = await deps.store.get('goals', c.req.param('id') ?? '');
  return row !== null && docOwnerId(row) === getOwnerId(c) ? row : undefined;
}

const notFound = (c: Context) => c.json({ error: { code: 'GOAL_NOT_FOUND', message: 'Goal not found' } }, 404);

/** Goals the agents keep for the user; the page lists, creates, edits and deletes them. Every route stays inside the caller's rows. */
export function registerGoals(app: Hono, deps: AgentdDeps) {
  app.get('/v1/goals', async (c) => {
    const ownerId = getOwnerId(c);
    const query = c.req.query();
    const status = query['status'] === undefined ? undefined : goalStatusSchema.safeParse(query['status']);
    if (status !== undefined && !status.success) {
      return c.json({ error: { code: 'INVALID_STATUS', message: 'status must be active, paused or done' } }, 400);
    }
    const loaded = await listAll(deps.store, 'goals');
    if (loaded.truncated) {
      return c.json({ error: { code: 'LIST_TRUNCATED', message: 'Goal list truncated; retry later' } }, 500);
    }
    const own = loaded.items
      .filter((row) => docOwnerId(row) === ownerId)
      .filter((row) => query['agentId'] === undefined || row.agentId === query['agentId'])
      .filter((row) => status === undefined || row.status === status.data)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      // The timeline is only served by GET /v1/goals/:id.
      .map(({ activity: _activity, ...row }) => row);
    const page = paginateFiltered(own, query['limit'], query['cursor']);
    return c.json({ items: page.items, nextCursor: page.nextCursor ?? null });
  });

  app.post('/v1/goals', zValidator('json', createGoalInputSchema), async (c) => {
    const ownerId = getOwnerId(c);
    const input = c.req.valid('json');
    // The agent must be the caller's own; anything else answers like a missing agent.
    const agent = await deps.store.get('agents', input.agentId);
    if (agent === null || !canMutateAgent(agent, ownerId)) {
      return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }, 404);
    }
    const now = new Date().toISOString();
    const goal: Goal & { ownerId: string } = {
      id: 'goal-' + String(Date.now()) + '-' + crypto.randomUUID().slice(0, 8),
      ownerId,
      agentId: input.agentId,
      kind: input.kind,
      title: input.title,
      summary: input.summary ?? '',
      status: 'active',
      ...(input.category === undefined ? {} : { category: input.category }),
      nextCheckAt: clampNextCheck(undefined, new Date(now)),
      activity: appendGoalActivity(undefined, { at: now, actor: 'user', kind: 'created', text: input.title }),
      createdAt: now,
      updatedAt: now,
    };
    const created = await deps.store.put('goals', goal);
    await deps.store.emit({ type: 'goal.updated', goal: created });
    // The goal's agent gets one run to write its action plan; a failed hand-off only means the first scheduled check-in plans it.
    await queueGoalWake(deps, created, 'plan');
    return c.json(created, 201);
  });

  app.get('/v1/goals/:id', async (c) => {
    const row = await ownRow(deps, c);
    if (row === undefined) return notFound(c);
    return c.json({ ...row, activity: row.activity ?? [] });
  });

  app.patch('/v1/goals/:id', zValidator('json', updateGoalInputSchema), async (c) => {
    const row = await ownRow(deps, c);
    if (row === undefined) return notFound(c);
    const patch = c.req.valid('json');
    const now = new Date().toISOString();
    const entry: GoalActivity = patch.status !== undefined && patch.status !== row.status
      ? { at: now, actor: 'user', kind: 'status', text: 'status: ' + patch.status }
      : { at: now, actor: 'user', kind: 'updated', text: Object.keys(patch).join(', ') || 'updated' };
    // Resuming a goal schedules its next check-in an hour out; pausing keeps the plan but nothing is checked.
    const resumed = patch.status === 'active' && row.status !== 'active';
    const updated = await deps.store.patch('goals', row.id, {
      ...patch,
      ...(resumed ? { nextCheckAt: clampNextCheck(now, new Date(now)) } : {}),
      activity: appendGoalActivity(row.activity, entry),
      updatedAt: now,
    });
    await deps.store.emit({ type: 'goal.updated', goal: updated });
    return c.json(updated);
  });

  // "Check now": a check-in outside the schedule. Only an active goal can be checked.
  app.post('/v1/goals/:id/check', async (c) => {
    const row = await ownRow(deps, c);
    if (row === undefined) return notFound(c);
    if (row.status !== 'active') return c.json({ error: { code: 'GOAL_NOT_ACTIVE', message: 'Only an active goal can be checked' } }, 409);
    return c.json({ queued: await queueGoalWake(deps, row, 'manual') });
  });

  app.delete('/v1/goals/:id', async (c) => {
    const row = await ownRow(deps, c);
    if (row === undefined) return notFound(c);
    await deps.store.delete('goals', row.id);
    await deps.store.emit({ type: 'goal.deleted', goalId: row.id });
    return c.json({});
  });
}
