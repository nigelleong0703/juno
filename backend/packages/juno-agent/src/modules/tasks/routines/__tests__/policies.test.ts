import { describe, expect, it } from 'vitest';
import {
  appendHistory,
  applyCompletion,
  applyRead,
  emptyPolicyState,
  FAIL_PAUSE_AFTER,
  UNREAD_PAUSE_AFTER,
} from '../policies.js';

describe('routine completion policy', () => {
  it('counts every generated output as unread; five pause', () => {
    let state = emptyPolicyState();
    for (let i = 0; i < UNREAD_PAUSE_AFTER - 1; i += 1) {
      const decision = applyCompletion(state, { succeeded: true, itemsGenerated: 1, at: '2026-10-09T00:0' + String(i) + ':00.000Z' });
      expect(decision.paused).toBe(false);
      state = { ...state, unreadStreak: decision.unreadStreak, failStreak: decision.failStreak, ...(decision.lastResultAt === undefined ? {} : { lastResultAt: decision.lastResultAt }) };
    }
    const last = applyCompletion(state, { succeeded: true, itemsGenerated: 1, at: '2026-10-09T00:05:00.000Z' });
    expect(last.unreadStreak).toBe(UNREAD_PAUSE_AFTER);
    expect(last.paused).toEqual({ reason: 'unread' });
  });

  it('a multi-output run adds each item; a silent success changes nothing', () => {
    const multi = applyCompletion(emptyPolicyState(), { succeeded: true, itemsGenerated: 3, at: '2026-10-09T00:00:00.000Z' });
    expect(multi.unreadStreak).toBe(3);
    expect(multi.paused).toBe(false);
    const silent = applyCompletion({ ...emptyPolicyState(), unreadStreak: 4 }, { succeeded: true, itemsGenerated: 0, at: '2026-10-09T00:01:00.000Z' });
    expect(silent.unreadStreak).toBe(4);
    expect(silent.failStreak).toBe(0);
    expect(silent.paused).toBe(false);
  });

  it('failures move only the failure streak and pause at five', () => {
    let state = emptyPolicyState();
    for (let i = 0; i < FAIL_PAUSE_AFTER - 1; i += 1) {
      const decision = applyCompletion(state, { succeeded: false, itemsGenerated: 0, at: '2026-10-09T00:00:00.000Z' });
      expect(decision.paused).toBe(false);
      expect(decision.unreadStreak).toBe(0);
      state = { ...state, failStreak: decision.failStreak };
    }
    expect(applyCompletion(state, { succeeded: false, itemsGenerated: 0, at: '2026-10-09T00:00:00.000Z' }).paused).toEqual({ reason: 'failed' });
    expect(applyCompletion({ ...emptyPolicyState(), failStreak: 4 }, { succeeded: true, itemsGenerated: 0, at: '2026-10-09T00:00:00.000Z' }).failStreak).toBe(0);
  });

  it('clamps malformed item counts instead of poisoning the streak', () => {
    expect(applyCompletion(emptyPolicyState(), { succeeded: true, itemsGenerated: -3, at: '2026-10-09T00:00:00.000Z' }).unreadStreak).toBe(0);
    expect(applyCompletion(emptyPolicyState(), { succeeded: true, itemsGenerated: 1.9, at: '2026-10-09T00:00:00.000Z' }).unreadStreak).toBe(1);
  });
});

describe('routine read policy', () => {
  it('a read at/after the newest result clears; an early read keeps newer results', () => {
    const state = { unreadStreak: 2, failStreak: 0, lastResultAt: '2026-10-09T00:05:00.000Z' };
    expect(applyRead(state, { readCutoff: '2026-10-09T00:06:00.000Z' })).toEqual({ unreadStreak: 0, lastReadCutoff: '2026-10-09T00:06:00.000Z', cleared: true });
    expect(applyRead(state, { readCutoff: '2026-10-09T00:05:00.000Z' }).cleared).toBe(true);
    const kept = applyRead(state, { readCutoff: '2026-10-09T00:04:00.000Z' });
    expect(kept.unreadStreak).toBe(2);
    expect(kept.cleared).toBe(false);
    expect(kept.lastReadCutoff).toBe('2026-10-09T00:04:00.000Z');
  });

  it('a late or duplicate read never rewinds the watermark', () => {
    const state = { unreadStreak: 0, failStreak: 0, lastResultAt: '2026-10-09T00:05:00.000Z', lastReadCutoff: '2026-10-09T00:06:00.000Z' };
    expect(applyRead(state, { readCutoff: '2026-10-09T00:05:30.000Z' })).toEqual({ unreadStreak: 0, lastReadCutoff: '2026-10-09T00:06:00.000Z', cleared: false });
  });

  it('a read with no results yet clears trivially', () => {
    expect(applyRead(emptyPolicyState(), { readCutoff: '2026-10-09T00:00:00.000Z' }).cleared).toBe(true);
  });
});

describe('routine history bound', () => {
  it('keeps the newest twenty runs', () => {
    const runs = Array.from({ length: 25 }, (_, i) => 'run-' + String(i));
    const kept = appendHistory(runs, 'run-25');
    expect(kept).toHaveLength(20);
    expect(kept[0]).toBe('run-6');
    expect(kept[19]).toBe('run-25');
  });
});
