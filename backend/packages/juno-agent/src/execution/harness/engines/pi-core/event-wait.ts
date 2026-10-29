import { TerminalError } from '@agent-desktop/durable';
import type { UserMessage } from '@earendil-works/pi-ai';
import type { Store } from '../../../../contracts/index.js';
import { appendToTranscript, readTranscript, wakeMessage } from '../../../brain/index.js';
import { CANCELLED } from '../../services/cancel.js';
import { drainAndAppend } from '../../services/run-input.js';
import { receiptFor } from '../../services/event-receipts.js';
import { docOwner } from '../../../execution-owner.js';
import type { SuspensionDeps } from './suspend.js';

/** Poll durable subscription state; each observation and sleep is replayed by Restate. */
export async function waitForEvent(deps: SuspensionDeps): Promise<'resume' | 'stopped'> {
  const { ctx, services, input, runId, stepIndex, suspend, cancellation } = deps;
  const id = suspend.awakeableId;
  if (id === undefined) throw new TerminalError('Event wait requires a subscription');
  const key = 'event-wait:' + String(stepIndex);
  // The text is read from the version the session is pinned to (BACKEND §11.2), like its context.
  const eventText = async (reader: Store, event: Record<string, unknown>): Promise<string> => {
    const wake = (): UserMessage => wakeMessage({
      id: key, ownerId: '', agentId: input.agentId, conversationId: input.conversationId,
      sessionKey: input.sessionKey, kind: 'connector_event', origin: { type: 'automation' },
      trusted: false, priority: 'background', payload: { text: JSON.stringify(event) }, at: new Date().toISOString(), status: 'consumed',
    });
    const brain = services.brain;
    const message = brain.withSessionHarness === undefined ? wake() : await brain.withSessionHarness(await readTranscript(reader, input.sessionKey), wake);
    return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  };
  const finish = (outcome: string, rowKey = ctx.rand.uuidv4()) => ctx.run(key + ':finish', () => services.store.tx(async tx => {
    // The row is locked first: a webhook delivery serializes against this finish, so an event
    // that lands after the last poll but before the timeout boundary was observed is consumed
    // here, never lost to a concurrent delete.
    const locked = tx.getForUpdate;
    if (locked === undefined) {
      throw new TerminalError('Event wait requires a row-locking store');
    }
    const final = await locked('subscriptions', id);
    if (final !== null && (final.runId !== runId || final.agentId !== input.agentId || final.conversationId !== input.conversationId)) {
      throw new TerminalError('Event wait subscription does not belong to this Run');
    }
    const content = outcome === 'cancelled' || outcome === 'steered' ? outcome
      : final?.event === undefined ? outcome : await eventText(tx, final.event);
    await tx.delete('subscriptions', id);
    // A consumed event leaves a durable receipt in the same transaction: a webhook retry
    // arriving after this delete is acknowledged as a duplicate instead of waking a new Run.
    // Timeout, cancellation and steering consume nothing, so they leave no receipt and a
    // later event still wakes normally.
    const consumed = final?.event;
    if (outcome !== 'cancelled' && outcome !== 'steered' && consumed !== undefined) {
      const source = typeof consumed['source'] === 'string' ? consumed['source'] : 'webhook';
      const eventId = typeof consumed['id'] === 'string' ? consumed['id'] : undefined;
      const receiptOwner = (final === null ? undefined : docOwner(final)) ?? input.wakeEvents[0]?.ownerId;
      if (eventId !== undefined && receiptOwner !== undefined) {
        await tx.put('eventReceipts', receiptFor(
          { ownerId: receiptOwner, agentId: input.agentId, conversationId: input.conversationId },
          runId,
          { ...consumed, id: eventId, source, type: typeof consumed['type'] === 'string' ? consumed['type'] : 'webhook' },
          new Date().toISOString(),
        ));
      }
    }
    if (outcome !== 'cancelled' && outcome !== 'steered') {
      await appendToTranscript(tx, input.sessionKey, [{ role: 'user', content, timestamp: Date.now() }], rowKey);
    }
  }));
  for (let poll = 0; ; poll += 1) {
    if (await cancellation.peek()) { await finish('cancelled'); return 'stopped'; }
    const sub = await ctx.run(key + ':read:' + String(poll), () => services.store.get('subscriptions', id));
    if (sub === null || sub.agentId !== input.agentId || sub.conversationId !== input.conversationId || sub.runId !== runId) {
      throw new TerminalError('Event wait subscription does not belong to this Run');
    }
    if (sub.event !== undefined) {
      await finish(await eventText(services.store, sub.event));
      return 'resume';
    }
    const deadline = Date.parse(sub.expiresAt);
    if (!Number.isFinite(deadline)) throw new TerminalError('Event wait deadline malformed');
    const now = ctx.date === undefined
      ? await ctx.run(key + ':clock:' + String(poll), async () => Date.now()) : await ctx.date.now();
    if (now >= deadline) { await finish('[internal event wait] timed out without a matching event.'); return 'resume'; }
    const drained = await drainAndAppend(ctx, services, input, cancellation, key + ':steer:' + String(poll));
    if (drained === CANCELLED) { await finish('cancelled'); return 'stopped'; }
    if (drained) { await finish('steered'); return 'resume'; }
    const sleep = ctx.sleep;
    if (sleep === undefined) throw new TerminalError('Event wait requires a durable timer');
    if (await cancellation.race(() => sleep(Math.min(1000, deadline - now))) === CANCELLED) {
      await finish('cancelled');
      return 'stopped';
    }
  }
}
