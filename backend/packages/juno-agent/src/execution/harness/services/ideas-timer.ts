/**
 * IdeasTimer Virtual Object (BACKEND §5.10): one hidden schedule per user, keyed by ownerId, that runs the daily ideas job once a
 * day in the morning of the user's clock. Only the durable adapter lives here (durable clock, generation check, journaled
 * checkpoint); the job is `modules/ideas/job.ts`. Same shape as the MemoryTimer, and not a routine.
 */
import { object, rpc, type ObjectContext } from '@agent-desktop/durable';
import type { Brain, Store, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import type { HomeComputer } from '../../../ports/computer/index.js';
import { readOwnerTimeZone } from '../../brain/context.js';
import { inOwnerScope } from '../../execution-owner.js';
import { jobAgent } from '../../../modules/memory/jobs/agent.js';
import { runDailyIdeas, type IdeasCheckpoint, type IdeasDeps } from '../../../modules/ideas/job.js';
import { nextIdeasAt, readDailyCheck } from '../../../modules/ideas/schedule.js';
import { ideasTimerDef, sessionDef, type SessionDef } from './definitions.js';

type IdeasTimerDef = typeof ideasTimerDef;

export interface IdeasTimerServices {
  store: Store;
  brain: Brain;
  tools: Pick<ToolRegistry, 'forAgent'>;
  /** The connectors this deployment offers (see IdeasDeps.catalog). */
  catalog: IdeasDeps['catalog'];
  home?: HomeComputer;
  /** Connector data for the job (read-only snapshots); none until connectors provide it. */
  connectorContext?: IdeasDeps['connectorContext'];
  log?: (fields: Record<string, unknown>, message: string) => void;
}

interface TimerState {
  armed: boolean;
  generation: number;
  nextAt?: string;
  job: IdeasCheckpoint;
}

const emptyState = (): TimerState => ({ armed: false, generation: 0, job: {} });

async function runJob(services: IdeasTimerServices, ownerId: string, checkpoint: IdeasCheckpoint, now: Date, force: boolean): Promise<{ job: IdeasCheckpoint; outcome: string; wakes: WakeEvent[] }> {
  const complete = services.brain.completeText?.bind(services.brain);
  if (complete === undefined) return { job: checkpoint, outcome: 'no model', wakes: [] };
  try {
    return await inOwnerScope(ownerId, async () => {
      if ((await jobAgent(services.store, ownerId)) === undefined) return { job: checkpoint, outcome: 'no agent', wakes: [] };
      const deps: IdeasDeps = {
        store: services.store, model: { complete }, tools: services.tools, catalog: services.catalog, now: () => now,
        ...(services.home === undefined ? {} : { home: services.home }),
        ...(services.connectorContext === undefined ? {} : { connectorContext: services.connectorContext }),
        ...(services.log === undefined ? {} : { log: services.log }),
      };
      const ran = await runDailyIdeas(deps, { ownerId, checkpoint, force });
      return { job: ran.checkpoint, outcome: ran.outcome, wakes: ran.wakes };
    });
  } catch (error) {
    services.log?.({ ownerId, error: error instanceof Error ? error.message : String(error) }, 'ideas job failed');
    return { job: checkpoint, outcome: 'failed', wakes: [] };
  }
}

export const createIdeasTimerService = (services: IdeasTimerServices) => {
  /**
   * Each planned notice is a durable delayed send to this timer's `deliver`, at the time the job chose (`wake.at`). The key is the wake id
   * (owner, local date, item), so a retried run schedules nothing twice.
   */
  const planDeliveries = (ctx: ObjectContext, wakes: readonly WakeEvent[], now: Date): void => {
    for (const wake of wakes) {
      ctx.objectSendClient<IdeasTimerDef>(ideasTimerDef, ctx.key).deliver({ wake }, rpc.sendOpts({ delay: Math.max(0, Date.parse(wake.at) - now.getTime()), idempotencyKey: wake.id }));
    }
  };
  const schedule = async (ctx: ObjectContext, state: TimerState): Promise<void> => {
    const now = new Date(await ctx.date.now());
    const zone = await ctx.run('ideas-zone', async () => (await inOwnerScope(ctx.key, () => readOwnerTimeZone(services.store, ctx.key))) ?? null);
    const time = await ctx.run('ideas-time', async () => (await inOwnerScope(ctx.key, () => readDailyCheck(services.store, ctx.key))).time ?? null);
    const next = nextIdeasAt(now, ctx.key, zone ?? undefined, time ?? undefined);
    state.generation += 1;
    state.armed = true;
    state.nextAt = next.toISOString();
    ctx.objectSendClient<IdeasTimerDef>(ideasTimerDef, ctx.key).fire({ generation: state.generation }, rpc.sendOpts({ delay: Math.max(0, next.getTime() - now.getTime()) }));
    ctx.set('state', state);
  };
  return object({
    name: 'IdeasTimer',
    handlers: {
      /** Starts the schedule when none is running; calling it again is harmless. */
      async arm(ctx: ObjectContext): Promise<void> {
        const state = (await ctx.get<TimerState>('state')) ?? emptyState();
        if (state.armed && state.nextAt !== undefined && Date.parse(state.nextAt) > (await ctx.date.now())) return;
        await schedule(ctx, state);
      },
      /**
       * The owner changed the time of the daily check or their time zone: schedule again now. The new generation makes the earlier
       * timer's `fire` a no-op, and the job's own "already ran for this local date" check keeps a move on the same day from running twice.
       */
      async reschedule(ctx: ObjectContext): Promise<void> {
        await schedule(ctx, (await ctx.get<TimerState>('state')) ?? emptyState());
      },
      async fire(ctx: ObjectContext, params: { generation: number }): Promise<void> {
        const state = (await ctx.get<TimerState>('state')) ?? emptyState();
        if (params.generation !== state.generation) return;
        const now = new Date(await ctx.date.now());
        const ran = await ctx.run('ideas-job', () => runJob(services, ctx.key, state.job, now, false));
        state.job = ran.job;
        planDeliveries(ctx, ran.wakes, now);
        // The owner has no agent left (deleted): stop here. Creating an agent arms the schedule again.
        if (ran.outcome === 'no agent') {
          state.armed = false;
          delete state.nextAt;
          ctx.set('state', state);
          return;
        }
        await schedule(ctx, state);
      },
      /**
       * A planned notice is due: hand it to its conversation's agent, unless the owner switched the daily check off since it was planned
       * (the setting is read now, not when it was planned).
       */
      async deliver(ctx: ObjectContext, params: { wake: WakeEvent }): Promise<void> {
        const on = await ctx.run('ideas-deliver-on', async () => (await inOwnerScope(ctx.key, () => readDailyCheck(services.store, ctx.key))).enabled);
        if (!on) {
          services.log?.({ ownerId: ctx.key, wake: params.wake.id }, 'daily notice not sent: the daily check is off');
          return;
        }
        ctx.objectSendClient<SessionDef>(sessionDef, params.wake.sessionKey).receive(params.wake);
      },
      /** Runs the job now, outside the schedule (tests and operators); `force` also ignores "already ran today" and "nothing changed". */
      async runNow(ctx: ObjectContext, params?: { force?: boolean }): Promise<{ outcome: string }> {
        const state = (await ctx.get<TimerState>('state')) ?? emptyState();
        const now = new Date(await ctx.date.now());
        const ran = await ctx.run('ideas-job-now', () => runJob(services, ctx.key, state.job, now, params?.force === true));
        ctx.set('state', { ...state, job: ran.job });
        planDeliveries(ctx, ran.wakes, now);
        return { outcome: ran.outcome };
      },
    },
  });
};
