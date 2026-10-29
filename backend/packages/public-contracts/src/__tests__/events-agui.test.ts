import { describe, expect, it } from 'vitest';
import {
  AGUI_PROTOCOL_VERSION,
  agentEventSchema,
  EventType,
  junoProductEventSchema,
  normalizeStoredAgentEvent,
} from '../events.js';

const legacyRun = {
  id: 'run-1',
  agentId: 'agt-1',
  conversationId: 'cvn-1',
  title: 'Wake: hello',
  status: 'completed',
  kind: 'chat',
  startedAt: '2026-10-29T00:00:00.000Z',
  lastActivityAt: '2026-10-29T00:00:00.000Z',
  steps: [],
  usage: { inputTokens: 1, outputTokens: 1, computeSeconds: 0, costUsd: 0, steps: 0 },
} as const;

const legacyStep = {
  id: 'step-1',
  runId: 'run-1',
  index: 0,
  kind: 'shell',
  verb: 'Ran',
  target: 'ls',
  status: 'completed',
  startedAt: '2026-10-29T00:00:00.000Z',
  durationMs: 10,
} as const;

describe('agentEventSchema (AG-UI union)', () => {
  it('accepts the official standard event surface', () => {
    expect(AGUI_PROTOCOL_VERSION).toBe('1.0');
    expect(agentEventSchema.safeParse({ type: EventType.RUN_STARTED, threadId: 'cvn-1', runId: 'run-1' }).success).toBe(true);
    expect(agentEventSchema.safeParse({
      type: EventType.RUN_FINISHED,
      threadId: 'cvn-1',
      runId: 'run-1',
      outcome: { type: 'interrupt', interrupts: [{ id: 'req-1', reason: 'approval' }] },
    }).success).toBe(true);
    expect(agentEventSchema.safeParse({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: 'preview_a1',
      delta: 'hello',
      metadata: { juno: { generationId: 1, seq: 2, attemptId: 'a1' } },
    }).success).toBe(true);
  });

  it('keeps the retained Juno product events on the same union', () => {
    expect(junoProductEventSchema.safeParse({
      type: 'item.added',
      conversationId: 'cvn-1',
      item: {
        id: 'i1',
        type: 'user_message',
        conversationId: 'cvn-1',
        text: 'hi',
        at: '2026-10-29T00:00:00.000Z',
        authorId: 'usr-1',
        attachments: [],
        mentions: [],
      },
    }).success).toBe(true);
  });

  it('rejects the removed legacy chat wire events', () => {
    for (const removed of [
      { type: 'message.preview', generationId: 1, seq: 1, phase: 'delta', runId: 'run-1', conversationId: 'cvn-1', agentId: 'agt-1', messageId: 'm1', text: 'x' },
      { type: 'run.started', run: legacyRun },
      { type: 'run.finished', run: legacyRun },
      { type: 'step.added', runId: 'run-1', step: legacyStep },
    ]) {
      expect(agentEventSchema.safeParse(removed).success, removed.type).toBe(false);
    }
  });
});

describe('normalizeStoredAgentEvent (stored-history read migration)', () => {
  it('passes standard and product events through unchanged', () => {
    const standard = { type: EventType.RUN_STARTED, threadId: 'cvn-1', runId: 'run-1' };
    expect(normalizeStoredAgentEvent(standard)).toEqual(standard);
    const product = {
      type: 'item.added',
      conversationId: 'cvn-1',
      item: {
        id: 'i1',
        type: 'user_message',
        conversationId: 'cvn-1',
        text: 'hi',
        at: '2026-10-29T00:00:00.000Z',
        authorId: 'usr-1',
        attachments: [],
        mentions: [],
      },
    };
    expect(normalizeStoredAgentEvent(product)).toEqual(product);
  });

  it('maps legacy run events to standard run segments with juno attribution', () => {
    expect(normalizeStoredAgentEvent({ type: 'run.started', run: legacyRun })).toEqual({
      type: EventType.RUN_STARTED,
      threadId: 'cvn-1',
      runId: 'run-1',
      metadata: { juno: { agentId: 'agt-1', conversationId: 'cvn-1' } },
    });
    expect(normalizeStoredAgentEvent({ type: 'run.updated', run: legacyRun })).toEqual({
      type: EventType.CUSTOM,
      name: 'juno.run.updated',
      value: legacyRun,
      metadata: { juno: { agentId: 'agt-1', conversationId: 'cvn-1', runId: 'run-1', runStatus: 'completed' } },
    });
  });

  it('maps legacy terminal runs to the matching standard outcome', () => {
    expect(normalizeStoredAgentEvent({ type: 'run.finished', run: legacyRun })).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: 'cvn-1',
      runId: 'run-1',
      outcome: { type: 'success' },
      metadata: { juno: { agentId: 'agt-1', conversationId: 'cvn-1', runId: 'run-1', runStatus: 'completed' } },
    });
    const stopped = normalizeStoredAgentEvent({ type: 'run.finished', run: { ...legacyRun, status: 'stopped' } });
    expect(stopped).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'cancelled' } });
    const failed = normalizeStoredAgentEvent({ type: 'run.finished', run: { ...legacyRun, status: 'failed', error: 'boom' } });
    expect(failed).toMatchObject({ type: EventType.RUN_ERROR, message: 'boom' });
  });

  it('maps legacy steps and drops provisional preview frames', () => {
    expect(normalizeStoredAgentEvent({ type: 'step.added', runId: 'run-1', step: legacyStep })).toEqual({
      type: EventType.STEP_STARTED,
      stepName: 'Ran ls',
      metadata: { juno: { runId: 'run-1', stepId: 'step-1' } },
    });
    expect(normalizeStoredAgentEvent({
      type: 'step.updated',
      runId: 'run-1',
      step: { ...legacyStep, title: 'Listed files' },
    })).toEqual({
      type: EventType.STEP_FINISHED,
      stepName: 'Listed files',
      metadata: { juno: { runId: 'run-1', stepId: 'step-1' } },
    });
    expect(normalizeStoredAgentEvent({ type: 'message.preview', generationId: 1, seq: 1, phase: 'delta' })).toBeNull();
  });

  it('fails closed on unknown rows', () => {
    expect(normalizeStoredAgentEvent({ type: 'time.travel' })).toBeNull();
    expect(normalizeStoredAgentEvent(null)).toBeNull();
    expect(normalizeStoredAgentEvent('run.started')).toBeNull();
  });
});
