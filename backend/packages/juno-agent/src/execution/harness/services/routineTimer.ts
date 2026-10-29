/**
 * RoutineTimer Virtual Object: durable clock, arm versioning and occurrence delivery.
 * Boot re-arming is done by agentd start.ts.
 *
 * BACKEND 5.2.1: this file is only the Restate adapter. Completion/read/history/pause policies
 * live in modules/tasks/routines (pure domain); delivery resolution lives in routineTimer-delivery.
 */

import { object, type ObjectContext, rpc } from '@agent-desktop/durable';
import { routineSchema, type Routine } from '@agent-desktop/public-contracts';
import { routineTimerDef, type RoutineTimerDef } from './definitions.js';
import { nextRunAt } from '../logic/schedule.js';
import { inOwnerScope } from '../../execution-owner.js';
import { defaultState, withDefaults, type Services, type TimerState } from './routineTimer-state.js';
import { deliverOccurrences, resolveDeliveryConversation, resolveRoutineOwner, routinesDeliveringTo } from './routineTimer-delivery.js';
import { appendRoutineRun, hasReadEvidence, resultIdsForHistory, writePauseNotice } from '../../../modules/tasks/routines/results.js';
import { reconcileOwner } from '../../../modules/tasks/routines/capability-gate.js';
import { announceRoutinePosts } from '../../../modules/feed/announce.js';
import { applyCompletion, applyRead, MAX_READ_RESULT_IDS } from '../../../modules/tasks/routines/policies.js';
import { nextCheckDelayMs } from '../../../modules/tasks/routines/monitor.js';
import { armMonitor, fireMonitor } from './routineTimer-monitor.js';

export { resolveDeliveryConversation, resolveRoutineOwner, routinesDeliveringTo } from './routineTimer-delivery.js';

export interface CompletionParams {
  routineId: string;
  runId?: string;
  occurrenceAt?: string;
  succeeded: boolean;
  itemsGenerated: number;
  outputIds?: string[];
  summary?: string;
}

export interface ReadParams {
  routineId: string;
  conversationId: string;
  readCutoff: string;
  resultIds: string[];
}

async function loadState(ctx: ObjectContext, routineId: string): Promise<TimerState> {
  return withDefaults((await ctx.get<TimerState>('state')) ?? defaultState(routineId));
}

/** One finished routine run: streaks, bounded history, auto-pause with a chat-local notice. */
async function completeRoutine(ctx: ObjectContext, services: Services, params: CompletionParams): Promise<void> {
  const routine = await ctx.run('load-routine', () => services.store.get('routines', params.routineId));
  if (routine === null) return;
  if (params.runId !== undefined && routine.runs.some((entry) => entry.runId === params.runId)) return;
  const now = new Date(await ctx.date.now()).toISOString();
  const state = await loadState(ctx, params.routineId);
  const decision = applyCompletion(
    { unreadStreak: state.unreadStreak, failStreak: state.failStreak, ...(state.lastResultAt === undefined ? {} : { lastResultAt: state.lastResultAt }) },
    { succeeded: params.succeeded, itemsGenerated: params.itemsGenerated, at: now },
  );
  const entryId = params.runId === undefined ? `rr-${params.routineId}-${Date.parse(now)}` : `rr-${params.runId}`;
  const status = params.succeeded ? 'completed' : 'failed';
  await ctx.run('append-history', () => appendRoutineRun(services.store, routine, {
    id: entryId,
    routineId: params.routineId,
    status,
    summary: params.summary ?? (params.succeeded ? `completed with ${Math.max(0, Math.floor(params.itemsGenerated))} output(s)` : 'failed'),
    ...(params.runId === undefined ? {} : { runId: params.runId }),
    ...(params.outputIds === undefined ? {} : { outputIds: params.outputIds }),
    startedAt: params.occurrenceAt ?? now,
    finishedAt: now,
  }));
  // A run that posted to the Feed is announced once (clients refetch; the push when the routine notifies).
  await ctx.run('feed-posts-announce', () => announceRoutinePosts(services.store, routine, params.occurrenceAt ?? now));
  state.unreadStreak = decision.unreadStreak;
  state.failStreak = decision.failStreak;
  if (decision.lastResultAt !== undefined) state.lastResultAt = decision.lastResultAt;
  if (decision.paused !== false) {
    const paused = await ctx.run('pause-routine', () => services.store.patch('routines', params.routineId, { enabled: false, status: 'paused' }));
    state.armed = false;
    state.pausedAt = now;
    const conversationId = await ctx.run('pause-conversation', () => resolveDeliveryConversation(paused, services.store));
    if (conversationId !== undefined) await ctx.run('pause-notice', () => writePauseNotice(services.store, paused, conversationId, decision.paused === false ? 'unread' : decision.paused.reason, now));
    await ctx.run('pause-event', () => services.store.emit({ type: 'routine.updated', routine: paused }));
  }
  ctx.set('state', state);
}

/** An authorized read receipt: monotonic cutoff, actual-conversation match, no late rewinds. */
async function readRoutine(ctx: ObjectContext, services: Services, params: ReadParams): Promise<void> {
  const routine = await ctx.run('load-routine', () => services.store.get('routines', params.routineId));
  if (routine === null) return;
  if (routine.delivery.target !== undefined) {
    if (routine.delivery.target !== params.conversationId) return;
  } else if ((await ctx.run('read-conversation', () => resolveDeliveryConversation(routine, services.store))) !== params.conversationId) {
    return;
  }
  const state = await loadState(ctx, params.routineId);
  if (!hasReadEvidence(routine, params.readCutoff, params.resultIds)) return;
  const decision = applyRead(
    { unreadStreak: state.unreadStreak, failStreak: state.failStreak, ...(state.lastResultAt === undefined ? {} : { lastResultAt: state.lastResultAt }), ...(state.lastReadCutoff === undefined ? {} : { lastReadCutoff: state.lastReadCutoff }) },
    { readCutoff: params.readCutoff },
  );
  state.unreadStreak = decision.unreadStreak;
  state.lastReadCutoff = decision.lastReadCutoff;
  state.lastReadResultIds = params.resultIds.filter((id) => resultIdsForHistory(routine, params.readCutoff).includes(id)).slice(-MAX_READ_RESULT_IDS);
  await ctx.run('read-watermark', () => services.store.patch('routines', params.routineId, { lastReadAt: decision.lastReadCutoff }));
  ctx.set('state', state);
}

/** A monitor (a `check` routine) does not run while the monitors plugin is off; its routine stays as it is. */
const monitorsPaused = (services: Services, routine: Routine): boolean => routine.trigger.kind === 'check' && services.monitorChecks === false;

/** A routine whose agent was deleted does nothing and is not re-armed (the agent delete path also removes the routine). */
const agentIsGone = (ctx: ObjectContext, services: Services, routine: Routine): Promise<boolean> =>
  ctx.run('routine-agent-gone', async () => routine.agentId.length > 0 && (await services.store.get('agents', routine.agentId)) === null);

export const createRoutineTimerHandlers = (services: Services) => ({
    async arm(ctx: ObjectContext, input: unknown): Promise<void> {
      const parsed = routineSchema.safeParse(input);
      if (!parsed.success || parsed.data.id !== ctx.key) return;
      // A queued arm may carry an old enabled projection after completion paused it.
      const routine = await ctx.run('arm-routine', () => services.store.get('routines', parsed.data.id));
      if (routine === null) return;
      const state = await loadState(ctx, routine.id);
      // needs_setup waits for the owner to connect what it needs; the capability gate re-arms it then.
      const trigger = routine.trigger;
      if (!routine.enabled || routine.status === 'needs_setup' || (trigger.kind !== 'schedule' && trigger.kind !== 'check') || monitorsPaused(services, routine) || (await agentIsGone(ctx, services, routine))) {
        state.armed = false;
        ctx.set('state', state);
        return;
      }
      if (routine.enabled && state.pausedAt !== undefined) {
        state.unreadStreak = 0;
        state.failStreak = 0;
        state.pausedAt = undefined;
      }
      const now = new Date(await ctx.date.now());
      // A monitor waits its interval (longer after failures); the first check is one interval after it was made.
      const ownerId = trigger.kind === 'check' ? await ctx.run('arm-owner', () => resolveRoutineOwner(services.store, routine)) : undefined;
      const next = trigger.kind === 'check'
        ? new Date(now.getTime() + nextCheckDelayMs(trigger.everyMinutes, ownerId === undefined ? 0 : await ctx.run('arm-monitor', () => inOwnerScope(ownerId, () => armMonitor(services.store, routine, now.toISOString())))))
        : nextRunAt(trigger, now);
      if (!next) {
        state.armed = false;
        ctx.set('state', state);
        return;
      }
      // A first arm or a re-enable starts catch-up here: the time before it (never armed, or paused/disabled) is not downtime.
      if (!state.armed) state.lastFiredAt = now.toISOString();
      state.armGeneration += 1;
      state.nextRunAtTime = next.toISOString();
      state.armed = true;
      const delayMs = Math.max(0, next.getTime() - now.getTime());
      ctx.objectSendClient<RoutineTimerDef>(routineTimerDef, routine.id).fire(
        { at: next.toISOString(), routineId: routine.id, generation: state.armGeneration },
        rpc.sendOpts({ delay: delayMs }),
      );
      await ctx.run('arm-projection', () => services.store.patch('routines', routine.id, { nextRunAt: next.toISOString() }));
      ctx.set('state', state);
    },

    async fire(ctx: ObjectContext, params: { at: string; routineId: string; generation: number }): Promise<void> {
      if (ctx.key !== params.routineId) return;
      const routine = await ctx.run('handler-routine', () => services.store.get('routines', params.routineId));
      if (routine === null || !routine.enabled || routine.status === 'needs_setup' || (routine.trigger.kind !== 'schedule' && routine.trigger.kind !== 'check') || monitorsPaused(services, routine)) return;
      const state = await loadState(ctx, params.routineId);
      if (await agentIsGone(ctx, services, routine)) {
        state.armed = false;
        ctx.set('state', state);
        return;
      }
      if (params.generation !== state.armGeneration || params.at !== state.nextRunAtTime) return;
      const ownerId = await ctx.run('routine-owner', () => resolveRoutineOwner(services.store, routine));
      if (ownerId === undefined) return;
      if (routine.trigger.kind === 'check') {
        await inOwnerScope(ownerId, () => fireMonitor(ctx, services, routine, ownerId));
        return;
      }
      // A connection can be lost without anyone telling the timer: check what the routine declared before it runs.
      if ((routine.requires?.length ?? 0) > 0) {
        const lost = await ctx.run('capability-gate', () => inOwnerScope(ownerId, () => reconcileOwner({ ...services, capabilities: services.capabilities ?? { webSearch: false, computer: false } }, ownerId, { routineId: routine.id })));
        if (lost.lost.includes(routine.id)) return;
      }
      await inOwnerScope(ownerId, () => deliverOccurrences(ctx, services, routine, ownerId));
    },

    /** The owner asked for a monitor's check now: run it, wait for the outcome, and schedule the next check from here. */
    async checkNow(ctx: ObjectContext): Promise<{ outcome: string }> {
      const routine = await ctx.run('handler-routine', () => services.store.get('routines', ctx.key));
      if (routine === null || !routine.enabled || routine.trigger.kind !== 'check' || monitorsPaused(services, routine)) return { outcome: 'unavailable' };
      const ownerId = await ctx.run('routine-owner', () => resolveRoutineOwner(services.store, routine));
      if (ownerId === undefined) return { outcome: 'unavailable' };
      return inOwnerScope(ownerId, () => fireMonitor(ctx, services, routine, ownerId));
    },

    async recordCompletion(ctx: ObjectContext, params: CompletionParams): Promise<void> {
      if (ctx.key !== params.routineId) return;
      const routine = await ctx.run('handler-routine', () => services.store.get('routines', params.routineId));
      const ownerId = routine === null ? undefined : await ctx.run('routine-owner', () => resolveRoutineOwner(services.store, routine));
      if (ownerId === undefined) return;
      await inOwnerScope(ownerId, () => completeRoutine(ctx, services, params));
    },

    async recordRead(ctx: ObjectContext, params: ReadParams): Promise<void> {
      if (ctx.key !== params.routineId) return;
      const routine = await ctx.run('handler-routine', () => services.store.get('routines', params.routineId));
      const ownerId = routine === null ? undefined : await ctx.run('routine-owner', () => resolveRoutineOwner(services.store, routine));
      if (ownerId === undefined) return;
      await inOwnerScope(ownerId, () => readRoutine(ctx, services, params));
    },
});

export const createRoutineTimerService = (services: Services) => object({
  name: 'RoutineTimer',
  handlers: createRoutineTimerHandlers(services),
});
