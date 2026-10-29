import { describe, it, expect } from 'vitest';
import { resolveBusyMode, sortInbox, selectNextBatch, takeSteerEvents } from './busy.js';
import type { QueuedEvent } from './busy.js';
import type { WakeEvent } from '../../../contracts/index.js';

describe('busy mode logic', () => {
  it('resolves busy mode from event or defaults', () => {
    expect(resolveBusyMode({ kind: 'user_message', mode: undefined })).toBe('steer');
    expect(resolveBusyMode({ kind: 'room_mention', mode: undefined })).toBe('collect');
    expect(resolveBusyMode({ kind: 'routine', mode: undefined })).toBe('followup');
    expect(resolveBusyMode({ kind: 'user_message', mode: 'collect' })).toBe('collect');
  });

  it('sorts inbox by priority and sequence', () => {
    const createEvent = (id: string, priority: string): WakeEvent => ({
      id,
      ownerId: 'test-owner',
      agentId: 'test-agent',
      sessionKey: 'test-session',
      conversationId: 'test-conv',
      kind: 'user_message' as const,
      priority: priority as 'user' | 'peer' | 'background',
      trusted: true,
      status: 'accepted' as const,
      at: new Date().toISOString(),
      origin: { type: 'user' as const, id: 'test' },
      payload: {},
    });

    const inbox: QueuedEvent[] = [
      {
        event: createEvent('1', 'background'),
        mode: 'steer',
        seq: 0,
        urgent: false,
      },
      {
        event: createEvent('2', 'user'),
        mode: 'steer',
        seq: 1,
        urgent: false,
      },
      {
        event: createEvent('3', 'peer'),
        mode: 'steer',
        seq: 2,
        urgent: false,
      },
    ];

    const sorted = sortInbox(inbox);
    expect(sorted[0]!.event.id).toBe('2');
    expect(sorted[1]!.event.id).toBe('3');
    expect(sorted[2]!.event.id).toBe('1');
  });

  it('selects next batch and respects collect mode', () => {
    const createEvent = (id: string): WakeEvent => ({
      id,
      ownerId: 'test-owner',
      agentId: 'test-agent',
      sessionKey: 'test-session',
      conversationId: 'test-conv',
      kind: 'user_message' as const,
      priority: 'user',
      trusted: true,
      status: 'accepted' as const,
      at: new Date().toISOString(),
      origin: { type: 'user' as const, id: 'test' },
      payload: {},
    });

    const inbox: QueuedEvent[] = [
      {
        event: createEvent('1'),
        mode: 'collect',
        seq: 0,
        urgent: false,
      },
      {
        event: createEvent('2'),
        mode: 'collect',
        seq: 1,
        urgent: false,
      },
      {
        event: createEvent('3'),
        mode: 'steer',
        seq: 2,
        urgent: false,
      },
    ];

    const { batch, rest } = selectNextBatch(inbox, 20);
    expect(batch.length).toBe(2);
    expect(rest.length).toBe(1);
  });

  it('takes steer events from inbox', () => {
    const createEvent = (id: string): WakeEvent => ({
      id,
      ownerId: 'test-owner',
      agentId: 'test-agent',
      sessionKey: 'test-session',
      conversationId: 'test-conv',
      kind: 'user_message' as const,
      priority: 'user',
      trusted: true,
      status: 'accepted' as const,
      at: new Date().toISOString(),
      origin: { type: 'user' as const, id: 'test' },
      payload: {},
    });

    const inbox: QueuedEvent[] = [
      { event: createEvent('1'), mode: 'steer', seq: 0, urgent: false },
      { event: createEvent('2'), mode: 'collect', seq: 1, urgent: false },
      { event: createEvent('3'), mode: 'steer', seq: 2, urgent: false },
    ];

    const { steer, rest } = takeSteerEvents(inbox);
    expect(steer.length).toBe(2);
    expect(rest.length).toBe(1);
    expect(rest[0]!.event.id).toBe('2');
  });
});
