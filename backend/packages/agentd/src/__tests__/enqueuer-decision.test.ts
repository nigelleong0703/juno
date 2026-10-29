/**
 * H-78: a one-way enqueue only says the message is stored; `awaitDecision` calls Session.receive as a
 * request-response and hands back Session's own verdict (refusals such as hop_limit included).
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { WakeEvent } from '@agent-desktop/contracts';
import { RunnerEnqueuer } from '../enqueuer.js';
import { RunnerStub } from './runner-stub.js';

const wake: WakeEvent = {
  id: 'wke-1', ownerId: 'owner', agentId: 'agent-b', sessionKey: 'agent-b:room-1', conversationId: 'room-1', kind: 'room_mention',
  origin: { type: 'agent', id: 'agent-a' }, trusted: false, priority: 'peer', payload: { text: 'hi' },
  hop: { chainId: 'c', depth: 9 }, at: '2026-10-09T00:00:00.000Z', status: 'accepted',
};

const setup = (answer?: unknown) => {
  const stub = new RunnerStub();
  if (answer !== undefined) stub.answer = answer;
  return { stub, enqueuer: new RunnerEnqueuer(stub.asRunner(), createMemoryStore()) };
};

describe('RunnerEnqueuer awaitDecision', () => {
  it('returns the Session refusal from a request-response call, keeping the idempotency key', async () => {
    const { stub, enqueuer } = setup({ accepted: false, reason: 'hop_limit' });
    expect(await enqueuer.enqueue(wake, { awaitDecision: true })).toEqual({ accepted: false, reason: 'hop_limit' });
    expect(stub.calls).toEqual([{ method: 'invoke', target: { service: 'Session', key: 'agent-b:room-1', handler: 'receive', input: wake }, opts: { idempotencyKey: 'wke-1', timeoutMs: 10_000 } }]);
  });

  it('returns an acceptance verdict', async () => {
    const { enqueuer } = setup({ accepted: true });
    expect(await enqueuer.enqueue(wake, { awaitDecision: true })).toEqual({ accepted: true });
  });

  it('passes on the run Session names with its acceptance, and drops a non-string run id', async () => {
    const { enqueuer } = setup({ accepted: true, runId: 'run_42' });
    expect(await enqueuer.enqueue(wake, { awaitDecision: true })).toEqual({ accepted: true, runId: 'run_42' });
    const other = setup({ accepted: true, runId: 7 });
    expect(await other.enqueuer.enqueue(wake, { awaitDecision: true })).toEqual({ accepted: true });
  });

  it('keeps the one-way send (and its blind accepted) by default', async () => {
    const { stub, enqueuer } = setup({ accepted: false, reason: 'hop_limit' });
    expect(await enqueuer.enqueue(wake)).toEqual({ accepted: true });
    expect(stub.calls[0]).toMatchObject({ method: 'sendTo', opts: { idempotencyKey: 'wke-1' } });
  });

  it('stays one-way for a delayed delivery even when a decision was requested', async () => {
    const { stub, enqueuer } = setup();
    expect(await enqueuer.enqueue(wake, { awaitDecision: true, delayMs: 5_000 })).toEqual({ accepted: true });
    expect(stub.calls[0]).toMatchObject({ method: 'sendTo', opts: { idempotencyKey: 'wke-1', delayMs: 5_000 } });
  });

  it('reports a failure and an unreadable verdict as not accepted', async () => {
    const failing = setup();
    failing.stub.failWith = new Error('boom');
    expect((await failing.enqueuer.enqueue(wake, { awaitDecision: true })).accepted).toBe(false);
    expect(await setup({ ok: true }).enqueuer.enqueue(wake, { awaitDecision: true })).toEqual({ accepted: false, reason: 'unreadable session decision' });
  });

  it('reports a timed-out call as sent but unconfirmed, so the caller does not resend it', async () => {
    const result = await setup('timeout').enqueuer.enqueue(wake, { awaitDecision: true });
    expect(result.accepted).toBe(true);
    expect(result.reason).toContain('do not resend');
  });
});
