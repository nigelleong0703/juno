/**
 * ChatDigest Virtual Object (BACKEND §5.4, §5.7.9, §5.10): one per conversation (key = conversation id) that runs the chat digest once the
 * chat has been quiet for a while. Each message the owner writes there (or each time they address the agent in a group) postpones the
 * run (generation check). Only the durable adapter lives here (journaled job, checkpoint in state); the job is `modules/digest/job.ts`.
 */
import { object, rpc, type ObjectContext } from '@agent-desktop/durable';
import type { Brain, Store } from '../../../contracts/index.js';
import type { HomeComputer } from '../../../ports/computer/index.js';
import { runChatDigest, type DigestCheckpoint, type DigestTarget } from '../../../modules/digest/job.js';
import type { MemoryPort } from '../../../modules/memory/port.js';
import { jobAgent } from '../../../modules/memory/jobs/agent.js';
import type { ChannelPort } from '../../../modules/tools/tools/channelHistory.js';
import { inOwnerScope } from '../../execution-owner.js';
import { chatDigestDef, type ChatDigestDef } from './definitions.js';

export interface ChatDigestServices {
  store: Store;
  brain: Brain;
  /** Memory (Postgres): the digest writes items and renders the views from them. */
  memory?: MemoryPort;
  home?: HomeComputer;
  /** The platform chats' history, for a group note. */
  channels?: ChannelPort;
  /** Arms the timer of a follow-up the digest put in the agent's schedule (BACKEND 6.7). */
  scheduleCalendarItem?: (itemId: string) => Promise<void>;
  /** How long the chat must be quiet before the digest runs. */
  quietMs: number;
  /** Observed group messages (BACKEND 6.8): the digest runs at this many unread ones, or this long after the first unread one. */
  observeUnreadMax?: number;
  observeEveryMs?: number;
  log?: (fields: Record<string, unknown>, message: string) => void;
}

/** Unread observed messages that start a digest at once, and how long after the first one a smaller number waits. */
export const OBSERVE_UNREAD_MAX = 30;
export const OBSERVE_EVERY_MS = 60 * 60_000;

interface DigestState {
  generation: number;
  target?: DigestTarget;
  checkpoint: DigestCheckpoint;
  /** Observed messages counted since the last digest. */
  unread?: number;
}

const emptyState = (): DigestState => ({ generation: 0, checkpoint: {} });

async function runJob(services: ChatDigestServices, target: DigestTarget, checkpoint: DigestCheckpoint): Promise<{ checkpoint: DigestCheckpoint; outcome: string }> {
  const complete = services.brain.completeText?.bind(services.brain);
  if (complete === undefined) return { checkpoint, outcome: 'no model' };
  const memory = services.memory;
  // The digest writes memory items: without the database it does not run (the chat's checkpoint stays where it was).
  if (memory === undefined) return { checkpoint, outcome: 'no database' };
  try {
    return await inOwnerScope(target.ownerId, async () => {
      // The agents the owner has: an assistant the claims may be kept for (`forAgent`) is one of them.
      const job = await jobAgent(services.store, target.ownerId);
      if (job === undefined) return { checkpoint, outcome: 'no agent' };
      const ran = await runChatDigest({
        store: services.store, model: { complete }, memory, now: () => new Date(),
        ...(services.home === undefined ? {} : { home: services.home }),
        ...(services.channels === undefined ? {} : { channels: services.channels }),
        ...(services.scheduleCalendarItem === undefined ? {} : { scheduleCalendarItem: services.scheduleCalendarItem }),
        ...(services.log === undefined ? {} : { log: services.log }),
      }, { ...target, agents: job.agents.map((agent) => ({ id: agent.id, name: agent.name })), checkpoint });
      return { checkpoint: ran.checkpoint, outcome: ran.outcome };
    });
  } catch (error) {
    services.log?.({ ...target, error: error instanceof Error ? error.message : String(error) }, 'chat digest failed');
    return { checkpoint, outcome: 'failed' };
  }
}

export const createChatDigestService = (services: ChatDigestServices) => object({
  name: 'ChatDigest',
  handlers: {
    /** The owner wrote in this chat (or addressed the agent in a group): postpone the digest to `quietMs` after this message (an older pending `fire` becomes stale). */
    async touch(ctx: ObjectContext, target: DigestTarget): Promise<void> {
      const state = (await ctx.get<DigestState>('state')) ?? emptyState();
      state.generation += 1;
      state.target = target;
      ctx.set('state', state);
      ctx.objectSendClient<ChatDigestDef>(chatDigestDef, ctx.key).fire({ generation: state.generation }, rpc.sendOpts({ delay: services.quietMs }));
    },
    /**
     * A group message the agent only observed: count it. The digest starts when enough are unread (`observeUnreadMax`) and otherwise
     * once, `observeEveryMs` after the first unread one; later messages neither postpone it nor add runs. Never one run per message.
     */
    async observe(ctx: ObjectContext, target: DigestTarget): Promise<void> {
      const state = (await ctx.get<DigestState>('state')) ?? emptyState();
      const unread = (state.unread ?? 0) + 1;
      state.target = target;
      state.unread = unread;
      if (target.immediate === true || unread >= (services.observeUnreadMax ?? OBSERVE_UNREAD_MAX)) {
        state.generation += 1;
        ctx.set('state', state);
        ctx.objectSendClient<ChatDigestDef>(chatDigestDef, ctx.key).fire({ generation: state.generation });
        return;
      }
      if (target.quiet === true) {
        // Where the agent may speak up, a burst of observed messages is read once the thread has been quiet (each message postpones it), so
        // a question only the agent can answer is picked up within minutes without a run per message.
        state.generation += 1;
        ctx.set('state', state);
        ctx.objectSendClient<ChatDigestDef>(chatDigestDef, ctx.key).fire({ generation: state.generation }, rpc.sendOpts({ delay: services.quietMs }));
        return;
      }
      if (unread === 1) state.generation += 1;
      ctx.set('state', state);
      if (unread === 1) ctx.objectSendClient<ChatDigestDef>(chatDigestDef, ctx.key).fire({ generation: state.generation }, rpc.sendOpts({ delay: services.observeEveryMs ?? OBSERVE_EVERY_MS }));
    },
    async fire(ctx: ObjectContext, params: { generation: number }): Promise<void> {
      const state = (await ctx.get<DigestState>('state')) ?? emptyState();
      if (params.generation !== state.generation || state.target === undefined) return;
      const target = state.target;
      const ran = await ctx.run('chat-digest', () => runJob(services, target, state.checkpoint));
      ctx.set('state', { ...state, checkpoint: ran.checkpoint, unread: 0 });
    },
    /** Runs the digest now, outside the quiet window (tests and operators). */
    async runNow(ctx: ObjectContext, params?: DigestTarget): Promise<{ outcome: string }> {
      const state = (await ctx.get<DigestState>('state')) ?? emptyState();
      const target = state.target ?? params;
      if (target === undefined) return { outcome: 'skipped' };
      const ran = await ctx.run('chat-digest-now', () => runJob(services, target, state.checkpoint));
      ctx.set('state', { ...state, target, checkpoint: ran.checkpoint, unread: 0 });
      return { outcome: ran.outcome };
    },
  },
});
