/**
 * MemoryTimer Virtual Object (BACKEND §5.4): one hidden schedule per user, keyed by ownerId. Every hour at the user's own minute it
 * starts the goal check-ins and the daily goal briefing that are due, and in the 3 a.m. hour of the user's clock the nightly memory job
 * after them. The memory of a chat is not read here: the ChatDigest object does that once the chat goes quiet. This file is only the
 * Restate adapter (durable clock, generation check, journaled checkpoints); the jobs live in `modules/` and know nothing about Restate.
 * The schedule is not shown in the app and is not a routine.
 */
import { object, rpc, type ObjectContext } from '@agent-desktop/durable';
import type { Brain, Store } from '../../../contracts/index.js';
import type { HomeComputer } from '../../../ports/computer/index.js';
import { readOwnerTimeZone } from '../../brain/context.js';
import { inOwnerScope } from '../../execution-owner.js';
import type { MemoryPort } from '../../../modules/memory/port.js';
import { jobAgent } from '../../../modules/memory/jobs/agent.js';
import { runNightly } from '../../../modules/memory/jobs/nightly.js';
import { nextHourlyAt, nightlyDue } from '../../../modules/memory/jobs/schedule.js';
import { EMPTY_JOB_STATE, type JobDeps, type JobState } from '../../../modules/memory/jobs/types.js';
import { runGoalBriefing } from '../../../modules/goals/briefing.js';
import { collectDueWakes } from '../../../modules/goals/checkin.js';
import type { WakeEvent } from '../../../contracts/index.js';
import { memoryTimerDef, sessionDef, type MemoryJobName, type SessionDef } from './definitions.js';

type MemoryTimerDef = typeof memoryTimerDef;

export interface MemoryTimerServices {
  store: Store;
  brain: Brain;
  home?: HomeComputer;
  /** Memory (Postgres): the jobs write items and render the views from them; without it the jobs do not run. */
  memory?: MemoryPort;
  log?: (fields: Record<string, unknown>, message: string) => void;
}

interface TimerState {
  armed: boolean;
  generation: number;
  nextAt?: string;
  job: JobState;
}

const emptyState = (): TimerState => ({ armed: false, generation: 0, job: EMPTY_JOB_STATE });

/** Runs the job(s) due now for one owner and returns the new checkpoints; a failure is logged and leaves them as they were. */
async function runJobs(services: MemoryTimerServices, ownerId: string, job: JobState, which: 'due' | MemoryJobName, now: Date): Promise<{ job: JobState; outcome: string }> {
  const { store, brain } = services;
  const complete = brain.completeText?.bind(brain);
  if (complete === undefined) return { job, outcome: 'no model' };
  try {
    return await inOwnerScope(ownerId, async () => {
      const target = await jobAgent(store, ownerId);
      if (target === undefined) return { job, outcome: 'no agent' };
      // The items and the identity graph are Postgres: without them the jobs wait (the schedule stays armed for a deployment that has them).
      const memory = services.memory;
      if (memory === undefined) return { job, outcome: 'no database' };
      const deps: JobDeps = {
        store, model: { complete }, now: () => now, memory: memory.graph,
        ...(services.home === undefined ? {} : { home: services.home }),
        ...(services.log === undefined ? {} : { log: services.log }),
      };
      const base = { ownerId, agentId: target.agent.id };
      let next = job;
      let outcome = 'skipped';
      const night = nightlyDue(now, await readOwnerTimeZone(store, ownerId), job.nightly.date);
      if (which === 'nightly' || (which === 'due' && night.due)) {
        const nightly = await runNightly(deps, { ...base, agents: target.agents.map((agent) => ({ id: agent.id, name: agent.name })), checkpoint: job.nightly });
        next = { ...next, nightly: nightly.checkpoint };
        outcome = which === 'nightly' ? nightly.outcome : outcome + '+' + nightly.outcome;
      }
      if (which === 'due' || which === 'briefing') {
        const briefing = await runGoalBriefing(deps, { ...base, checkpoint: job.goals ?? {} });
        next = { ...next, goals: briefing.checkpoint };
        outcome = which === 'briefing' ? briefing.outcome : outcome + '+goals:' + briefing.outcome;
      }
      return { job: next, outcome };
    });
  } catch (error) {
    services.log?.({ ownerId, error: error instanceof Error ? error.message : String(error) }, 'memory job failed');
    return { job, outcome: 'failed' };
  }
}

/** The goal wakes due for this owner at `now`; each goal's next check is already moved on, so a retry of this step starts nothing twice. */
async function goalWakes(services: MemoryTimerServices, ownerId: string, now: Date): Promise<WakeEvent[]> {
  try {
    return await inOwnerScope(ownerId, () => collectDueWakes(services.store, ownerId, now));
  } catch (error) {
    services.log?.({ ownerId, error: error instanceof Error ? error.message : String(error) }, 'goal check-ins failed');
    return [];
  }
}

export const createMemoryTimerHandlers = (services: MemoryTimerServices) => {
  const schedule = async (ctx: ObjectContext, state: TimerState): Promise<void> => {
    const now = new Date(await ctx.date.now());
    const next = nextHourlyAt(now, ctx.key);
    state.generation += 1;
    state.armed = true;
    state.nextAt = next.toISOString();
    ctx.objectSendClient<MemoryTimerDef>(memoryTimerDef, ctx.key).fire({ generation: state.generation }, rpc.sendOpts({ delay: Math.max(0, next.getTime() - now.getTime()) }));
    ctx.set('state', state);
  };
  return {
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
      const ran = await ctx.run('memory-jobs', () => runJobs(services, ctx.key, state.job, 'due', now));
      state.job = ran.job;
      // The owner has no agent left (deleted): stop here. Creating an agent arms the schedule again.
      if (ran.outcome === 'no agent') {
        state.armed = false;
        delete state.nextAt;
        ctx.set('state', state);
        return;
      }
      const wakes = await ctx.run('goal-wakes', () => goalWakes(services, ctx.key, now));
      for (const wake of wakes) ctx.objectSendClient<SessionDef>(sessionDef, wake.sessionKey).receive(wake);
      await schedule(ctx, state);
    },
    /** Runs one job now, outside the schedule (tests and operators); the schedule itself is untouched. */
    async runNow(ctx: ObjectContext, params: { job: MemoryJobName; at?: string }): Promise<{ outcome: string }> {
      const state = (await ctx.get<TimerState>('state')) ?? emptyState();
      const now = params.at === undefined ? new Date(await ctx.date.now()) : new Date(params.at);
      if (params.job === 'goals') {
        const wakes = await ctx.run('goal-wakes-now', () => goalWakes(services, ctx.key, now));
        for (const wake of wakes) ctx.objectSendClient<SessionDef>(sessionDef, wake.sessionKey).receive(wake);
        return { outcome: 'wakes:' + String(wakes.length) };
      }
      const ran = await ctx.run('memory-jobs-now', () => runJobs(services, ctx.key, state.job, params.job, now));
      ctx.set('state', { ...state, job: ran.job });
      return { outcome: ran.outcome };
    },
  };
};

export const createMemoryTimerService = (services: MemoryTimerServices) => object({ name: 'MemoryTimer', handlers: createMemoryTimerHandlers(services) });
