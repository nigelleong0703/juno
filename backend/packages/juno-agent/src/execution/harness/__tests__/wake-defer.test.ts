/**
 * H-74: a wake_at longer than the threshold ends the turn and comes back as a delayed `timer` wake to the
 * run's own session (the agent stays free meanwhile); a runtime that
 * cannot send wakes falls back to the sleep.
 */
import { describe, expect, it } from 'vitest';
import type { RestatePromise } from '@agent-desktop/durable';
import type { WakeEvent } from '../../../contracts/index.js';
import { deferLongWait } from '../engines/pi-core/time-wait.js';
import type { RunContext, RunInput } from '../services/run-types.js';

const NOW = Date.parse('2026-10-09T08:00:00.000Z');
const input: RunInput = {
  agentId: 'agent-w', conversationId: 'conv-w', sessionKey: 'agent-w:conv-w',
  wakeEvents: [{
    id: 'u-1', ownerId: 'owner-w', agentId: 'agent-w', sessionKey: 'agent-w:conv-w', conversationId: 'conv-w', kind: 'user_message',
    origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'remind me' }, at: '2026-10-09T08:00:00.000Z', status: 'accepted',
  }],
};

function ctxWith(send?: (wake: WakeEvent, delayMs?: number) => void): RunContext {
  const lift = <T>(value: T): RestatePromise<T> => Promise.resolve(value) as unknown as RestatePromise<T>;
  return {
    rand: { uuidv4: () => 'u' },
    date: { now: () => lift(NOW) },
    run: <T>(_name: string, action: () => Promise<T>) => action() as unknown as RestatePromise<T>,
    awakeable: <T>() => ({ id: 'a', promise: lift(undefined as unknown as T) }),
    drainInbox: () => lift([]),
    ...(send === undefined ? {} : { sendWake: send }),
  };
}

describe('wake_at deferral', () => {
  it('schedules a delayed timer wake to its own session for a long wait', async () => {
    const sent: Array<{ wake: WakeEvent; delayMs?: number }> = [];
    const until = new Date(NOW + 3 * 60 * 60_000).toISOString();
    const deferred = await deferLongWait(ctxWith((wake, delayMs) => sent.push({ wake, delayMs })), input, 'run-w', until, 'check the fares again', 2);
    expect(deferred).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.delayMs).toBe(3 * 60 * 60_000);
    expect(sent[0]?.wake).toMatchObject({
      id: 'run-w:wake:2', kind: 'timer', sessionKey: 'agent-w:conv-w', ownerId: 'owner-w', trusted: false, priority: 'background',
      origin: { type: 'system' }, payload: { text: 'check the fares again', until },
    });
  });

  it('falls back to the sleep when the runtime cannot send wakes', async () => {
    const until = new Date(NOW + 60 * 60_000).toISOString();
    expect(await deferLongWait(ctxWith(), input, 'run-w', until, undefined, 1)).toBe(false);
  });
});
