import { randomUUID } from 'node:crypto';
import { type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Routine } from '@agent-desktop/public-contracts';
import {
  createRoutineInputSchema,
  updateRoutineInputSchema,
  type UpdateRoutineInput,
} from '@agent-desktop/public-contracts';
import { NotFoundError } from '@agent-desktop/contracts';
import { getOwnerId } from '../auth.js';
import { parseListQuery } from './query-helpers.js';
import { isRelationshipError, paginateFiltered } from './relationships.js';
import { resolveRoutineTarget, validateRoutineDelivery } from './routine-scope.js';
import type { AgentdDeps } from './index.js';
import { routineIntervalRefusal } from 'juno-agent/modules/tasks/routines/interval';
import { missingRequirements } from 'juno-agent/modules/tasks/routines/capabilities';
import { haveForOwner, raiseConnectRequest, reconcileOwner, resolveConnectRequests, type GateDeps } from 'juno-agent/modules/tasks/routines/capability-gate';

const toggleRoutineInputSchema = z.object({ enabled: z.boolean().optional() });

const MONITOR_BY_AGENT = { code: 'MONITOR_BY_AGENT', message: 'a monitor is made by the agent in a chat (monitor_create); it can be paused, checked now or deleted here, not created or edited' };

/** What the capability gate checks `requires` against besides the owner's connectors: the deployment's web search and computer service. */
export function gateDeps(deps: AgentdDeps): GateDeps {
  const computerd = deps.computerd;
  const macUsable = computerd === undefined ? undefined : async (agentId: string): Promise<boolean> => {
    if ((await deps.store.get('agents', agentId))?.macAccess !== true) return false;
    const mac = await computerd.macStatus(AbortSignal.timeout(5_000)).catch(() => undefined);
    return mac?.paired === true && mac.online;
  };
  return { store: deps.store, enqueuer: deps.enqueuer, capabilities: { webSearch: String(deps.config?.['SEARCH_PROVIDER'] ?? '') !== '', computer: computerd !== undefined }, ...(macUsable ? { macUsable } : {}) };
}

/** After the owner edited or re-enabled a routine: put its status in line with `requires`, without waking the agent (the owner is the one acting). */
async function settleRoutine(deps: AgentdDeps, ownerId: string, routine: Routine): Promise<Routine> {
  if ((routine.requires?.length ?? 0) > 0) {
    await reconcileOwner(gateDeps(deps), ownerId, { routineId: routine.id, wake: false });
    return (await deps.store.get('routines', routine.id)) ?? routine;
  }
  if (routine.status !== 'needs_setup') return routine;
  const cleared = await deps.store.patch('routines', routine.id, { status: 'active', missing: undefined });
  await resolveConnectRequests(deps.store, cleared, ownerId);
  await deps.enqueuer.scheduleRoutine(routine.id);
  await deps.store.emit({ type: 'routine.updated', routine: cleared });
  return cleared;
}

export function registerRoutines(app: Hono, deps: AgentdDeps) {
  app.get('/v1/routines', async (c) => {
    const query = parseListQuery(Object.fromEntries(Object.entries(c.req.query())));
    const page = await deps.store.list('routines', {
      ...query,
    });
    return c.json({ items: page.items, nextCursor: page.nextCursor });
  });

  app.get('/v1/routines/:id', async (c) => {
    const routine = await deps.store.get('routines', c.req.param('id'));
    if (!routine) throw new NotFoundError('routines', c.req.param('id'));
    return c.json(routine);
  });

  app.post(
    '/v1/routines',
    zValidator('json', createRoutineInputSchema),
    async (c) => {
      const ownerId = getOwnerId(c);
      const input = c.req.valid('json');
      if (input.trigger.kind === 'check') return c.json({ error: MONITOR_BY_AGENT }, 400);
      const target = await resolveRoutineTarget(deps.store, ownerId, input.agentId);
      if (isRelationshipError(target)) {
        return c.json({ error: { code: target.code, message: target.message } }, target.status);
      }
      const tooFrequent = routineIntervalRefusal(input.trigger);
      if (tooFrequent) return c.json({ error: { code: 'ROUTINE_TOO_FREQUENT', message: tooFrequent } }, 400);
      const delivery = input.delivery || { channel: 'chat' };
      const deliveryError = await validateRoutineDelivery(deps.store, ownerId, target.agent.id, delivery);
      if (deliveryError) {
        return c.json({ error: { code: deliveryError.code, message: deliveryError.message } }, deliveryError.status);
      }
      // Time-ordered and unique: a millisecond timestamp alone collides when two are created at once.
      const id = `rtn-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      const routine: Routine & { ownerId: string } = {
        id,
        agentId: target.agent.id,
        name: input.name,
        instructions: input.instructions || '',
        trigger: input.trigger,
        delivery,
        notify: input.notify || { mode: 'always' },
        enabled: input.enabled !== false,
        status: 'active',
        runs: [],
        createdAt: now,
        ownerId,
      };
      // What it needs that the owner does not have yet: the routine is stored as needs_setup and never fires.
      const requires = input.requires ?? [];
      const have = requires.length === 0 ? undefined : await haveForOwner(gateDeps(deps), ownerId, input.agentId);
      const missing = have === undefined ? [] : missingRequirements(requires, have);
      if (requires.length > 0) routine.requires = requires;
      if (missing.length > 0) Object.assign(routine, { status: 'needs_setup', missing });
      const created = await deps.store.put('routines', routine);
      await deps.enqueuer.scheduleRoutine(id);
      if (missing.length > 0) await raiseConnectRequest(deps.store, created, ownerId, missing, have);
      await deps.store.emit({ type: 'routine.updated', routine: created });
      return c.json(created, 201);
    }
  );

  app.patch(
    '/v1/routines/:id',
    zValidator('json', updateRoutineInputSchema.optional()),
    async (c) => {
      const ownerId = getOwnerId(c);
      const id = c.req.param('id');
      const patch: UpdateRoutineInput = c.req.valid('json') || {};
      // A monitor's check is made and validated by the agent; its trigger is neither edited nor given to another routine.
      if (patch.trigger !== undefined && (patch.trigger.kind === 'check' || (await deps.store.get('routines', id))?.trigger.kind === 'check')) {
        return c.json({ error: MONITOR_BY_AGENT }, 400);
      }
      const tooFrequent = patch.trigger === undefined ? undefined : routineIntervalRefusal(patch.trigger);
      if (tooFrequent) return c.json({ error: { code: 'ROUTINE_TOO_FREQUENT', message: tooFrequent } }, 400);
      // A patch that touches the target or delivery is a potential rebind, and enabling
      // (enabled:true / status active) is a target transition too. Re-resolve the combined
      // state against the owner and re-validate the delivery so a patch can never move a
      // routine to another owner's agent or chat; plain field edits stay cheap.
      const enabling = patch.enabled === true || patch.status === 'active';
      if (patch.agentId !== undefined || patch.delivery !== undefined || enabling) {
        const current = await deps.store.get('routines', id);
        if (!current) throw new NotFoundError('routines', id);
        const effectiveTrigger = patch.trigger ?? current.trigger;
        const tooFrequentOnEnable = enabling ? routineIntervalRefusal(effectiveTrigger) : undefined;
        if (tooFrequentOnEnable) return c.json({ error: { code: 'ROUTINE_TOO_FREQUENT', message: tooFrequentOnEnable } }, 400);
        const target = await resolveRoutineTarget(
          deps.store,
          ownerId,
          patch.agentId ?? current.agentId,
        );
        if (isRelationshipError(target)) {
          return c.json({ error: { code: target.code, message: target.message } }, target.status);
        }
        const delivery = patch.delivery ?? current.delivery;
        const deliveryError = await validateRoutineDelivery(deps.store, ownerId, target.agent.id, delivery);
        if (deliveryError) {
          return c.json({ error: { code: deliveryError.code, message: deliveryError.message } }, deliveryError.status);
        }
        patch.agentId = target.agent.id;
        patch.delivery = delivery;
      }
      const updated = await deps.store.patch('routines', id, patch);
      await deps.enqueuer.scheduleRoutine(id);
      await deps.store.emit({ type: 'routine.updated', routine: updated });
      return c.json(await settleRoutine(deps, ownerId, updated));
    }
  );

  app.post('/v1/routines/:id/toggle', async (c) => {
    const ownerId = getOwnerId(c);
    const id = c.req.param('id');
    const raw: unknown = await c.req.json().catch(() => undefined);
    const parsed = toggleRoutineInputSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return c.json({ error: { code: 'INVALID_TOGGLE', message: 'enabled must be a boolean' } }, 400);
    }
    const routine = await deps.store.get('routines', id);
    if (!routine) throw new NotFoundError('routines', id);

    const newEnabled = parsed.data.enabled !== undefined ? parsed.data.enabled : !routine.enabled;
    // Disabling is always allowed, even for an orphaned or stale row. Enabling is a target
    // transition: re-validate the agent and delivery.
    if (newEnabled) {
      // H-89: re-enabling an older routine that fires too often is refused like creating one.
      const tooFrequent = routineIntervalRefusal(routine.trigger);
      if (tooFrequent) return c.json({ error: { code: 'ROUTINE_TOO_FREQUENT', message: tooFrequent } }, 400);
      const target = await resolveRoutineTarget(deps.store, ownerId, routine.agentId);
      if (isRelationshipError(target)) {
        return c.json({ error: { code: target.code, message: target.message } }, target.status);
      }
      const deliveryError = await validateRoutineDelivery(deps.store, ownerId, target.agent.id, routine.delivery);
      if (deliveryError) {
        return c.json({ error: { code: deliveryError.code, message: deliveryError.message } }, deliveryError.status);
      }
      const enabled = await deps.store.patch('routines', id, { enabled: true });
      await deps.enqueuer.scheduleRoutine(id);
      await deps.store.emit({ type: 'routine.updated', routine: enabled });
      return c.json(await settleRoutine(deps, ownerId, enabled));
    }

    const disabled = await deps.store.patch('routines', id, { enabled: false });
    await deps.store.emit({ type: 'routine.updated', routine: disabled });
    return c.json(disabled);
  });

  /**
   * The owner's connections changed (an app was connected, disconnected or expired): routines waiting for one become
   * runnable and their agents are told; active routines that lost one go on hold. Called by the API after a connection
   * changes; the routine timer checks again when a routine fires.
   */
  app.post('/v1/capabilities/recheck', async (c) => c.json(await reconcileOwner(gateDeps(deps), getOwnerId(c))));

  app.delete('/v1/routines/:id', async (c) => {
    const gone = await deps.store.get('routines', c.req.param('id'));
    if (gone !== null) await resolveConnectRequests(deps.store, gone, getOwnerId(c), 'expired');
    await deps.store.delete('routines', c.req.param('id'));
    await deps.store.delete('monitorState', c.req.param('id'));
    return c.json({});
  });

  /** Check a monitor now (the owner asked); answers with what came of it. */
  app.post('/v1/routines/:id/check', async (c) => {
    const id = c.req.param('id');
    const routine = await deps.store.get('routines', id);
    if (!routine) throw new NotFoundError('routines', id);
    if (routine.trigger.kind !== 'check') return c.json({ error: { code: 'NOT_A_MONITOR', message: 'only a monitor can be checked now' } }, 400);
    if (!routine.enabled) return c.json({ error: { code: 'MONITOR_OFF', message: 'switch the monitor on first' } }, 409);
    const check = deps.enqueuer.checkRoutine;
    if (check === undefined) return c.json({ error: { code: 'CHECK_UNAVAILABLE', message: 'checks are not available here' } }, 501);
    const result = await check.call(deps.enqueuer, id);
    return c.json({ outcome: result.outcome, routine: (await deps.store.get('routines', id)) ?? routine });
  });

  /**
   * H-76: the routine's run history. The harness records it on the routine row (`routine.runs`, bounded);
   * the old read of the never-written `routineRuns` collection always returned an empty list.
   */
  app.get('/v1/routines/:id/runs', async (c) => {
    const routineId = c.req.param('id');
    const routine = await deps.store.get('routines', routineId);
    if (!routine) throw new NotFoundError('routines', routineId);
    const newestFirst = [...(routine.runs ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
    const page = paginateFiltered(newestFirst, c.req.query('limit'), c.req.query('cursor'));
    return c.json({ items: page.items, nextCursor: page.nextCursor ?? null });
  });
}
