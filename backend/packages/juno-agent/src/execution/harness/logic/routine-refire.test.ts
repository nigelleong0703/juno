import { describe, expect, it } from 'vitest';
import type { WakeEvent } from '../../../contracts/index.js';
import { planRefire, providerOutageOf, refireStateOf, refireWake, REFIRE_MAX } from './routine-refire.js';

const FIRST = '2026-11-01T08:00:00.000Z';
const at = (minutes: number): number => Date.parse(FIRST) + minutes * 60_000;

describe('when an occurrence is tried again after a provider outage', () => {
  it('waits the longer of the announced wait and five minutes', () => {
    expect(planRefire({ previous: undefined, startedAt: FIRST, now: at(1), retryAfterMs: 600_000 })?.delayMs).toBe(600_000);
    expect(planRefire({ previous: undefined, startedAt: FIRST, now: at(1), retryAfterMs: 40_000 })?.delayMs).toBe(300_000);
    expect(planRefire({ previous: undefined, startedAt: FIRST, now: at(1), retryAfterMs: undefined })?.delayMs).toBe(300_000);
  });

  it('allows three re-fires, the first attempt time carried along, and then counts the failure', () => {
    let state = planRefire({ previous: undefined, startedAt: FIRST, now: at(1), retryAfterMs: undefined })?.next;
    expect(state).toEqual({ attempt: 1, firstAttemptAt: FIRST });
    state = planRefire({ previous: state, startedAt: new Date(at(6)).toISOString(), now: at(7), retryAfterMs: undefined })?.next;
    state = planRefire({ previous: state, startedAt: new Date(at(12)).toISOString(), now: at(13), retryAfterMs: undefined })?.next;
    expect(state).toEqual({ attempt: REFIRE_MAX, firstAttemptAt: FIRST });
    expect(planRefire({ previous: state, startedAt: new Date(at(18)).toISOString(), now: at(19), retryAfterMs: undefined })).toBeUndefined();
  });

  it('never schedules later than two hours after the first attempt', () => {
    expect(planRefire({ previous: undefined, startedAt: FIRST, now: at(100), retryAfterMs: 900_000 })).toBeDefined();
    expect(planRefire({ previous: undefined, startedAt: FIRST, now: at(100), retryAfterMs: 1_800_000 })).toBeUndefined();
    expect(planRefire({ previous: { attempt: 1, firstAttemptAt: FIRST }, startedAt: new Date(at(118)).toISOString(), now: at(118), retryAfterMs: undefined })).toBeUndefined();
  });

  it('sends the same occurrence under a new id with the state on the payload, and reads the state back', () => {
    const wake = { id: 'wake_routine_rtn-1:2026-11-01T08:00:00Z', payload: { routineId: 'rtn-1', text: 'Post the news', occurrenceAt: FIRST }, at: FIRST, status: 'consumed' } as unknown as WakeEvent;
    const first = refireWake(wake, { attempt: 1, firstAttemptAt: FIRST });
    expect(first).toMatchObject({ id: 'wake_routine_rtn-1:2026-11-01T08:00:00Z_r1', at: FIRST, status: 'accepted', payload: { occurrenceAt: FIRST, retry: { attempt: 1, firstAttemptAt: FIRST } } });
    expect(refireStateOf(first)).toEqual({ attempt: 1, firstAttemptAt: FIRST });
    const second = refireWake(first, { attempt: 2, firstAttemptAt: FIRST });
    expect(second.id).toBe('wake_routine_rtn-1:2026-11-01T08:00:00Z_r2');
    expect((second.payload['text'] as string).match(/This is a retry/g)).toHaveLength(1);
  });

  it('only a rate limit or exhausted transient errors are an outage', () => {
    expect(providerOutageOf({ metadata: { code: 'quota', retryAfterMs: '600000' } })).toEqual({ retryAfterMs: 600_000 });
    expect(providerOutageOf({ metadata: { code: 'transient' } })).toEqual({});
    for (const code of ['auth', 'invalid_request', 'context_overflow', 'no_reply', 'refused']) expect(providerOutageOf({ metadata: { code } })).toBeUndefined();
    expect(providerOutageOf({ metadata: {} })).toBeUndefined();
  });
});
