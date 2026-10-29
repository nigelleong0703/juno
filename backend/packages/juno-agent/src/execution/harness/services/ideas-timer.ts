/**
 * IdeasTimer Virtual Object (BACKEND §5.10): one hidden schedule per user, keyed by ownerId, that runs the daily ideas job once a
 * day in the morning of the user's clock. Only the Restate adapter lives here (durable clock, generation check, journaled
 * checkpoint); the job is `modules/ideas/job.ts`. Same shape as the MemoryTimer, and not a routine.
 */
import { object, rpc, type ObjectContext } from '@agent-desktop/durable';
import type { Brain, Store, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import type { HomeComputer } from '../../../ports/computer/index.js';
import { readOwnerTimeZone } from '../../brain/context.js';
import { inOwnerScope } from '../../execution-owner.js';
import { jobAgent } from '../../../modules/memory/jobs/agent.js';
import { runDailyIdeas, type IdeasCheckpoint, type IdeasDeps } from '../../../modules/ideas/job.js';
import { nextIdeasAt } from '../../../modules/ideas/schedule.js';
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

async function runJob(services: IdeasTimerServices, ownerId: string, checkpoint: IdeasCheckpoint, now: Date, force: boolean): Promise<{ job: IdeasCheckpoint; outcome: string; wake?: WakeEvent }> {
  const complete = services.brain.completeText?.bind(services.brain);
  if (complete === undefined) return { job: checkpoint, outcome: 'no model' };
  try {
    return await inOwnerScope(ownerId, async () => {
      if ((await jobAgent(services.store, ownerId)) === undefined) return { job: checkpoint, outcome: 'no agent' };
      const deps: IdeasDeps = {
        store: services.store, model: { complete }, tools: services.tools, catalog: services.catalog, now: () => now,
        ...(services.home === undefined ? {} : { home: services.home }),
        ...(services.connectorContext === undefined ? {} : { connectorContext: services.connectorContext }),
        ...(services.log === undefined ? {} : { log: services.log }),
      };
      const ran = await runDailyIdeas(deps, { ownerId, checkpoint, force });
      return { job: ran.checkpoint, outcome: ran.outcome, ...(ran.wake === undefined ? {} : { wake: ran.wake }) };
    });
  } catch (error) {
    services.log?.({ ownerId, error: error instanceof Error ? error.message : String(error) }, 'ideas job failed');
    return { job: checkpoint, outcome: 'failed' };
  }
}

export const createIdeasTimerService = (services: IdeasTimerServices) => {
  const schedule = async (ctx: ObjectContext, state: TimerState): Promise<void> => {
    const now = new Date(await ctx.date.now());
    const zone = await ctx.run('ideas-zone', async () => (await inOwnerScope(ctx.key, () => readOwnerTimeZone(services.store, ctx.key))) ?? null);
    const next = nextIdeasAt(now, ctx.key, zone ?? undefined);
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
      async fire(ctx: ObjectContext, params: { generation: number }): Promise<void> {
        const state = (await ctx.get<TimerState>('state')) ?? emptyState();
        if (params.generation !== state.generation) return;
        const now = new Date(await ctx.date.now());
        const ran = await ctx.run('ideas-job', () => runJob(services, ctx.key, state.job, now, false));
        state.job = ran.job;
        if (ran.wake !== undefined) ctx.objectSendClient<SessionDef>(sessionDef, ran.wake.sessionKey).receive(ran.wake);
        // The owner has no agent left (deleted): stop here. Creating an agent arms the schedule again.
        if (ran.outcome === 'no agent') {
          state.armed = false;
          delete state.nextAt;
          ctx.set('state', state);
          return;
        }
        await schedule(ctx, state);
      },
      /** Runs the job now, outside the schedule (tests and operators); `force` also ignores "already ran today" and "nothing changed". */
      async runNow(ctx: ObjectContext, params?: { force?: boolean }): Promise<{ outcome: string }> {
        const state = (await ctx.get<TimerState>('state')) ?? emptyState();
        const now = new Date(await ctx.date.now());
        const ran = await ctx.run('ideas-job-now', () => runJob(services, ctx.key, state.job, now, params?.force === true));
        ctx.set('state', { ...state, job: ran.job });
        if (ran.wake !== undefined) ctx.objectSendClient<SessionDef>(sessionDef, ran.wake.sessionKey).receive(ran.wake);
        return { outcome: ran.outcome };
      },
    },
  });
};
