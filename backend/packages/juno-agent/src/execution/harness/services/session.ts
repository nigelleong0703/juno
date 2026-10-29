/**
 * Session Virtual Object: inbox management, busy modes, run lifecycle.
 */

import { handlers as restateHandlers, object, type ObjectContext, type ObjectSharedContext, rpc } from '@agent-desktop/durable';
import { patchWhen, type WakeEvent } from '../../../contracts/index.js';
import { sessionDef, runDef, chatDigestDef, type SessionDef, type RunDef, type ChatDigestDef } from './definitions.js';
import { inOwnerScope, resolveAdmittedOwner } from '../../execution-owner.js';
import { replyOriginOf } from '../../../modules/channel-origin.js';
import { takeSteerEvents } from '../logic/busy.js';
import { defaultState, type Services, type SessionIo, type SessionState, type TypingState } from './session-state.js';
import { childCompletionRoute } from './completion-wake.js';
import { INTERRUPTED_BY_MESSAGE } from './run-input.js';
import { drainInboxEvents, flushInboxEvent, idleCompactEvent, receiveEvent, runFinishedEvent, type ReceiveDecision } from './session-events.js';

export type { SessionIo, SessionState, TypingState } from './session-state.js';
export type { ReceiveDecision } from './session-events.js';
export { drainInboxEvents, flushInboxEvent, idleCompactEvent, receiveEvent, runFinishedEvent } from './session-events.js';

export const createSessionService = (services: Services) => {
  const ioFrom = (ctx: ObjectContext): SessionIo => ({
    key: ctx.key,
    readState: () => ctx.get<SessionState>('state'),
    writeState: state => ctx.set('state', state),
    now: () => ctx.date.now(),
    newRunId: () => `run_${ctx.rand.uuidv4()}`,
    deliver: (event, delayMs) => {
      ctx.objectSendClient<SessionDef>(sessionDef, event.sessionKey).receive(event, rpc.sendOpts({ delay: delayMs }));
    },
    scheduleFlush: (token, delayMs) => {
      ctx.objectSendClient<SessionDef>(sessionDef, ctx.key).flush(token, rpc.sendOpts({ delay: delayMs }));
    },
    scheduleIdleCompact: (token, delayMs) => {
      ctx.objectSendClient<SessionDef>(sessionDef, ctx.key).idleCompact(token, rpc.sendOpts({ delay: delayMs }));
    },
    startRun: (runId, input) => {
      ctx.workflowSendClient<RunDef>(runDef, runId).run(input);
    },
    cancelRun: runId => {
      ctx.workflowSendClient<RunDef>(runDef, runId).cancel();
    },
  });

  const awakeableOf = (request: object): string | undefined => {
    const awakeableId = Reflect.get(request, 'awakeableId');
    return typeof awakeableId === 'string' && awakeableId !== '' ? awakeableId : undefined;
  };

  /**
   * Resolve the awakeable of every still-pending request the active run waits on, with the interrupt marker (journaled; the request
   * is not decided). A request the run has raised but not yet suspended on has no awakeable to resolve (`request.created` reaches the
   * client a moment before the run installs it), so the message is recorded on the request instead and the run ends its wait the
   * moment it installs the awakeable (run-input.ts). Both sides change the request under its row lock, so exactly one of them sees
   * the other: either the awakeable is there when this looks, or the flag is there when the run looks.
   */
  const interruptWait = async (ctx: ObjectContext, io: SessionIo): Promise<void> => {
    const runId = (await io.readState())?.activeRunId;
    if (!runId) return;
    const waiting = await ctx.run('waiting-requests', async () => {
      const page = await services.store.list('requests', { where: { runId, status: 'pending' }, limit: 20 });
      const awakeables: string[] = [];
      for (const request of page.items) {
        const known = awakeableOf(request);
        if (known !== undefined) { awakeables.push(known); continue; }
        if (Reflect.get(request, 'interrupted') === true) continue;
        const flagged = await patchWhen(services.store, 'requests', request.id, (current) => awakeableOf(current) === undefined, { interruptRequested: true });
        if (flagged !== undefined) continue;
        // The run installed its awakeable between the list and the lock.
        const installed = await services.store.get('requests', request.id);
        const late = installed === null ? undefined : awakeableOf(installed);
        if (late !== undefined) awakeables.push(late);
      }
      return awakeables;
    });
    for (const awakeableId of waiting) ctx.resolveAwakeable(awakeableId, INTERRUPTED_BY_MESSAGE);
  };

  const handlers = {
    async receive(ctx: ObjectContext, event: WakeEvent): Promise<ReceiveDecision> {
      // The wake's owner is the only authority: validate it against the stored agent, then re-enter
      // that scope so the guard reads and the run's writes/events all resolve to that owner.
      const io = ioFrom(ctx);
      const admitted = await resolveAdmittedOwner(services.store, [event], {
        agentId: event.agentId,
        conversationId: event.conversationId,
        sessionKey: io.key,
      });
      const ownerId = admitted.ownerId;
      if (ownerId === undefined) return { accepted: false, reason: admitted.reason ?? 'missing_owner' };
      return inOwnerScope(ownerId, async () => {
        // Only a task_done can be re-routed, so other events add no journal step; a session never re-sends to itself.
        const routed = event.kind === 'task_done' ? await ctx.run('route-completion', () => childCompletionRoute(services.store, event)) : null;
        if (routed !== null && routed.sessionKey !== io.key) {
          ctx.objectSendClient<SessionDef>(sessionDef, routed.sessionKey).receive(routed.wake);
          return { accepted: true, reason: 'routed_to_child' };
        }
        const received = await receiveEvent(io, services, event);
        // A person in this chat wrote to the agent (the owner, or anyone in a group whose message reaches the session): the chat digest (memory, goals, group note)
        // starts once the chat has gone quiet, and reads what is new. Another agent's post arrives with origin `agent` and never touches it;
        // this reply never waits for it.
        if (received.accepted && event.origin.type === 'user' && (event.kind === 'user_message' || event.kind === 'room_mention')) {
          const origin = replyOriginOf([event]);
          ctx.objectSendClient<ChatDigestDef>(chatDigestDef, event.conversationId).touch({ ownerId, agentId: event.agentId, conversationId: event.conversationId, ...(origin === undefined ? {} : { origin }) });
        }
        // A typed message while the active run waits on a blocking request ends that wait WITHOUT deciding the request.
        if (received.accepted && event.kind === 'user_message' && event.origin.type === 'user') await interruptWait(ctx, io);
        return received;
      });
    },

    async drainInbox(ctx: ObjectContext): Promise<WakeEvent[]> {
      return drainInboxEvents(ioFrom(ctx));
    },

    async flush(ctx: ObjectContext, token: string): Promise<void> {
      return flushInboxEvent(ioFrom(ctx), token);
    },

    async runFinished(ctx: ObjectContext, runId: string): Promise<void> {
      return runFinishedEvent(ioFrom(ctx), runId);
    },

    /** Read-only (shared, so it never queues behind a write): what a run holding its final reply needs to know. */
    typingState: restateHandlers.object.shared(async (ctx: ObjectSharedContext): Promise<TypingState> => {
      const state = (await ctx.get<SessionState>('state')) ?? defaultState();
      return { typingUntil: state.typingUntil ?? null, steerQueued: takeSteerEvents(state.inbox).steer.length };
    }),

    // Exclusive: the runner's shared handlers have no journal and ignore the send delay, and holding the key's queue also keeps a new run from starting mid-summary.
    async idleCompact(ctx: ObjectContext, token: string): Promise<void> {
      return idleCompactEvent({ key: ctx.key, readState: () => ctx.get<SessionState>('state') }, services, token, compact => ctx.run('idle-compact', compact));
    },

    /** Operators and the e2e suite: compact now instead of waiting an hour (the armed token must still be current). */
    async runNow(ctx: ObjectContext): Promise<{ outcome: string }> {
      const token = (await ctx.get<SessionState>('state'))?.idleCompactToken;
      if (token === undefined) return { outcome: 'no idle compaction armed' };
      await idleCompactEvent({ key: ctx.key, readState: () => ctx.get<SessionState>('state') }, services, token, compact => ctx.run('idle-compact', compact));
      return { outcome: 'done' };
    },

    async getState(ctx: ObjectContext): Promise<SessionState> {
      return (await ctx.get<SessionState>('state')) ?? defaultState();
    },
  };
  return object({
    name: 'Session',
    handlers,
  });
};
