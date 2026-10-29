/**
 * H-72: the TaskWatcher reads a background process once per tick, re-arms with a growing interval while
 * it runs, and reports its end to the session exactly once (exit 0 → completed, non-zero → failed);
 * a process the agent stopped itself reports nothing; read failures and the lifetime cap end it.
 */
import { describe, expect, it } from 'vitest';
import type { TaskWatchStart, WakeEvent } from '../../../contracts/index.js';
import type { ComputerClient } from '../../../ports/computer/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { WATCH_LIFETIME_MS, WATCH_MAX_READ_ERRORS, watchInterval, watchTick, type WatchState, type WatcherContext } from '../services/task-watcher.js';

const START = Date.parse('2026-10-09T09:00:00.000Z');
const input: TaskWatchStart = { taskId: 'shell-a-p1', ownerId: 'owner', agentId: 'a', conversationId: 'c', handle: 'p1', startedAt: START };

function harness(now = START + 1_000) {
  let state: WatchState | null = null;
  const rearms: number[] = [];
  const wakes: WakeEvent[] = [];
  const ctx: WatcherContext = {
    key: input.taskId,
    store: createMemoryStore(),
    dateNow: async () => now,
    run: (_n, fn) => fn(),
    getState: async () => state,
    setState: (next) => { state = next; },
    rearm: (_i, delayMs) => { rearms.push(delayMs); },
    sendWake: (wake) => { wakes.push(wake); },
  };
  return { ctx, rearms, wakes, state: () => state };
}

function computerReading(sequence: Array<{ state: string; exitCode: number | null; output?: string } | Error>): ComputerClient {
  let i = 0;
  const client: Partial<ComputerClient> = {
    readProcess: async (_agentId, _readInput) => {
      const next = sequence[Math.min(i, sequence.length - 1)];
      i += 1;
      if (next instanceof Error) throw next;
      return { handle: 'p1', state: next?.state as never, exitCode: next?.exitCode ?? null, output: next?.output ?? '', stderr: '', cursor: 0, stderrCursor: 0, totalBytes: 0, stderrTotalBytes: 0, truncated: false, stderrTruncated: false };
    },
  };
  return client as ComputerClient;
}

describe('task watcher', () => {
  it('re-arms with a doubling interval while the process runs', async () => {
    const h = harness();
    const computer = computerReading([{ state: 'running', exitCode: null }]);
    await watchTick(h.ctx, computer, input);
    await watchTick(h.ctx, computer, input);
    await watchTick(h.ctx, computer, input);
    expect(h.rearms).toEqual([watchInterval(0), watchInterval(1), watchInterval(2)]);
    expect(watchInterval(0)).toBe(5_000);
    expect(watchInterval(20)).toBe(5 * 60_000);
    expect(h.wakes).toEqual([]);
  });

  it('reports a clean exit once as completed, with the exit code and output start', async () => {
    const h = harness();
    const computer = computerReading([{ state: 'exited', exitCode: 0, output: 'build ok' }]);
    await watchTick(h.ctx, computer, input);
    await watchTick(h.ctx, computer, input);
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]).toMatchObject({ id: 'shell-a-p1:done', kind: 'task_done', sessionKey: 'a:c', payload: { taskKind: 'shell', status: 'completed' } });
    expect(String(h.wakes[0]?.payload['summary'])).toContain('exit code 0');
    expect(String(h.wakes[0]?.payload['summary'])).toContain('build ok');
  });

  it('reports a non-zero exit as failed', async () => {
    const h = harness();
    await watchTick(h.ctx, computerReading([{ state: 'exited', exitCode: 2 }]), input);
    expect(h.wakes[0]?.payload['status']).toBe('failed');
  });

  it('reports nothing for a process the agent stopped itself', async () => {
    const h = harness();
    await watchTick(h.ctx, computerReading([{ state: 'stopped', exitCode: 143 }]), input);
    expect(h.wakes).toEqual([]);
    expect(h.state()?.done).toBe(true);
  });

  it('ends as failed after repeated read errors', async () => {
    const h = harness();
    const computer = computerReading([new Error('sandbox gone')]);
    for (let i = 0; i < WATCH_MAX_READ_ERRORS; i += 1) await watchTick(h.ctx, computer, input);
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]?.payload['status']).toBe('failed');
    expect(String(h.wakes[0]?.payload['summary'])).toContain('sandbox gone');
  });

  it('ends as timeout once the lifetime is exceeded', async () => {
    const h = harness(START + WATCH_LIFETIME_MS + 1);
    await watchTick(h.ctx, computerReading([{ state: 'running', exitCode: null }]), input);
    expect(h.wakes[0]?.payload['status']).toBe('timeout');
  });

  it('ignores a tick addressed to another key', async () => {
    const h = harness();
    await watchTick(h.ctx, computerReading([{ state: 'exited', exitCode: 0 }]), { ...input, taskId: 'other' });
    expect(h.wakes).toEqual([]);
  });
});
