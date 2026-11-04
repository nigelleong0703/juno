import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputerClient } from '../../../ports/computer/index.js';
import { createComputerHolds, HOLD_RENEW_MS, HOLD_TTL_MS, PARKED_RELEASE_MS } from '../services/computer-holds.js';

/** A computer client that only records its holds: `live` is what computerd would be holding right now. */
function recordingComputer() {
  const live = new Set<string>();
  const calls: string[] = [];
  const computer = {
    hold: async (_agentId: string, holdId: string, ttlMs: number) => {
      expect(ttlMs).toBe(HOLD_TTL_MS);
      calls.push('hold');
      live.add(holdId);
    },
    release: async (_agentId: string, holdId: string) => {
      calls.push('release');
      live.delete(holdId);
    },
  } as unknown as ComputerClient;
  return { computer, live, calls };
}

describe('run holds on the computer', () => {
  afterEach(() => vi.useRealTimers());

  it('holds while the run lives, renews, and releases when it ends', async () => {
    vi.useFakeTimers();
    const { computer, live, calls } = recordingComputer();
    const holds = createComputerHolds(computer);
    holds?.begin('agent-1', 'run-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(live.size).toBe(1);

    await vi.advanceTimersByTimeAsync(3 * HOLD_RENEW_MS);
    expect(calls.filter((call) => call === 'hold')).toHaveLength(4);

    holds?.end('run-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(live.size).toBe(0);
    const settled = calls.length;
    await vi.advanceTimersByTimeAsync(3 * HOLD_RENEW_MS);
    expect(calls).toHaveLength(settled);
  });

  it('keeps one hold per run: two runs hold separately, and a run beginning again does not leave the first one behind', async () => {
    vi.useFakeTimers();
    const { computer, live } = recordingComputer();
    const holds = createComputerHolds(computer);
    holds?.begin('agent-1', 'run-1');
    holds?.begin('agent-2', 'run-2');
    await vi.advanceTimersByTimeAsync(0);
    expect(live.size).toBe(2);

    holds?.begin('agent-1', 'run-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(live.size).toBe(2);

    holds?.end('run-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(live.size).toBe(1);
    holds?.end('run-2');
    await vi.advanceTimersByTimeAsync(0);
    expect(live.size).toBe(0);
  });

  it('lets go after 10 minutes of waiting on the person, and holds again when the answer comes', async () => {
    vi.useFakeTimers();
    const { computer, live } = recordingComputer();
    const holds = createComputerHolds(computer);
    holds?.begin('agent-1', 'run-1');
    const answered = holds?.parked('run-1');
    await vi.advanceTimersByTimeAsync(PARKED_RELEASE_MS - 1_000);
    expect(live.size).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(live.size).toBe(0);

    answered?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(live.size).toBe(1);

    holds?.end('run-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(live.size).toBe(0);
  });

  it('an answer inside the 10 minutes keeps the hold and never schedules its release', async () => {
    vi.useFakeTimers();
    const { computer, live, calls } = recordingComputer();
    const holds = createComputerHolds(computer);
    holds?.begin('agent-1', 'run-1');
    holds?.parked('run-1')();
    await vi.advanceTimersByTimeAsync(2 * PARKED_RELEASE_MS);
    expect(live.size).toBe(1);
    expect(calls).not.toContain('release');
    holds?.end('run-1');
  });

  it('a failed call never throws into the run and the next renewal tries again', async () => {
    vi.useFakeTimers();
    let up = false;
    const live = new Set<string>();
    const computer = {
      hold: async (_agentId: string, holdId: string) => {
        if (!up) throw new Error('computerd is down');
        live.add(holdId);
      },
      release: async (_agentId: string, holdId: string) => {
        live.delete(holdId);
      },
    } as unknown as ComputerClient;
    const logged: string[] = [];
    const holds = createComputerHolds(computer, (_fields, message) => logged.push(message));
    holds?.begin('agent-1', 'run-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(live.size).toBe(0);
    expect(logged).toEqual(['computer hold call failed']);

    up = true;
    await vi.advanceTimersByTimeAsync(HOLD_RENEW_MS);
    expect(live.size).toBe(1);
    holds?.end('run-1');
  });

  it('is absent when the client cannot hold', () => {
    expect(createComputerHolds(undefined)).toBeUndefined();
    expect(createComputerHolds({} as ComputerClient)).toBeUndefined();
  });
});
