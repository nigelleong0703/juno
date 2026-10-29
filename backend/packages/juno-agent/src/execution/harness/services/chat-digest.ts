/**
 * ChatDigest Virtual Object (BACKEND §5.4, §5.7.9, §5.10): one per conversation (key = conversation id) that runs the chat digest once the
 * chat has been quiet for a while. Each message the owner writes there (or each time they address the agent in a group) postpones the
 * run (generation check). Only the Restate adapter lives here (journaled job, checkpoint in state); the job is `modules/digest/job.ts`.
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
  /** How long the chat must be quiet before the digest runs. */
  quietMs: number;
  log?: (fields: Record<string, unknown>, message: string) => void;
}

interface DigestState {
  generation: number;
  target?: DigestTarget;
  checkpoint: DigestCheckpoint;
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
    async fire(ctx: ObjectContext, params: { generation: number }): Promise<void> {
      const state = (await ctx.get<DigestState>('state')) ?? emptyState();
      if (params.generation !== state.generation || state.target === undefined) return;
      const target = state.target;
      const ran = await ctx.run('chat-digest', () => runJob(services, target, state.checkpoint));
      ctx.set('state', { ...state, checkpoint: ran.checkpoint });
    },
    /** Runs the digest now, outside the quiet window (tests and operators). */
    async runNow(ctx: ObjectContext, params?: DigestTarget): Promise<{ outcome: string }> {
      const state = (await ctx.get<DigestState>('state')) ?? emptyState();
      const target = state.target ?? params;
      if (target === undefined) return { outcome: 'skipped' };
      const ran = await ctx.run('chat-digest-now', () => runJob(services, target, state.checkpoint));
      ctx.set('state', { ...state, target, checkpoint: ran.checkpoint });
      return { outcome: ran.outcome };
    },
  },
});
