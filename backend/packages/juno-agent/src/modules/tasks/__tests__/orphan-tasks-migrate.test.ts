import { describe, expect, it } from 'vitest';
import type { BackgroundTask } from '../../../contracts/index.js';
import type { ComputerClient } from '../../../ports/computer/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { ORPHAN_OUTCOME, stopBackgroundTask } from '../background-registry.js';
import { migrateOrphanShellTasks } from '../orphan-tasks-migrate.js';

const AT = '2026-11-02T13:53:00.000Z';
const task = (handle: string, extra: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: 'shell-agt-' + handle, ownerId: 'owner', agentId: 'agt', conversationId: 'conv', runId: 'run-1', kind: 'shell', label: 'sleep', handle, notify: false,
  chainId: 'c', generation: 0, status: 'running', startedAt: AT, ...extra,
});
const unknown = () => new Error('process p_x is not known on this computer (it expired or never existed)');

/** A computer that knows the handles in `known` (with their state) and answers "not known" for the rest; `down` handles fail otherwise. */
function computerOf(known: Record<string, { state: string; exitCode: number | null }>, down: string[] = []): ComputerClient {
  return {
    async readProcess(_agent: string, input: { handle: string }) {
      if (down.includes(input.handle)) throw new Error('computerd unreachable');
      const seen = known[input.handle];
      if (seen === undefined) throw unknown();
      return { handle: input.handle, ...seen, output: '', stderr: '', cursor: 0, stderrCursor: 0, totalBytes: 0, stderrTotalBytes: 0, truncated: false, stderrTruncated: false };
    },
  } as unknown as ComputerClient;
}

describe('settling orphaned shell tasks at boot', () => {
  it('ends what the computer no longer has or saw finish, leaves live and unreachable ones, and runs once', async () => {
    const store = createMemoryStore();
    for (const handle of ['p_gone', 'p_done', 'p_live', 'p_down']) await store.put('backgroundTasks', task(handle));
    await store.put('backgroundTasks', task('p_old', { status: 'completed', endedAt: AT }));
    const computer = computerOf({ p_done: { state: 'exited', exitCode: 0 }, p_live: { state: 'running', exitCode: null } }, ['p_down']);

    expect(await migrateOrphanShellTasks(store, computer)).toEqual({ skipped: false, settled: 2, stillRunning: 1, unreachable: 1 });

    expect(await store.get('backgroundTasks', 'shell-agt-p_gone')).toMatchObject({ status: 'failed', outcome: ORPHAN_OUTCOME });
    expect(await store.get('backgroundTasks', 'shell-agt-p_done')).toMatchObject({ status: 'completed', outcome: 'Exited with code 0' });
    expect(await store.get('backgroundTasks', 'shell-agt-p_live')).toMatchObject({ status: 'running' });
    expect(await store.get('backgroundTasks', 'shell-agt-p_down')).toMatchObject({ status: 'running' });
    expect((await migrateOrphanShellTasks(store, computer)).skipped).toBe(true);
  });

  it('does nothing, and keeps the marker free, without a computer client', async () => {
    const store = createMemoryStore();
    await store.put('backgroundTasks', task('p_gone'));
    expect((await migrateOrphanShellTasks(store, undefined)).skipped).toBe(true);
    expect(await store.get('backgroundTasks', 'shell-agt-p_gone')).toMatchObject({ status: 'running' });
  });
});

describe('Stop on an orphaned shell task', () => {
  it('closes the row instead of failing when the computer does not know the process', async () => {
    const store = createMemoryStore();
    const row = task('p_gone');
    await store.put('backgroundTasks', row);
    const result = await stopBackgroundTask(store, row, async () => { throw unknown(); }, 'owner');
    expect(result.ok).toBe(true);
    expect(await store.get('backgroundTasks', row.id)).toMatchObject({ status: 'failed', outcome: ORPHAN_OUTCOME });
  });

  it('still reports a real stop failure', async () => {
    const store = createMemoryStore();
    const row = task('p_x');
    await store.put('backgroundTasks', row);
    await expect(stopBackgroundTask(store, row, async () => { throw new Error('computerd unreachable'); }, 'owner')).rejects.toThrow('unreachable');
    expect(await store.get('backgroundTasks', row.id)).toMatchObject({ status: 'running' });
  });
});
